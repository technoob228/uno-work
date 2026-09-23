/**
 * "Sign in with Uno" for the desktop app — the Uno account belongs to the
 * interface (this app, on the person's computer), not to any machine.
 *
 *   1. listen on 127.0.0.1:<random port>;
 *   2. open the console page /work/desktop?port&state&device in the browser —
 *      the person is (or gets) logged in there and presses Allow;
 *   3. the console redirects the browser to 127.0.0.1:<port>/uno-callback
 *      with a single-use code (120 s) bound to our random state;
 *   4. we exchange the code for a user token with the single `work:interface`
 *      scope (console: POST /api/v1/work/desktop-token).
 *
 * The token is encrypted with Electron safeStorage (the macOS Keychain) and
 * never leaves the main process: the renderer asks for account calls through
 * `request`, which only accepts the same allowlist the console enforces.
 */
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Http from "node:http";
import * as OS from "node:os";
import * as Path from "node:path";

import type {
  DesktopUnoAccountRequest,
  DesktopUnoAccountResponse,
  DesktopUnoAccountStatus,
} from "@t3tools/contracts";

export const UNO_CONSOLE_URL = (
  process.env.UNO_WORK_DEV_CONSOLE_URL?.trim() || "https://console.uno4.dev"
).replace(/\/+$/, "");

const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

export interface SecretCodec {
  readonly isEncryptionAvailable: () => boolean;
  readonly encryptString: (value: string) => Buffer;
  readonly decryptString: (value: Buffer) => string;
}

export interface UnoAccountDeps {
  readonly filePath: string;
  readonly codec: SecretCodec;
  readonly openExternal: (url: string) => Promise<void>;
  readonly fetch: typeof fetch;
  readonly consoleUrl?: string;
  readonly deviceName?: string;
}

interface StoredAccount {
  readonly token: string;
  readonly email: string | null;
}

/** Console routes the interface may call (mirrors the console's allowlist). */
const ALLOWED: ReadonlyArray<{ method: string; pattern: RegExp; query?: RegExp }> = [
  { method: "GET", pattern: /^\/auth\/me$/ },
  { method: "GET", pattern: /^\/api\/v1\/box-subscription$/ },
  { method: "GET", pattern: /^\/api\/v1\/boxes$/ },
  { method: "GET", pattern: /^\/api\/v1\/boxes\/\d+$/ },
  { method: "POST", pattern: /^\/api\/v1\/boxes\/\d+\/(wake|sleep|start|stop)$/ },
  { method: "POST", pattern: /^\/api\/v1\/boxes\/\d+\/work\/session$/ },
  { method: "GET", pattern: /^\/api\/v1\/boxes\/\d+\/ports$/ },
  { method: "POST", pattern: /^\/api\/v1\/boxes\/\d+\/ports$/ },
  { method: "GET", pattern: /^\/api\/v1\/work\/image$/ },
  { method: "POST", pattern: /^\/api\/v1\/images\/\d+\/launch$/ },
  { method: "GET", pattern: /^\/api\/v1\/boxes\/\d+\/machine-access$/ },
  { method: "PUT", pattern: /^\/api\/v1\/boxes\/\d+\/machine-access$/ },
  { method: "POST", pattern: /^\/api\/v1\/boxes\/\d+\/machine-access\/revoke$/ },
  { method: "GET", pattern: /^\/api\/v1\/security\/summary$/ },
  { method: "GET", pattern: /^\/api\/v1\/boxes\/\d+\/security\/access-log$/ },
  { method: "GET", pattern: /^\/api\/v1\/boxes\/\d+\/security\/network$/ },
  { method: "PUT", pattern: /^\/api\/v1\/boxes\/\d+\/security\/network$/ },
  // "My Uno": the whole account in one window — plans, sites, cloud, payments,
  // roles and servers without Uno Work. Money still moves only in the console.
  { method: "GET", pattern: /^\/api\/v1\/work\/(plans|sites)$/ },
  { method: "POST", pattern: /^\/api\/v1\/work\/servers$/ },
  { method: "GET", pattern: /^\/api\/v1\/buckets$/ },
  { method: "GET", pattern: /^\/pay\/(history|spending)$/ },
  { method: "PATCH", pattern: /^\/api\/v1\/boxes\/\d+$/ },
  { method: "GET", pattern: /^\/api\/v1\/boxes\/\d+\/(metrics|apps)$/ },
  {
    method: "GET",
    pattern: /^\/api\/v1\/boxes\/\d+\/applogs$/,
    query: /^source=(auto|journal|docker)&tail=\d{1,4}$/,
  },
];

export function isAllowedAccountRequest(method: string, path: string): boolean {
  if (path.includes("#") || path.includes("..")) return false;
  const mark = path.indexOf("?");
  const pathname = mark === -1 ? path : path.slice(0, mark);
  const query = mark === -1 ? undefined : path.slice(mark + 1);
  return ALLOWED.some(
    (rule) =>
      rule.method === method &&
      rule.pattern.test(pathname) &&
      (query === undefined || (rule.query !== undefined && rule.query.test(query))),
  );
}

function defaultDeviceName(): string {
  return (OS.hostname().replace(/\.local$/i, "") || "this computer").slice(0, 64);
}

