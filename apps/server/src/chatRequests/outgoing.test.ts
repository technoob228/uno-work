import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CHAT_REQUEST_WAIT_MS, type ChatRequestAnswer, type MyComputer } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeOutgoing, OUT_REASONS, PICKUP_GRACE_MS, remotePaths } from "./outgoing.ts";

const T0 = Date.parse("2026-11-20T10:00:00.000Z");
let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(path.join(os.tmpdir(), "chat-requests-out-"));
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

const mac = (online: boolean): MyComputer => ({
  id: "c1",
  name: "Misha's MacBook",
  os: "darwin",
  arch: "arm64",
  online,
  connectedAt: null,
  lastSeenAt: null,
  helperVersion: "1.0.0",
});

function setup(options: { online?: boolean; hostState?: unknown | null } = {}) {
  let now = T0;
  let online = options.online ?? true;
  const files = new Map<string, string>();
  if (options.hostState !== null) {
    files.set(
      remotePaths.state,
      JSON.stringify(
        options.hostState ?? {
          v: 1,
          allow: true,
          active: 0,
          limit: 2,
          seenAt: new Date(T0).toISOString(),
          app: "uno-work 0.0.190",
        },
      ),
    );
  }
  const told: Array<{ threadId: string; text: string }> = [];
  const notes: Array<string> = [];
  let busy = false;
  let n = 0;
  const out = makeOutgoing({
    stateDir,
    computers: async () => [mac(online)],
    read: async (_id, file) => {
      if (!online) throw new Error("offline");
      return files.get(file) ?? null;
    },
    write: async (_id, file, text) => {
      files.set(file, text);
    },
    note: async (_id, summary) => {
      notes.push(summary);
    },
    tell: async (threadId, text) => {
      if (busy) return "busy";
      told.push({ threadId, text });
      return "told";
    },
    ownName: async () => "uno-work",
    ownBoxId: async () => 7,
    nowMs: () => now,
    newId: () => `cr_${++n}`,
  });
  const ask = (computer = mac(online)) =>
    out.ask({
      computer,
      threadId: "cloud-thread",
      threadTitle: "Bakery site",
      runtimeMode: "full-access",
      cwd: "~/projects/bakery",
      title: "Check the order form",
      gist: "Run the site locally",
      brief: "Open the project and place a test order.",
    });
  const answer = (id: string, over: Partial<ChatRequestAnswer>) =>
    files.set(
      remotePaths.answer(id),
      JSON.stringify({
        v: 1,
        id,
        status: "waiting",
        reason: null,
        updatedAt: new Date(now).toISOString(),
        decidedAt: null,
        thread: null,
        ...over,
      } satisfies ChatRequestAnswer),
    );
  return {
    out,
    ask,
    files,
    told,
    notes,
    answer,
    setNow: (value: number) => (now = value),
    setOnline: (value: boolean) => (online = value),
    setBusy: (value: boolean) => (busy = value),
  };
}

