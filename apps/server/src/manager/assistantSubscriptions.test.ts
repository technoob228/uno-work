import type { ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  chatgptSignInFromAuthStore,
  claudeSignInFromProviders,
  hermesCommandEnvironment,
  hermesVersionAtLeast,
  parseDeviceSignIn,
  subscriptionStatuses,
} from "./assistantSubscriptions.ts";

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function fakeJwt(claims: Record<string, unknown>): string {
  return `${base64urlJson({ alg: "none" })}.${base64urlJson(claims)}.sig`;
}

const claudeProvider = (auth: ServerProvider["auth"], installed = true) =>
  ({ driver: "claudeAgent", installed, auth }) as unknown as ServerProvider;

describe("hermesVersionAtLeast", () => {
  it("reads the versions Hermes prints", () => {
    expect(hermesVersionAtLeast("0.22.0+2217.g5575a08", "0.21.4")).toBe(true);
    expect(hermesVersionAtLeast("0.21.4", "0.21.4")).toBe(true);
    expect(hermesVersionAtLeast("0.19.0", "0.21.4")).toBe(false);
    expect(hermesVersionAtLeast(null, "0.21.4")).toBe(false);
    expect(hermesVersionAtLeast("dev", "0.21.4")).toBe(false);
  });
});

describe("parseDeviceSignIn", () => {
  it("finds the page and the code in what `hermes auth add openai-codex` prints (0.19, 14.10)", () => {
    const output =
      "To continue, follow these steps:\n\n  1. Open this URL in your browser:\n     \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n\n  2. Enter this code:\n     \u001b[94mX518-DCRUM\u001b[0m\n\nWaiting for sign-in... (press Ctrl+C to cancel)\n";
    expect(parseDeviceSignIn(output)).toEqual({
      url: "https://auth.openai.com/codex/device",
      code: "X518-DCRUM",
    });
  });

  it("is empty before Hermes printed them", () => {
    expect(parseDeviceSignIn("To continue, follow these steps:\n")).toEqual({
      url: null,
      code: null,
    });
  });
});

describe("chatgptSignInFromAuthStore", () => {
  const token = fakeJwt({
    exp: 4_102_444_800,
    "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
    "https://api.openai.com/profile": { email: "misha@example.com" },
  });

  it("reads a sign-in added by `hermes auth add` (credential pool)", () => {
    const raw = JSON.stringify({
      version: 1,
      credential_pool: { "openai-codex": [{ id: "a1", access_token: token }] },
    });
    expect(chatgptSignInFromAuthStore(raw)).toEqual({
      signedIn: true,
      plan: "ChatGPT Plus",
      account: "misha@example.com",
    });
  });

  it("reads the singleton slot too", () => {
    const raw = JSON.stringify({
      providers: { "openai-codex": { tokens: { access_token: token, refresh_token: "r" } } },
    });
    expect(chatgptSignInFromAuthStore(raw).signedIn).toBe(true);
  });

  it("is signed out with no file, broken JSON or other providers only", () => {
    expect(chatgptSignInFromAuthStore(null).signedIn).toBe(false);
    expect(chatgptSignInFromAuthStore("{").signedIn).toBe(false);
    expect(
      chatgptSignInFromAuthStore(JSON.stringify({ providers: { nous: { tokens: {} } } })).signedIn,
    ).toBe(false);
  });
});

describe("claudeSignInFromProviders", () => {
  it("takes a sign-in with a plan behind it", () => {
    expect(
      claudeSignInFromProviders([
        claudeProvider({
          status: "authenticated",
          type: "max",
          label: "Claude Max Subscription",
          email: "m@example.com",
        }),
      ]),
    ).toEqual({ signedIn: true, plan: "Claude Max", account: "m@example.com" });
  });

  it("does not count Claude Code on Uno AI, on an API key, or a bare 'authenticated'", () => {
    for (const auth of [
      { status: "authenticated", type: "unoAi", label: "Uno AI" },
      { status: "authenticated", type: "apiKey", label: "Claude API Key" },
      { status: "authenticated" },
      { status: "unauthenticated" },
    ] as const) {
      expect(claudeSignInFromProviders([claudeProvider(auth)]).signedIn).toBe(false);
    }
    expect(claudeSignInFromProviders([]).signedIn).toBe(false);
  });
});

describe("subscriptionStatuses", () => {
  const signedOut = { signedIn: false, plan: null, account: null };
  const claudeMax = { signedIn: true, plan: "Claude Max", account: null };

  it("asks for a newer Hermes before anything else for Claude", () => {
    const [claude] = subscriptionStatuses({
      hermesVersion: "0.19.0",
      claude: claudeMax,
      chatgpt: signedOut,
    });
    expect(claude?.state).toBe("needs-hermes");
    expect(claude?.message).toContain("0.21.4");
    expect(claude?.message).toContain("0.19.0");
  });

  it("is ready when signed in on a Hermes that loads the plugin; ChatGPT works on 0.19", () => {
    const statuses = subscriptionStatuses({
      hermesVersion: "0.22.0",
      claude: claudeMax,
      chatgpt: { signedIn: true, plan: "ChatGPT Plus", account: "a@b.c" },
    });
    expect(statuses.map((entry) => [entry.provider, entry.state])).toEqual([
      ["claude", "ready"],
      ["chatgpt", "ready"],
    ]);
    const old = subscriptionStatuses({
      hermesVersion: "0.19.0",
      claude: signedOut,
      chatgpt: { signedIn: true, plan: null, account: null },
    });
    expect(old[1]?.state).toBe("ready");
  });

  it("says how to sign in: Claude Code's sign-in for Claude, the assistant's own for ChatGPT", () => {
    const [claude, chatgpt] = subscriptionStatuses({
      hermesVersion: "0.22.0",
      claude: signedOut,
      chatgpt: signedOut,
    });
    expect(claude).toMatchObject({ state: "sign-in", signIn: "harness" });
    expect(chatgpt).toMatchObject({ state: "sign-in", signIn: "assistant" });
  });
});

describe("hermesCommandEnvironment", () => {
  it("keeps only what a Hermes command needs — no Uno or Anthropic secrets", () => {
    const env = hermesCommandEnvironment({
      env: {
        HOME: "/home/u",
        PATH: "/usr/bin",
        HTTPS_PROXY: "http://proxy",
        OPENAI_API_KEY: "uno-key",
        ANTHROPIC_API_KEY: "sk-ant",
        UNO_API_KEY: "uno",
      },
      sharedHome: "/s/hermes-home-hermes",
    });
    expect(env).toEqual({
      HOME: "/home/u",
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://proxy",
      HERMES_HOME: "/s/hermes-home-hermes",
      NO_COLOR: "1",
      PYTHONUNBUFFERED: "1",
    });
  });
});
