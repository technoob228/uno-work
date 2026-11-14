import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { MyComputerTier, RuntimeMode } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeActivityLog } from "../activityLog.ts";
import { decideTrust, STOPPED_MESSAGE, type TrustDecisionInput } from "./decide.ts";
import { DEFAULT_TRUST_SETTINGS, makeTrustStore, parseTrustFile } from "./trustStore.ts";

const input = (over: Partial<TrustDecisionInput> = {}): TrustDecisionInput => ({
  tier: "free",
  reason: "reading in allowed folders",
  kind: "read",
  runtimeMode: "approval-required",
  cautious: false,
  outsideText: false,
  grantActive: false,
  paused: null,
  grantHours: 4,
  ...over,
});

const verdict = (over: Partial<TrustDecisionInput>) => decideTrust(input(over)).verdict;

describe("decideTrust", () => {
  const modes: ReadonlyArray<RuntimeMode> = [
    "approval-required",
    "auto-accept-edits",
    "full-access",
  ];

  it.each(modes)("free runs in %s", (runtimeMode) => {
    expect(verdict({ tier: "free", runtimeMode, kind: "run" })).toBe("run");
  });

  it.each(modes)("always asks in %s, with a sensitive card", (runtimeMode) => {
    const decision = decideTrust(input({ tier: "always", runtimeMode, grantActive: true }));
    expect(decision).toMatchObject({ verdict: "ask", grant: false, sensitive: true });
  });

  it.each(modes)("blocked is refused in %s, with the reason", (runtimeMode) => {
    expect(
      decideTrust(input({ tier: "blocked", reason: "run it in the cloud", runtimeMode })),
    ).toEqual({
      verdict: "refuse",
      message: "run it in the cloud",
    });
  });

  it("chat: asks once (Allow becomes the chat's), then runs", () => {
    expect(decideTrust(input({ tier: "chat", kind: "write" }))).toMatchObject({
      verdict: "ask",
      grant: true,
    });
    expect(verdict({ tier: "chat", kind: "write", grantActive: true })).toBe("run");
  });

  it("chat: full access runs; edits-run-freely runs writes, not commands", () => {
    expect(verdict({ tier: "chat", kind: "run", runtimeMode: "full-access" })).toBe("run");
    expect(verdict({ tier: "chat", kind: "write", runtimeMode: "auto-accept-edits" })).toBe("run");
    expect(verdict({ tier: "chat", kind: "run", runtimeMode: "auto-accept-edits" })).toBe("ask");
  });

  it("ask: every time, except in full access; never a grant", () => {
    expect(decideTrust(input({ tier: "ask", kind: "run", grantActive: true }))).toMatchObject({
      verdict: "ask",
      grant: false,
    });
    expect(verdict({ tier: "ask", kind: "run", runtimeMode: "auto-accept-edits" })).toBe("ask");
    expect(verdict({ tier: "ask", kind: "run", runtimeMode: "full-access" })).toBe("run");
  });

  it("Cautious and stranger's text: only free reads run; no grants", () => {
    for (const flag of [{ cautious: true }, { outsideText: true }]) {
      expect(verdict({ ...flag, tier: "free", kind: "read", runtimeMode: "full-access" })).toBe(
        "run",
      );
      expect(verdict({ ...flag, tier: "free", kind: "run", runtimeMode: "full-access" })).toBe(
        "ask",
      );
      expect(
        decideTrust(
          input({
            ...flag,
            tier: "chat",
            kind: "write",
            runtimeMode: "full-access",
            grantActive: true,
          }),
        ),
      ).toMatchObject({ verdict: "ask", grant: false });
    }
  });

  it("stopped by the person: everything is refused, free too", () => {
    for (const tier of [
      "free",
      "chat",
      "ask",
      "always",
      "blocked",
    ] as const satisfies ReadonlyArray<MyComputerTier>) {
      expect(
        decideTrust(input({ tier, paused: { at: "2026-11-13T00:00:00Z", reason: "stopped" } })),
      ).toEqual({ verdict: "refuse", message: STOPPED_MESSAGE });
    }
  });

  it("paused for idleness: the next call asks and Allow resumes", () => {
    const paused = { at: "2026-11-13T00:00:00Z", reason: "idle" as const };
    expect(decideTrust(input({ tier: "free", paused, runtimeMode: "full-access" }))).toMatchObject({
      verdict: "ask",
      resume: true,
    });
    expect(decideTrust(input({ tier: "chat", kind: "write", paused }))).toMatchObject({
      verdict: "ask",
      resume: true,
      grant: true,
    });
    expect(verdict({ tier: "blocked", paused })).toBe("refuse");
  });
});

