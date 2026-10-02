/**
 * `browser_command {login: "<site>"}` — the daemon signs the computer's own
 * browser in with a password the person saved in Uno Work (the credentials
 * vault), and the model only learns the outcome: signed in / not signed in /
 * the person was asked to help.
 *
 * The password never reaches the model or a log: it goes from the vault
 * straight into the page through the server-only `fillCredential` command
 * (the same one the person's "Fill" button uses), is registered with the
 * output redaction as a known secret, and password fields are cleared again
 * when the attempt did not get through. With no saved password, a 2FA code
 * or a captcha, the person is asked (`requestHelp`: Inbox + Telegram/Slack)
 * and the browser waits for them.
 *
 * Detecting "signed in" is a heuristic over the page: no visible password or
 * one-time-code field after the attempt. The result says what was seen.
 *
 * @module assistants/browserLogin
 */
import type {
  BrowserAutomationCommandInput,
  BrowserAutomationCommandResult,
  CredentialMetadata,
} from "@t3tools/contracts";
import { Effect } from "effect";

export type BrowserLoginStatus = "signed_in" | "not_signed_in" | "needs_help";

export interface BrowserLoginResult {
  readonly ok: boolean;
  readonly status: BrowserLoginStatus;
  readonly site: string;
  /** Where the browser ended up (origin + path; no query, it may hold tokens). */
  readonly page: string | null;
  /** Whether a saved password was used (never the password or login itself). */
  readonly usedSavedPassword: boolean;
  readonly detail: string;
}

export interface LoginPageProbe {
  readonly url: string | null;
  readonly password: boolean;
  readonly username: boolean;
  readonly otp: boolean;
  readonly captcha: boolean;
}

export interface BrowserLoginDeps {
  readonly listCredentials: Effect.Effect<ReadonlyArray<CredentialMetadata>>;
  readonly revealPassword: (id: CredentialMetadata["id"]) => Effect.Effect<string | null>;
  /** One command in this chat's page of the computer's own browser. */
  readonly exec: (
    input: BrowserAutomationCommandInput,
  ) => Effect.Effect<BrowserAutomationCommandResult>;
  /** Hand the browser to the person (Inbox + messenger) and wait for them. */
  readonly askHuman: (text: string) => Effect.Effect<BrowserAutomationCommandResult>;
  /** Marks the password for output redaction. */
  readonly registerSecret: (value: string) => void;
  readonly sleep: (ms: number) => Effect.Effect<void>;
}

const SUBMIT_SETTLE_MS = 4_000;
const MAX_FILL_ROUNDS = 2;
const HELP_TIMEOUT_MS = 600_000;

/** `https://www.Example.com/login` / `example.com` → `example.com`. */
export function normalizeSite(raw: string): string {
  let value = raw.trim().toLowerCase();
  try {
    value = new URL(value.includes("://") ? value : `https://${value}`).hostname;
  } catch {
    value = value.split("/")[0] ?? value;
  }
  return value.replace(/^www\./, "").replace(/\.$/, "");
}

function credentialHost(credential: CredentialMetadata): string | null {
  try {
    return normalizeSite(new URL(credential.url).hostname);
  } catch {
    return null;
  }
}

/** The saved login for a site: exact host first, then a parent/sub domain, then the label. */
export function matchCredential(
  credentials: ReadonlyArray<CredentialMetadata>,
  rawSite: string,
): CredentialMetadata | null {
  const site = normalizeSite(rawSite);
  if (site.length === 0) return null;
  const exact = credentials.find((credential) => credentialHost(credential) === site);
  if (exact) return exact;
  const related = credentials.find((credential) => {
    const host = credentialHost(credential);
    return host !== null && (host.endsWith(`.${site}`) || site.endsWith(`.${host}`));
  });
  if (related) return related;
  return (
    credentials.find((credential) => normalizeSite(credential.label) === site) ??
    credentials.find(
      (credential) => credential.label.trim().toLowerCase() === rawSite.trim().toLowerCase(),
    ) ??
    null
  );
}

