import type {
  BrowserAutomationCommandInput,
  BrowserAutomationCommandResult,
  CredentialMetadata,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  CLEAR_PASSWORDS_SCRIPT,
  LOGIN_PROBE_SCRIPT,
  LOGIN_SUBMIT_SCRIPT,
  matchCredential,
  normalizeSite,
  publicPage,
  runBrowserLogin,
  showsSignInForm,
  type LoginPageProbe,
} from "./browserLogin.ts";

const PASSWORD = "correct horse battery staple";

const credential = (overrides: Partial<CredentialMetadata> = {}): CredentialMetadata =>
  ({
    id: "cred-1",
    label: "X",
    url: "https://x.com/i/flow/login",
    username: "uno_marketing",
    updatedAt: "2026-10-02T00:00:00.000Z",
    ...overrides,
  }) as CredentialMetadata;

const form: LoginPageProbe = {
  url: "https://x.com/i/flow/login?redirect=secret-token",
  password: true,
  username: true,
  otp: false,
  captcha: false,
};
const home: LoginPageProbe = {
  url: "https://x.com/home",
  password: false,
  username: false,
  otp: false,
  captcha: false,
};

const ok = (data?: unknown): BrowserAutomationCommandResult => ({
  ok: true,
  commandId: "c",
  ...(data !== undefined ? { data } : {}),
});

function scenario(input: {
  readonly credentials: ReadonlyArray<CredentialMetadata>;
  /** Pages the probe returns, one per probe (the last one repeats). */
  readonly pages: ReadonlyArray<LoginPageProbe>;
  readonly helpOk?: boolean;
}) {
  const commands: Array<BrowserAutomationCommandInput> = [];
  const asked: Array<string> = [];
  const secrets: Array<string> = [];
  let revealed = 0;
  let probeIndex = 0;
  const run = runBrowserLogin("https://www.X.com/", {
    listCredentials: Effect.succeed(input.credentials),
    revealPassword: () =>
      Effect.sync(() => {
        revealed += 1;
        return PASSWORD;
      }),
    exec: (command) =>
      Effect.sync(() => {
        commands.push(command);
        if (command.command === "evaluate" && command.script === LOGIN_PROBE_SCRIPT) {
          const page = input.pages[Math.min(probeIndex, input.pages.length - 1)];
          probeIndex += 1;
          return ok(page);
        }
        return ok(true);
      }),
    askHuman: (text) =>
      Effect.sync(() => {
        asked.push(text);
        return input.helpOk === false
          ? { ok: false, commandId: "h", error: "Nobody answered within 10 min." }
          : ok({ handedBack: true });
      }),
    registerSecret: (value) => {
      secrets.push(value);
    },
    sleep: () => Effect.void,
  });
  return {
    result: Effect.runPromise(run),
    commands,
    asked,
    secrets,
    revealed: () => revealed,
  };
}

describe("browser login from the vault", () => {
  it("matches sites and strips page addresses", () => {
    expect(normalizeSite("https://www.X.com/login")).toBe("x.com");
    expect(normalizeSite("notion.so")).toBe("notion.so");
    const creds = [
      credential({ id: "a" as never, url: "https://accounts.google.com/" }),
      credential({ id: "b" as never, url: "https://x.com/login" }),
      credential({ id: "c" as never, label: "LinkedIn", url: "not a url" }),
    ];
    expect(matchCredential(creds, "x.com")?.id).toBe("b");
    expect(matchCredential(creds, "google.com")?.id).toBe("a");
    expect(matchCredential(creds, "linkedin")?.id).toBe("c");
    expect(matchCredential(creds, "github.com")).toBeNull();
    expect(publicPage("https://x.com/home?token=abc#frag")).toBe("https://x.com/home");
    expect(showsSignInForm({ ...home, username: true })).toBe(false);
    expect(showsSignInForm({ ...home, url: "https://x.com/i/flow/login", username: true })).toBe(
      true,
    );
  });

  it("an active session: signed in, the password is not even read", async () => {
    const run = scenario({ credentials: [credential()], pages: [home] });
    const result = await run.result;
    expect(result).toMatchObject({ ok: true, status: "signed_in", site: "x.com" });
    expect(run.revealed()).toBe(0);
    expect(run.asked).toEqual([]);
  });

  it("fills and submits the saved login; the model sees no secret", async () => {
    const run = scenario({ credentials: [credential()], pages: [form, home] });
    const result = await run.result;
    expect(result).toMatchObject({
      ok: true,
      status: "signed_in",
      page: "https://x.com/home",
      usedSavedPassword: true,
    });
    const fill = run.commands.find((command) => command.command === "fillCredential");
    expect(fill).toMatchObject({ username: "uno_marketing", password: PASSWORD });
    expect(run.commands.some((command) => command.script === LOGIN_SUBMIT_SCRIPT)).toBe(true);
    expect(run.secrets).toEqual([PASSWORD]);
    const visible = JSON.stringify(result);
    expect(visible).not.toContain(PASSWORD);
    expect(visible).not.toContain("uno_marketing");
    expect(visible).not.toContain("secret-token");
    expect(run.asked).toEqual([]);
  });

  it("2FA: clears the password fields and asks the person", async () => {
    const otp = { ...form, password: false, otp: true };
    const run = scenario({ credentials: [credential()], pages: [form, otp, home] });
    const result = await run.result;
    expect(run.commands.some((command) => command.script === CLEAR_PASSWORDS_SCRIPT)).toBe(true);
    expect(run.asked[0]).toContain("one-time code");
    expect(result).toMatchObject({ status: "signed_in", ok: true });
  });

  it("no saved password: the person signs in; nobody answering is needs_help", async () => {
    const run = scenario({ credentials: [], pages: [form], helpOk: false });
    const result = await run.result;
    expect(run.asked[0]).toContain("no saved password");
    expect(result).toMatchObject({ ok: false, status: "needs_help", usedSavedPassword: false });
    expect(run.commands.some((command) => command.command === "fillCredential")).toBe(false);
  });

  it("a wrong saved password ends with the person, not a loop", async () => {
    const run = scenario({ credentials: [credential()], pages: [form], helpOk: true });
    const result = await run.result;
    expect(run.commands.filter((command) => command.command === "fillCredential")).toHaveLength(2);
    expect(run.asked[0]).toContain("didn't get through");
    expect(result).toMatchObject({ status: "not_signed_in", ok: false });
  });

  it("rejects something that is not a domain", async () => {
    const result = await Effect.runPromise(
      runBrowserLogin("my bank", {
        listCredentials: Effect.succeed([]),
        revealPassword: () => Effect.succeed(null),
        exec: () => Effect.die("unused"),
        askHuman: () => Effect.die("unused"),
        registerSecret: () => undefined,
        sleep: () => Effect.void,
      }),
    );
    expect(result).toMatchObject({ ok: false, status: "not_signed_in" });
  });
});