describe("trust store", () => {
  let stateDir: string;
  let clock: number;
  const now = () => new Date(clock);
  const HOUR = 3_600_000;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "my-computer-trust-"));
    clock = Date.parse("2026-11-13T10:00:00Z");
  });
  afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

  it("starts with the defaults, saves settings 0600, and a new store reads them back", async () => {
    const store = makeTrustStore({ stateDir, now });
    expect(await store.settings()).toEqual(DEFAULT_TRUST_SETTINGS);
    await store.setSettings({
      ...DEFAULT_TRUST_SETTINGS,
      allowedFolders: ["~/work", " "],
      grantHours: 2,
    });
    const file = path.join(stateDir, "my-computer", "trust.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = makeTrustStore({ stateDir, now });
    expect(await again.settings()).toMatchObject({ allowedFolders: ["~/work"], grantHours: 2 });
    expect(JSON.parse(readFileSync(file, "utf8")).settings.grantHours).toBe(2);
  });

  it("a broken or tampered file falls back field by field", () => {
    expect(parseTrustFile("{not json").settings).toEqual(DEFAULT_TRUST_SETTINGS);
    const parsed = parseTrustFile(
      JSON.stringify({
        settings: { grantHours: 999, idleHours: 3, allowedFolders: "x" },
        paused: { at: 1 },
      }),
    );
    expect(parsed.settings).toMatchObject({ grantHours: 4, idleHours: 3 });
    expect(parsed.settings.allowedFolders).toEqual(DEFAULT_TRUST_SETTINGS.allowedFolders);
    expect(parsed.paused).toBeNull();
  });

  it("a chat's Allow lasts grantHours, per chat and computer, and can be revoked", async () => {
    const store = makeTrustStore({ stateDir, now });
    await store.grant({ threadId: "t1", threadTitle: "Site", computerId: "c1" });
    expect(store.grantActive("t1", "c1")).toBe(true);
    expect(store.grantActive("t2", "c1")).toBe(false);
    expect(store.grantActive("t1", "c2")).toBe(false);
    clock += 4 * HOUR - 1;
    expect(store.grantActive("t1", "c1")).toBe(true);
    clock += 1;
    expect(store.grantActive("t1", "c1")).toBe(false);
    await store.grant({ threadId: "t1", threadTitle: "Site", computerId: "c1" });
    store.revoke("t1", "c1");
    expect((await store.state(0)).grants).toEqual([]);
  });

  it("Allows live in memory only: a restart asks again", async () => {
    const store = makeTrustStore({ stateDir, now });
    await store.grant({ threadId: "t1", threadTitle: "Site", computerId: "c1" });
    await store.touch();
    expect(makeTrustStore({ stateDir, now }).grantActive("t1", "c1")).toBe(false);
  });

  it("pauses after idleHours without activity, drops the Allows, resumes", async () => {
    const store = makeTrustStore({ stateDir, now });
    await store.grant({ threadId: "t1", threadTitle: "Site", computerId: "c1" });
    await store.touch();
    clock += 12 * HOUR - 1;
    expect(await store.paused()).toBeNull();
    clock += 1;
    expect(await store.paused()).toMatchObject({ reason: "idle" });
    expect(store.grantActive("t1", "c1")).toBe(false);
    await store.resume();
    expect(await store.paused()).toBeNull();
  });

  it("Stop survives a restart", async () => {
    const store = makeTrustStore({ stateDir, now });
    await store.pause("stopped");
    expect(await makeTrustStore({ stateDir, now }).paused()).toMatchObject({ reason: "stopped" });
  });
});

describe("journal lines: tier, chat, and how each ended", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "my-computer-journal-"));
  });
  afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

  it("a finish line folds into its entry; a refusal is one line", async () => {
    const log = makeActivityLog({ stateDir });
    const id = await log.record("c1", {
      kind: "run",
      summary: "bun run typecheck",
      threadId: "t1",
      threadTitle: "Fix the build",
      tier: "free",
    });
    await log.record("c1", {
      kind: "run",
      summary: "docker compose up",
      tier: "blocked",
      refused: { reason: "containers run in the cloud" },
    });
    await log.finish("c1", id, { outcome: "failed", exitCode: 2, durationMs: 1234.6 });
    const [refused, ran] = await log.read("c1");
    expect(refused).toMatchObject({
      summary: "docker compose up",
      outcome: "refused",
      tier: "blocked",
    });
    expect(ran).toMatchObject({
      summary: "bun run typecheck",
      threadTitle: "Fix the build",
      tier: "free",
      outcome: "failed",
      exitCode: 2,
      durationMs: 1235,
    });
  });

  it("old lines (no id, no tier) still read", async () => {
    const dir = path.join(stateDir, "my-computer");
    const log = makeActivityLog({ stateDir });
    await log.record("c1", { kind: "list", summary: "~" });
    writeFileSync(
      path.join(dir, "c1.activity.jsonl"),
      `${JSON.stringify({ at: "2026-11-01T00:00:00Z", kind: "read", summary: "~/a" })}\n`,
      { flag: "a" },
    );
    const entries = await log.read("c1");
    expect(entries[0]).toEqual({ at: "2026-11-01T00:00:00Z", kind: "read", summary: "~/a" });
  });
});