/** Origin + path of a page URL; no query or fragment. */
export function publicPage(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

/** Visible login / one-time-code / captcha fields of the current page. */
export const LOGIN_PROBE_SCRIPT = `(() => {
  const visible = (el) => {
    if (!el || el.disabled) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const any = (selector) => Array.prototype.some.call(document.querySelectorAll(selector), visible);
  return {
    url: location.href,
    password: any('input[type="password"]'),
    username: any('input[autocomplete="username"], input[type="email"], input[name*="user" i], input[name*="login" i], input[name*="email" i]'),
    otp: any('input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="totp" i], input[name*="2fa" i], input[name*="verification" i], input[inputmode="numeric"][maxlength="6"]'),
    captcha: any('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], .g-recaptcha, .h-captcha'),
  };
})()`;

/** Submit the form the login fields belong to (Enter as a fallback). */
export const LOGIN_SUBMIT_SCRIPT = `(() => {
  const field = document.querySelector('input[type="password"]') ||
    document.querySelector('input[autocomplete="username"], input[type="email"], input[name*="user" i], input[name*="login" i], input[name*="email" i]');
  if (!field) return false;
  const form = field.form;
  const button = (form || document).querySelector('button[type="submit"], input[type="submit"]') ||
    Array.prototype.find.call((form || document).querySelectorAll('button'), (b) => /log ?in|sign ?in|next|continue|войти|далее/i.test(b.textContent || ""));
  if (button) { button.click(); return true; }
  if (form && typeof form.requestSubmit === "function") { form.requestSubmit(); return true; }
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  return true;
})()`;

/** Empty every password field: a failed attempt must not leave it readable. */
export const CLEAR_PASSWORDS_SCRIPT = `(() => {
  for (const el of document.querySelectorAll('input[type="password"]')) {
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (desc && desc.set) desc.set.call(el, ""); else el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  return true;
})()`;

export function parseProbe(result: BrowserAutomationCommandResult): LoginPageProbe | null {
  if (!result.ok || typeof result.data !== "object" || result.data === null) return null;
  const data = result.data as Record<string, unknown>;
  return {
    url: typeof data.url === "string" ? data.url : null,
    password: data.password === true,
    username: data.username === true,
    otp: data.otp === true,
    captcha: data.captcha === true,
  };
}

/**
 * Whether the page still asks to sign in. A lone e-mail/username field counts
 * only on a sign-in-looking address (first step of a two-step login) — a
 * dashboard may have a newsletter field.
 */
export function showsSignInForm(probe: LoginPageProbe): boolean {
  if (probe.password || probe.otp || probe.captcha) return true;
  if (!probe.username) return false;
  let path = "";
  try {
    const parsed = new URL(probe.url ?? "");
    path = `${parsed.hostname}${parsed.pathname}`;
  } catch {
    path = "";
  }
  return /log-?in|sign-?in|auth|sso|account|session|identifier/i.test(path);
}

const looksSignedIn = (probe: LoginPageProbe) => !showsSignInForm(probe);

export const runBrowserLogin = (
  rawSite: string,
  deps: BrowserLoginDeps,
): Effect.Effect<BrowserLoginResult> =>
  Effect.gen(function* () {
    const site = normalizeSite(rawSite);
    if (site.length === 0 || !site.includes(".")) {
      return {
        ok: false,
        status: "not_signed_in" as const,
        site: rawSite,
        page: null,
        usedSavedPassword: false,
        detail: 'Give the site as a domain, e.g. {"login": "x.com"}.',
      };
    }
    const credential = matchCredential(
      yield* deps.listCredentials.pipe(Effect.orElseSucceed(() => [])),
      site,
    );
    const result = (
      status: BrowserLoginStatus,
      probe: LoginPageProbe | null,
      detail: string,
    ): BrowserLoginResult => ({
      ok: status === "signed_in",
      status,
      site,
      page: publicPage(probe?.url ?? null),
      usedSavedPassword: credential !== null,
      detail,
    });
    const probe = deps
      .exec({ command: "evaluate", script: LOGIN_PROBE_SCRIPT })
      .pipe(Effect.map(parseProbe));
    const clearPasswords = deps
      .exec({ command: "evaluate", script: CLEAR_PASSWORDS_SCRIPT })
      .pipe(Effect.asVoid);

    /** The person finishes; then we look again. */
    const viaHuman = (why: string) =>
      Effect.gen(function* () {
        const helped = yield* deps.askHuman(why);
        if (!helped.ok) {
          return result(
            "needs_help",
            yield* probe,
            `Asked the person to sign in to ${site}; they haven't finished (${helped.error ?? "no answer"}). Tell them in chat and continue with something else.`,
          );
        }
        const after = yield* probe;
        return after !== null && looksSignedIn(after)
          ? result("signed_in", after, `The person signed in to ${site}.`)
          : result(
              "not_signed_in",
              after,
              `The person handed the browser back, but ${site} still shows a sign-in form.`,
            );
      });

    const startUrl =
      credential?.url && /^https?:\/\//i.test(credential.url) ? credential.url : `https://${site}/`;
    const opened = yield* deps.exec({ command: "openUrl", url: startUrl });
    if (!opened.ok) {
      return result(
        "not_signed_in",
        null,
        `Could not open ${startUrl}: ${opened.error ?? "unknown error"}.`,
      );
    }
    let page = yield* probe;
    if (page === null) {
      return result("not_signed_in", null, `Could not read the page of ${site}.`);
    }
    if (looksSignedIn(page)) {
      return result("signed_in", page, `No sign-in form on ${site}: the saved session is active.`);
    }
    if (credential === null) {
      return yield* viaHuman(
        `Sign in to ${site} in this browser (no saved password for it in Uno Work), then hand it back.`,
      );
    }
    const password = yield* deps
      .revealPassword(credential.id)
      .pipe(Effect.orElseSucceed(() => null));
    if (password === null) {
      return yield* viaHuman(
        `Sign in to ${site} in this browser (the saved password could not be read), then hand it back.`,
      );
    }
    deps.registerSecret(password);

    for (let round = 0; round < MAX_FILL_ROUNDS; round += 1) {
      if (page.otp || page.captcha) break;
      if (!showsSignInForm(page)) break;
      const filled = yield* deps.exec({
        command: "fillCredential",
        username: credential.username,
        password,
      });
      if (!filled.ok) break;
      yield* deps.exec({ command: "evaluate", script: LOGIN_SUBMIT_SCRIPT });
      yield* deps.sleep(SUBMIT_SETTLE_MS);
      const next = yield* probe;
      if (next === null) break;
      page = next;
      if (looksSignedIn(page)) {
        return result("signed_in", page, `Signed in to ${site} with the saved password.`);
      }
    }
    yield* clearPasswords;
    if (page.otp || page.captcha) {
      return yield* viaHuman(
        `Finish signing in to ${site}: it asks for ${page.otp ? "a one-time code (2FA)" : "a captcha"}. Then hand the browser back.`,
      );
    }
    return yield* viaHuman(
      `Signing in to ${site} with the saved password didn't get through. Please sign in in this browser (and update the password in Uno Work → Settings → Passwords if it changed), then hand it back.`,
    );
  });

export { HELP_TIMEOUT_MS as BROWSER_LOGIN_HELP_TIMEOUT_MS };
