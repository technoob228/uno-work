import { describe, expect, it } from "vitest";

import {
  appendCappedLog,
  lastNonEmptyLine,
  parseOAuthPrompt,
  scrubSecret,
  stripAnsi,
} from "./harnessSetupParsers.ts";

// Captured from `codex login --device-auth` with stdout piped (codex-cli 0.153.2).
const CODEX_DEVICE_PROMPT = [
  "",
  "Welcome to Codex [v[90m0.153.2[0m]",
  "[90mOpenAI's command-line coding agent[0m",
  "",
  "Follow these steps to sign in with ChatGPT using device code authorization:",
  "",
  "1. Open this link in your browser and sign in to your account",
  "   [94mhttps://auth.openai.com/codex/device[0m",
  "",
  "2. Enter this one-time code [90m(expires in 15 minutes)[0m",
  "   [94m41IV-83JI8[0m",
  "",
  "[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.[0m",
  "",
].join("\n");

// Captured from `claude auth login` with stdout piped (Claude Code 2.1.261).
const CLAUDE_LOGIN_PROMPT = [
  "Opening browser to sign in…",
  "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=HCPZsG03fSgmOEAO3osg_TqWO6JcGmpcqzOz9pANvC0&code_challenge_method=S256&state=9-Eb6y1Adc0PdvAuKgE4l7rDOTE4ua6KMOA6zcjmbnA",
  "Paste code here if prompted > ",
].join("\n");

describe("stripAnsi", () => {
  it("removes colour codes and keeps the text", () => {
    expect(stripAnsi("[94mhttps://x.y[0m")).toBe("https://x.y");
  });
});

describe("parseOAuthPrompt", () => {
  it("extracts the codex device URL and one-time code", () => {
    const parsed = parseOAuthPrompt(CODEX_DEVICE_PROMPT);
    expect(parsed.verificationUrl).toBe("https://auth.openai.com/codex/device");
    expect(parsed.userCode).toBe("41IV-83JI8");
    expect(parsed.needsCodeInput).toBe(false);
  });

  it("does not mistake the version banner for a code before the URL is printed", () => {
    const parsed = parseOAuthPrompt(CODEX_DEVICE_PROMPT.split("Follow these steps")[0]!);
    expect(parsed.verificationUrl).toBeUndefined();
    expect(parsed.userCode).toBeUndefined();
  });

  it("extracts the claude authorize URL and detects the paste-code prompt", () => {
    const parsed = parseOAuthPrompt(CLAUDE_LOGIN_PROMPT);
    expect(parsed.verificationUrl).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
    expect(parsed.verificationUrl).toContain("state=9-Eb6y1Adc0PdvAuKgE4l7rDOTE4ua6KMOA6zcjmbnA");
    expect(parsed.needsCodeInput).toBe(true);
    expect(parsed.userCode).toBeUndefined();
  });

  it("prefers an auth-looking URL over a docs link and trims trailing punctuation", () => {
    const parsed = parseOAuthPrompt(
      "See https://docs.example.com/cli for help.\nVisit: https://login.example.com/device.",
    );
    expect(parsed.verificationUrl).toBe("https://login.example.com/device");
  });

  it("returns an empty parse for unrelated output", () => {
    expect(parseOAuthPrompt("npm WARN deprecated foo@1.0.0")).toEqual({ needsCodeInput: false });
  });
});

describe("appendCappedLog", () => {
  it("keeps everything under the cap", () => {
    expect(appendCappedLog("abc", "def", 10)).toBe("abcdef");
  });

  it("drops the oldest whole lines once the cap is exceeded", () => {
    const log = appendCappedLog("line1\nline2\n", "line3\nline4\n", 14);
    expect(log.length).toBeLessThanOrEqual(14);
    expect(log.startsWith("line")).toBe(true);
    expect(log.endsWith("line4\n")).toBe(true);
    expect(log).not.toContain("line1");
  });

  it("falls back to a byte cut when there is no newline to align to", () => {
    expect(appendCappedLog("", "x".repeat(20), 8)).toBe("x".repeat(8));
  });

  it("never grows past the cap over many appends", () => {
    let log = "";
    for (let index = 0; index < 5_000; index += 1) {
      log = appendCappedLog(log, `chunk ${index} ${"-".repeat(40)}\n`, 4_096);
    }
    expect(log.length).toBeLessThanOrEqual(4_096);
    expect(log).toContain("chunk 4999");
  });
});

describe("lastNonEmptyLine", () => {
  it("skips blank trailing lines and colour codes", () => {
    expect(lastNonEmptyLine("a\n[90mb[0m\n\n  \n")).toBe("b");
  });

  it("returns undefined for an empty log", () => {
    expect(lastNonEmptyLine("\n\n")).toBeUndefined();
  });
});

describe("scrubSecret", () => {
  it("replaces every occurrence of the secret", () => {
    expect(scrubSecret("key=sk-abc123 again sk-abc123", "sk-abc123")).toBe(
      "key=[redacted] again [redacted]",
    );
  });

  it("ignores trivial secrets so it cannot blank out the whole log", () => {
    expect(scrubSecret("a b c", "a")).toBe("a b c");
    expect(scrubSecret("a b c", undefined)).toBe("a b c");
  });
});