export class UnoAccountService {
  private signInInFlight: Promise<DesktopUnoAccountStatus> | null = null;
  private readonly deps: UnoAccountDeps;

  constructor(deps: UnoAccountDeps) {
    this.deps = deps;
  }

  private get consoleUrl(): string {
    return (this.deps.consoleUrl ?? UNO_CONSOLE_URL).replace(/\/+$/, "");
  }

  private read(): StoredAccount | null {
    try {
      if (!this.deps.codec.isEncryptionAvailable()) return null;
      const raw = FS.readFileSync(this.deps.filePath);
      const parsed = JSON.parse(this.deps.codec.decryptString(raw)) as Partial<StoredAccount>;
      return typeof parsed.token === "string" && parsed.token.length > 0
        ? { token: parsed.token, email: typeof parsed.email === "string" ? parsed.email : null }
        : null;
    } catch {
      return null;
    }
  }

  private write(account: StoredAccount | null): void {
    if (account === null) {
      FS.rmSync(this.deps.filePath, { force: true });
      return;
    }
    if (!this.deps.codec.isEncryptionAvailable()) {
      throw new Error("This computer can't store the sign-in securely (no keychain).");
    }
    FS.mkdirSync(Path.dirname(this.deps.filePath), { recursive: true });
    FS.writeFileSync(this.deps.filePath, this.deps.codec.encryptString(JSON.stringify(account)), {
      mode: 0o600,
    });
  }

  status(): DesktopUnoAccountStatus {
    const account = this.read();
    return { signedIn: account !== null, email: account?.email ?? null };
  }

  signOut(): DesktopUnoAccountStatus {
    this.write(null);
    return this.status();
  }

  signIn(): Promise<DesktopUnoAccountStatus> {
    this.signInInFlight ??= this.runSignIn().finally(() => {
      this.signInInFlight = null;
    });
    return this.signInInFlight;
  }

  private async runSignIn(): Promise<DesktopUnoAccountStatus> {
    const state = Crypto.randomBytes(24).toString("base64url");
    const { port, code, close } = await waitForCallback(state);
    try {
      const url = new URL(`${this.consoleUrl}/work/desktop`);
      url.searchParams.set("port", String(port));
      url.searchParams.set("state", state);
      url.searchParams.set("device", this.deps.deviceName ?? defaultDeviceName());
      await this.deps.openExternal(url.toString());
      const received = await code;
      const response = await this.deps.fetch(`${this.consoleUrl}/api/v1/work/desktop-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: received, state }),
      });
      const body = (await response.json().catch(() => null)) as {
        token?: unknown;
        user?: { email?: unknown };
        error?: unknown;
      } | null;
      if (!response.ok || typeof body?.token !== "string") {
        throw new Error(
          `Uno didn't finish the sign-in (${typeof body?.error === "string" ? body.error : response.status}). Try again.`,
        );
      }
      this.write({
        token: body.token,
        email: typeof body.user?.email === "string" ? body.user.email : null,
      });
      return this.status();
    } finally {
      close();
    }
  }

  async request(input: DesktopUnoAccountRequest): Promise<DesktopUnoAccountResponse> {
    if (!isAllowedAccountRequest(input.method, input.path)) {
      return { status: 403, body: { error: "NOT_ALLOWED" } };
    }
    const account = this.read();
    if (!account) return { status: 401, body: { error: "NOT_SIGNED_IN" } };
    const response = await this.deps.fetch(`${this.consoleUrl}${input.path}`, {
      method: input.method,
      headers: {
        Authorization: `Bearer ${account.token}`,
        ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    // A revoked or deleted token: forget it so the app offers "Sign in" again.
    if (response.status === 401) this.write(null);
    return { status: response.status, body };
  }
}

const CALLBACK_PAGE = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh;color:#222">` +
  `<div style="text-align:center"><h2>${title}</h2><p>${text}</p></div></body>`;

/** Loopback receiver for the one redirect from the console. */
export function waitForCallback(state: string): Promise<{
  port: number;
  code: Promise<string>;
  close: () => void;
}> {
  return new Promise((resolveServer, rejectServer) => {
    let settle: { resolve: (code: string) => void; reject: (error: Error) => void } | null = null;
    const code = new Promise<string>((resolve, reject) => {
      settle = { resolve, reject };
    });
    const server = Http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/uno-callback") {
        res.writeHead(404).end();
        return;
      }
      const got = url.searchParams.get("code");
      const gotState = url.searchParams.get("state");
      if (!got || gotState !== state) {
        res
          .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
          .end(CALLBACK_PAGE("Sign-in link doesn't match", "Start again from the Uno Work app."));
        return;
      }
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(CALLBACK_PAGE("You're signed in", "You can close this tab and go back to Uno Work."));
      settle?.resolve(got);
    });
    const timer = setTimeout(
      () => settle?.reject(new Error("Sign-in timed out. Try again.")),
      SIGN_IN_TIMEOUT_MS,
    );
    const close = () => {
      clearTimeout(timer);
      server.close();
    };
    code.catch(() => undefined);
    server.on("error", rejectServer);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectServer(new Error("Couldn't open the sign-in receiver."));
        return;
      }
      resolveServer({ port: address.port, code, close });
    });
  });
}
