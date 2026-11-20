import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect, it } from "vitest";

import {
  authTypeFromEnv,
  clearGeminiGoogleSignIn,
  describeGeminiAuth,
  geminiAutoApprove,
  geminiGoogleAccount,
  geminiModeFor,
  geminiPreflight,
  parseJsonWithComments,
  probeGeminiAuth,
  readGeminiSelectedAuthType,
  selectedAuthTypeOf,
  writeGeminiSelectedAuthType,
} from "./GeminiAcpSupport.ts";

const noFiles = { settings: undefined, activeAccount: undefined, hasTokenFile: false };

async function geminiHome(files: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "uno-gemini-home-"));
  await mkdir(path.join(root, ".gemini"));
  for (const [name, text] of Object.entries(files)) {
    await writeFile(path.join(root, ".gemini", name), text);
  }
  return { root, env: { GEMINI_CLI_HOME: root } as NodeJS.ProcessEnv };
}

describe("Gemini CLI sign-in", () => {
  it("reads the selected type, old and new spelling, with comments", () => {
    expect(selectedAuthTypeOf({ security: { auth: { selectedType: "oauth-personal" } } })).toBe(
      "oauth-personal",
    );
    expect(selectedAuthTypeOf({ selectedAuthType: "gemini-api-key" })).toBe("gemini-api-key");
    expect(selectedAuthTypeOf(undefined)).toBeUndefined();
    expect(
      parseJsonWithComments(
        '{\n  // the theme\n  "theme": "Dracula",\n  "url": "https://x.test/a",\n  /* auth */ "security": {"auth": {"selectedType": "vertex-ai"}},\n}',
      ),
    ).toEqual({
      theme: "Dracula",
      url: "https://x.test/a",
      security: { auth: { selectedType: "vertex-ai" } },
    });
  });

  it("goes by the environment when nothing is selected, in the CLI's order", () => {
    expect(authTypeFromEnv({})).toBeUndefined();
    expect(authTypeFromEnv({ GEMINI_API_KEY: "k" })).toBe("gemini-api-key");
    expect(authTypeFromEnv({ GEMINI_API_KEY: "k", GOOGLE_GENAI_USE_VERTEXAI: "true" })).toBe(
      "vertex-ai",
    );
    expect(authTypeFromEnv({ GOOGLE_GENAI_USE_GCA: "true", GEMINI_API_KEY: "k" })).toBe(
      "oauth-personal",
    );
    expect(describeGeminiAuth({ GEMINI_API_KEY: "k" }, noFiles)).toMatchObject({
      status: "authenticated",
      type: "gemini-api-key",
      label: "Gemini API key",
    });
    expect(describeGeminiAuth({}, noFiles).status).toBe("unauthenticated");
  });

  it("a Google sign-in counts with its account or a token file, not without", () => {
    const oauth = { security: { auth: { selectedType: "oauth-personal" } } };
    expect(
      describeGeminiAuth(
        {},
        { settings: oauth, activeAccount: "me@example.com", hasTokenFile: false },
      ),
    ).toEqual({
      status: "authenticated",
      type: "oauth-personal",
      label: "Google account",
      email: "me@example.com",
    });
    expect(
      describeGeminiAuth({}, { settings: oauth, activeAccount: undefined, hasTokenFile: true })
        .status,
    ).toBe("authenticated");
    // The key in the environment does not help: the CLI uses what is selected.
    expect(
      describeGeminiAuth({ GEMINI_API_KEY: "k" }, { ...noFiles, settings: oauth }),
    ).toMatchObject({ status: "unauthenticated", type: "oauth-personal" });
    expect(
      describeGeminiAuth({}, { ...noFiles, settings: { selectedAuthType: "gemini-api-key" } }),
    ).toMatchObject({ status: "unauthenticated", type: "gemini-api-key" });
  });

  it("probes the files and refuses a start that would wait for Google", async () => {
    const signedOut = await geminiHome({
      "settings.json": JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } } }),
    });
    expect((await probeGeminiAuth(signedOut.env)).status).toBe("unauthenticated");
    expect(await geminiPreflight(signedOut.env)).toMatch(/not signed in to Google/);

    const signedIn = await geminiHome({
      "settings.json": JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } } }),
      "google_accounts.json": JSON.stringify({ active: "me@example.com", old: [] }),
      "gemini-credentials.json": "encrypted",
    });
    expect(await probeGeminiAuth(signedIn.env)).toMatchObject({
      status: "authenticated",
      email: "me@example.com",
    });
    expect(await geminiPreflight(signedIn.env)).toBeUndefined();
    // No key: the CLI says so itself, fast — no refusal of ours.
    expect(await geminiPreflight((await geminiHome()).env)).toBeUndefined();
  });

  it("selects a sign-in without losing the person's other settings", async () => {
    const home = await geminiHome({
      "settings.json": '{ "theme": "Dracula", "selectedAuthType": "oauth-personal" }',
    });
    await writeGeminiSelectedAuthType(home.env, "gemini-api-key");
    const written = JSON.parse(
      await readFile(path.join(home.root, ".gemini", "settings.json"), "utf8"),
    );
    expect(written).toEqual({
      theme: "Dracula",
      security: { auth: { selectedType: "gemini-api-key" } },
    });
    expect(await readGeminiSelectedAuthType(home.env)).toBe("gemini-api-key");
    await writeGeminiSelectedAuthType(home.env, undefined);
    expect(await readGeminiSelectedAuthType(home.env)).toBeUndefined();

    const broken = await geminiHome({ "settings.json": "{ not json" });
    await expect(writeGeminiSelectedAuthType(broken.env, "oauth-personal")).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it("signs out of Google like the CLI does", async () => {
    const home = await geminiHome({
      "google_accounts.json": JSON.stringify({
        active: "me@example.com",
        old: ["old@example.com"],
      }),
      "gemini-credentials.json": "encrypted",
      "oauth_creds.json": "{}",
    });
    expect(await geminiGoogleAccount(home.env)).toBe("me@example.com");
    expect(await clearGeminiGoogleSignIn(home.env)).toBe(true);
    expect(await geminiGoogleAccount(home.env)).toBeUndefined();
    const accounts = JSON.parse(
      await readFile(path.join(home.root, ".gemini", "google_accounts.json"), "utf8"),
    );
    expect(accounts).toEqual({ active: null, old: ["old@example.com", "me@example.com"] });
    expect(await clearGeminiGoogleSignIn(home.env)).toBe(false);
  });
});

