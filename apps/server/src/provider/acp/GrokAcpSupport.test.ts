import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  describeGrokAuth,
  GROK_ACP_ARGS,
  grokAuthMethodFor,
  grokAutoApprove,
  grokHomeDir,
  grokPreflight,
  hasGrokSignIn,
} from "./GrokAcpSupport.ts";

const SIGN_IN = JSON.stringify({ "https://accounts.x.ai/sign-in": { key: "token" } });

const home = async (authJson?: string) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "uno-grok-support-"));
  await mkdir(dir, { recursive: true });
  if (authJson !== undefined) await writeFile(path.join(dir, "auth.json"), authJson);
  return { GROK_HOME: dir } as NodeJS.ProcessEnv;
};

describe("Grok sign-in", () => {
  it("reads auth.json: an entry is a sign-in, an empty object or file is not", () => {
    expect(hasGrokSignIn(SIGN_IN)).toBe(true);
    expect(hasGrokSignIn("{}")).toBe(false);
    expect(hasGrokSignIn("")).toBe(false);
    expect(hasGrokSignIn(undefined)).toBe(false);
    // A format we don't know: the CLI judges it, not us.
    expect(hasGrokSignIn("not json")).toBe(true);
  });

  it("the API key wins when set (a chat authenticates with it), else the xAI sign-in", () => {
    expect(describeGrokAuth({ XAI_API_KEY: "k" }, SIGN_IN)).toMatchObject({
      status: "authenticated",
      type: "xai-api-key",
    });
    expect(describeGrokAuth({}, SIGN_IN)).toMatchObject({ type: "xai-account" });
    expect(describeGrokAuth({ XAI_API_KEY: "  " }, undefined).status).toBe("unauthenticated");
  });

  it("picks the authenticate method and refuses a start with neither", async () => {
    const signedIn = await home(SIGN_IN);
    expect(await grokAuthMethodFor(signedIn)).toBe("cached_token");
    expect(await grokAuthMethodFor({ ...signedIn, XAI_API_KEY: "k" })).toBe("xai.api_key");
    expect(await grokPreflight(signedIn)).toBeUndefined();
    const nobody = await home();
    expect(await grokAuthMethodFor(nobody)).toBeUndefined();
    expect(await grokPreflight(nobody)).toMatch(/Grok is not signed in.*Settings → AI → Grok/);
  });

  it("GROK_HOME, else ~/.grok", () => {
    expect(grokHomeDir({ GROK_HOME: "/x/g" })).toBe("/x/g");
    expect(grokHomeDir({}, "/home/me")).toBe("/home/me/.grok");
  });
});

describe("Grok permissions", () => {
  it("runs in Grok's default permission mode, never one that skips the prompts", () => {
    expect(GROK_ACP_ARGS).toEqual(["--permission-mode", "default", "agent", "stdio"]);
    expect(GROK_ACP_ARGS.join(" ")).not.toMatch(/always-approve|bypass|auto|dontAsk/);
  });

  const request = (title: string, kind?: string) =>
    ({
      sessionId: "s",
      toolCall: { toolCallId: "t", title, ...(kind ? { kind } : {}) },
      options: [
        { optionId: "cancel", name: "Cancel", kind: "reject_once" },
        { optionId: "allow-edits-session", name: "Allow all edits", kind: "allow_always" },
        { optionId: "approve", name: "Approve", kind: "allow_once" },
      ],
    }) as never;

  it("answers only the uno-work MCP tools itself, allow once", () => {
    expect(grokAutoApprove(request("uno-work__notify", "other"))).toBe("approve");
    expect(grokAutoApprove(request("uno-work__notify"))).toBe("approve");
    expect(grokAutoApprove(request("uno-work__notify", "execute"))).toBeUndefined();
    expect(grokAutoApprove(request("github__create_issue", "other"))).toBeUndefined();
    expect(grokAutoApprove(request("rm -rf / uno-work__notify", "other"))).toBeUndefined();
    expect(grokAutoApprove(request("ls -la", "execute"))).toBeUndefined();
  });
});
