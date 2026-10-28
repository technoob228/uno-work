import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assistantTokenLabel,
  ManagerTokenId,
  type ManagerCapabilityTokenDescriptor,
} from "@t3tools/contracts";
import { presetTokenAccess } from "@t3tools/shared/assistantPreset";
import { Effect, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  accessForNewToken,
  applyAssistantAccess,
  assistantOfThread,
  readAssistantAccess,
} from "./assistantAccess.ts";
import {
  connectorAccessDecision,
  readStoredAccess,
  recordStartedChat,
  writeStoredAccess,
} from "./localAssistantStore.ts";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "uno-assistant-access-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SCOUT = "assistant-scout";

const token = (access: ReturnType<typeof presetTokenAccess>): ManagerCapabilityTokenDescriptor => ({
  tokenId: ManagerTokenId.make("token-1"),
  label: assistantTokenLabel(SCOUT),
  budget: null,
  createdAt: "2026-10-21T00:00:00.000Z",
  revokedAt: null,
  ...access,
});

/** An in-memory token table with one active token per label. */
const fakeTokens = (initial: ManagerCapabilityTokenDescriptor | null) => {
  let current = initial;
  return {
    get current() {
      return current;
    },
    getActiveByLabel: (label: string) =>
      Effect.succeed(
        current !== null && current.label === label ? Option.some(current) : Option.none(),
      ),
    updateAccess: (input: {
      readonly scopes: ManagerCapabilityTokenDescriptor["scopes"];
      readonly projectAllowlist: ManagerCapabilityTokenDescriptor["projectAllowlist"];
      readonly autoApprove: boolean;
    }) =>
      Effect.sync(() => {
        if (current === null) return false;
        current = { ...current, ...input };
        return true;
      }),
  };
};

describe("connector cap by preset", () => {
  const unrestricted = { permissions: {}, restricted: false };
  const gmailWrite = { permissions: { gmail: "write" as const }, restricted: true };

  it("Observer only reads, whatever the person set", () => {
    expect(connectorAccessDecision(unrestricted, "gmail", true, "observer")).toBe("read-only");
    expect(connectorAccessDecision(gmailWrite, "gmail", true, "observer")).toBe("read-only");
    expect(connectorAccessDecision(gmailWrite, "gmail", false, "observer")).toBe("allow");
  });

  it("Helper and Full keep the person's levels (default Full: unchanged)", () => {
    expect(connectorAccessDecision(gmailWrite, "gmail", true, "helper")).toBe("allow");
    expect(connectorAccessDecision(unrestricted, "gmail", true)).toBe("allow");
    expect(
      connectorAccessDecision({ permissions: { gmail: "none" }, restricted: true }, "gmail", false),
    ).toBe("none");
  });
});

describe("stored access", () => {
  it("round-trips and drops junk", async () => {
    const stateDir = tempDir();
    expect(await readStoredAccess(stateDir, SCOUT)).toBeNull();
    await writeStoredAccess(stateDir, SCOUT, presetTokenAccess("helper", ["p1" as never], SCOUT));
    expect(await readStoredAccess(stateDir, SCOUT)).toEqual({
      scopes: ["threads:read", "threads:write"],
      projectAllowlist: [SCOUT, "p1"],
      autoApprove: true,
    });
    const file = path.join(stateDir, "assistants", SCOUT, "access.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ scopes: ["threads:read", "root"], projectAllowlist: 7 }));
    expect(await readStoredAccess(stateDir, SCOUT)).toBeNull();
  });
});

describe("a re-issued token keeps the preset", () => {
  it("takes the replaced token's access, else the stored copy, else Full everywhere", async () => {
    const stateDir = tempDir();
    const helper = presetTokenAccess("helper", ["p1" as never], SCOUT);
    expect(
      await Effect.runPromise(accessForNewToken(stateDir, SCOUT, Option.some(token(helper)))),
    ).toEqual(helper);
    expect(await Effect.runPromise(accessForNewToken(stateDir, SCOUT, Option.none()))).toEqual(
      presetTokenAccess("full", "all", SCOUT),
    );
    const observer = presetTokenAccess("observer", [], SCOUT);
    await writeStoredAccess(stateDir, SCOUT, observer);
    expect(await Effect.runPromise(accessForNewToken(stateDir, SCOUT, Option.none()))).toEqual(
      observer,
    );
  });
});

describe("applyAssistantAccess / readAssistantAccess", () => {
  it("changes the live token and the stored copy; reads come from the token", async () => {
    const stateDir = tempDir();
    const tokens = fakeTokens(token(presetTokenAccess("full", "all", SCOUT)));
    await Effect.runPromise(
      applyAssistantAccess(
        { tokens, stateDir },
        SCOUT,
        presetTokenAccess("observer", ["p1" as never], SCOUT),
      ),
    );
    expect(tokens.current?.scopes).toEqual(["threads:read"]);
    expect((await readStoredAccess(stateDir, SCOUT))?.scopes).toEqual(["threads:read"]);
    expect(await Effect.runPromise(readAssistantAccess({ tokens, stateDir }, SCOUT))).toEqual({
      projectId: SCOUT,
      preset: "observer",
      allowlist: [SCOUT, "p1"],
    });
  });

  it("without a token: the stored copy, else Full in its own workspace only", async () => {
    const stateDir = tempDir();
    const tokens = fakeTokens(null);
    expect(await Effect.runPromise(readAssistantAccess({ tokens, stateDir }, SCOUT))).toEqual({
      projectId: SCOUT,
      preset: "full",
      allowlist: [],
    });
    await Effect.runPromise(
      applyAssistantAccess({ tokens, stateDir }, SCOUT, presetTokenAccess("helper", "all", SCOUT)),
    );
    expect((await Effect.runPromise(readAssistantAccess({ tokens, stateDir }, SCOUT))).preset).toBe(
      "helper",
    );
  });
});

describe("assistantOfThread", () => {
  it("finds the assistant of its conversation and of a chat it started", async () => {
    const stateDir = tempDir();
    const tokens = fakeTokens(token(presetTokenAccess("helper", ["p1" as never], SCOUT)));
    await recordStartedChat(stateDir, "t-started", SCOUT);
    const threads = [
      { id: "t-conv", projectId: SCOUT },
      { id: "t-started", projectId: "p1" },
      { id: "t-grandchild", projectId: "p1", spawnedByThreadId: "t-started" },
      { id: "t-mine", projectId: "p1" },
    ];
    const of = (threadId: string) =>
      Effect.runPromise(assistantOfThread({ tokens, stateDir, threads }, threadId));
    expect((await of("t-conv"))?.preset).toBe("helper");
    expect((await of("t-started"))?.projectId).toBe(SCOUT);
    expect((await of("t-grandchild"))?.projectId).toBe(SCOUT);
    expect(await of("t-mine")).toBeNull();
    expect(await of("t-unknown")).toBeNull();
  });
});