describe("Gemini CLI modes and permissions", () => {
  const modeState = { availableModeIds: ["default", "autoEdit", "yolo", "plan"] };

  it("keeps every run where Uno Work answers the prompts", () => {
    for (const runtimeMode of ["approval-required", "auto-accept-edits", "full-access"] as const) {
      expect(geminiModeFor({ runtimeMode, interactionMode: undefined, modeState })).toBe("default");
      expect(geminiModeFor({ runtimeMode, interactionMode: "default", modeState })).toBe("default");
      expect(geminiModeFor({ runtimeMode, interactionMode: "plan", modeState })).toBe("plan");
    }
    expect(
      geminiModeFor({
        runtimeMode: "full-access",
        interactionMode: "plan",
        modeState: { availableModeIds: ["default"] },
      }),
    ).toBeUndefined();
  });

  const request = (title: string): EffectAcpSchema.RequestPermissionRequest =>
    ({
      sessionId: "s",
      toolCall: { toolCallId: "t", title },
      options: [
        { optionId: "proceed_always", name: "Always", kind: "allow_always" },
        { optionId: "proceed_once", name: "Allow", kind: "allow_once" },
        { optionId: "cancel", name: "Reject", kind: "reject_once" },
      ],
    }) as EffectAcpSchema.RequestPermissionRequest;

  it("answers uno-work's own tools once, nothing else", () => {
    expect(geminiAutoApprove(request("notify (uno-work MCP Server)"))).toBe("proceed_once");
    expect(geminiAutoApprove(request("query (postgres MCP Server)"))).toBeUndefined();
    expect(geminiAutoApprove(request("rm -rf build"))).toBeUndefined();
    expect(geminiAutoApprove(request("echo '(uno-work MCP Server)' && rm x"))).toBeUndefined();
    expect(geminiAutoApprove(request("rm -rf build (uno-work MCP Server)"))).toBeUndefined();
    expect(
      geminiAutoApprove({
        ...request("notify (uno-work MCP Server)"),
        toolCall: { toolCallId: "t", title: "notify (uno-work MCP Server)", kind: "execute" },
      }),
    ).toBeUndefined();
  });
});