describe("asking to start a chat on the person's computer", () => {
  it("writes the request there and waits", async () => {
    const t = setup();
    const result = await t.ask();
    expect(result.status).toBe("waiting");
    const written = JSON.parse(t.files.get(remotePaths.request("cr_1"))!);
    expect(written).toMatchObject({
      v: 1,
      id: "cr_1",
      from: {
        computerName: "uno-work",
        boxId: 7,
        threadId: "cloud-thread",
        threadTitle: "Bakery site",
      },
      runtimeMode: "full-access",
      cwd: "~/projects/bakery",
    });
    expect(Date.parse(written.expiresAt) - Date.parse(written.createdAt)).toBe(
      CHAT_REQUEST_WAIT_MS,
    );
    expect(t.notes[0]).toContain("Asked to start a chat");
  });

  it("is refused at once when turned off there", async () => {
    const t = setup({
      hostState: {
        v: 1,
        allow: false,
        active: 0,
        limit: 2,
        seenAt: new Date(T0).toISOString(),
        app: "x",
      },
    });
    const result = await t.ask();
    expect(result.status).toBe("refused");
    expect(result.reason).toContain("turned off");
    expect(t.files.has(remotePaths.request("cr_1"))).toBe(false);
    // Said in the tool's answer; not again as a note.
    await t.out.tick();
    expect(t.told).toHaveLength(0);
  });

  it("is refused at once when 2 are active there", async () => {
    const t = setup({
      hostState: {
        v: 1,
        allow: true,
        active: 2,
        limit: 2,
        seenAt: new Date(T0).toISOString(),
        app: "x",
      },
    });
    expect((await t.ask()).status).toBe("refused");
  });

  it("is refused when Uno Work there doesn't know requests", async () => {
    const t = setup({ hostState: null });
    const result = await t.ask();
    expect(result.status).toBe("refused");
    expect(result.reason).toBe(OUT_REASONS.oldApp("Misha's MacBook"));
  });

  it("waits here while the computer sleeps, goes when it wakes, expires after 2 h", async () => {
    const t = setup({ online: false });
    expect((await t.ask()).status).toBe("queued");
    t.setOnline(true);
    await t.out.tick();
    expect(t.files.has(remotePaths.request("cr_1"))).toBe(true);

    const later = setup({ online: false });
    await later.ask();
    later.setNow(T0 + CHAT_REQUEST_WAIT_MS + 1);
    await later.out.tick();
    expect(later.told[0]?.text).toContain("expired");
    expect(later.told[0]?.text).toContain("asleep or offline");
  });
});

describe("hearing back", () => {
  it("tells the chat it started, then the chat's answer, once each", async () => {
    const t = setup();
    await t.ask();
    t.answer("cr_1", {
      status: "started",
      decidedAt: new Date(T0).toISOString(),
      thread: {
        threadId: "t1",
        title: "Check the order form",
        state: "running",
        lastMessage: null,
        updatedAt: new Date(T0).toISOString(),
      },
    });
    await t.out.tick();
    await t.out.tick();
    expect(t.told).toHaveLength(1);
    expect(t.told[0]?.text).toContain("pressed Start");

    t.answer("cr_1", {
      status: "started",
      thread: {
        threadId: "t1",
        title: "Check the order form",
        state: "done",
        lastMessage: "The form works.",
        updatedAt: new Date(T0 + 1000).toISOString(),
      },
    });
    await t.out.tick();
    await t.out.tick();
    expect(t.told).toHaveLength(2);
    expect(t.told[1]?.text).toContain("The form works.");
    expect(t.told[1]?.text).toContain("not the person's words");

    const [view] = await t.out.lookup({ threadId: "cloud-thread" });
    expect(view).toMatchObject({
      status: "started",
      chat: { state: "done", lastAnswer: "The form works." },
    });
  });

  it("waits for a busy chat before telling it", async () => {
    const t = setup();
    await t.ask();
    t.answer("cr_1", {
      status: "declined",
      reason: "The person declined it.",
      decidedAt: new Date(T0).toISOString(),
    });
    t.setBusy(true);
    await t.out.tick();
    expect(t.told).toHaveLength(0);
    t.setBusy(false);
    await t.out.tick();
    expect(t.told[0]?.text).toContain("was declined: The person declined it.");
  });

  it("gives up on one never picked up there", async () => {
    const t = setup();
    await t.ask();
    t.setNow(T0 + CHAT_REQUEST_WAIT_MS + PICKUP_GRACE_MS + 1);
    await t.out.tick();
    expect(t.told[0]?.text).toContain("didn't pick it up");
  });

  it("shows only this chat's requests", async () => {
    const t = setup();
    await t.ask();
    expect(await t.out.lookup({ threadId: "another" })).toEqual([]);
    expect(await t.out.lookup({ threadId: "cloud-thread", requestId: "cr_1" })).toHaveLength(1);
  });
});
