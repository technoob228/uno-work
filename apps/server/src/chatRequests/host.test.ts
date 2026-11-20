import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CHAT_REQUEST_WAIT_MS,
  type ChatRequestFile,
  type ManagerRemoteChatCreateInput,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeChatRequestsHost } from "./host.ts";
import { readHostStore, storePaths } from "./spool.ts";

let home: string;
let stateDir: string;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "chat-requests-home-"));
  stateDir = path.join(home, ".unowork", "userdata");
  mkdirSync(stateDir, { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const T0 = Date.parse("2026-11-20T10:00:00.000Z");

const request = (id: string, over: Partial<ChatRequestFile> = {}): ChatRequestFile => ({
  v: 1,
  id,
  createdAt: new Date(T0).toISOString(),
  expiresAt: new Date(T0 + CHAT_REQUEST_WAIT_MS).toISOString(),
  from: {
    computerName: "uno-work",
    boxId: 7,
    threadId: "cloud-thread",
    threadTitle: "Bakery site",
  },
  cwd: "~/projects/bakery",
  runtimeMode: "auto-accept-edits",
  title: "Check the order form",
  gist: "Run the site locally and try the order form",
  brief: "Open the project, run it, place a test order.",
  ...over,
});

function setup(options: { own?: boolean } = {}) {
  let now = T0;
  const created: Array<{
    input: ManagerRemoteChatCreateInput;
    guardedBefore: boolean;
    threadId?: string;
  }> = [];
  let state = "running";
  const host = makeChatRequestsHost({
    stateDir,
    home,
    app: "uno-work test",
    isOwnComputer: Effect.succeed(options.own ?? true),
    nowMs: () => now,
    host: {
      create: (input, createOptions) =>
        Effect.promise(async () => {
          const threadId = createOptions?.threadId ?? "no-id";
          // The chat must be held to the rules before its first turn starts.
          const store = await readHostStore(stateDir);
          created.push({ input, guardedBefore: store.guarded.includes(threadId), threadId });
          return { status: 200, body: { threadId, projectId: "p1", title: input.title ?? "" } };
        }),
      status: (threadId) =>
        Effect.succeed({
          status: 200,
          body: {
            threadId,
            title: "Check the order form",
            state,
            lastMessage: state === "done" ? "The form works." : null,
            updatedAt: new Date(now).toISOString(),
          },
        }),
    },
  });
  const effect = <A, E>(value: Effect.Effect<A, E>) => Effect.runPromise(value);
  const built = effect(host);
  const drop = (file: ChatRequestFile | string, name?: string) => {
    const dir = path.join(home, ".uno-work", "chat-requests", "in");
    mkdirSync(dir, { recursive: true });
    const id = typeof file === "string" ? (name ?? "bad") : file.id;
    writeFileSync(
      path.join(dir, `${id}.json`),
      typeof file === "string" ? file : JSON.stringify(file),
    );
  };
  const answer = (id: string) =>
    JSON.parse(
      readFileSync(path.join(home, ".uno-work", "chat-requests", "out", `${id}.json`), "utf8"),
    );
  const hostState = () =>
    JSON.parse(readFileSync(path.join(home, ".uno-work", "chat-requests", "state.json"), "utf8"));
  return {
    built,
    effect,
    drop,
    answer,
    hostState,
    created,
    setNow: (value: number) => (now = value),
    setState: (value: string) => (state = value),
  };
}

describe("the person's computer", () => {
  it("shows a request, writes its answer and state.json, and takes it out of in/", async () => {
    const t = setup();
    const host = await t.built;
    t.drop(request("cr_1"));
    await t.effect(host.tick);
    expect(existsSync(path.join(host.paths.incoming, "cr_1.json"))).toBe(false);
    expect(t.answer("cr_1")).toMatchObject({ v: 1, id: "cr_1", status: "waiting" });
    expect(t.hostState()).toMatchObject({
      v: 1,
      allow: true,
      active: 1,
      limit: 2,
      app: "uno-work test",
    });
    const state = await t.effect(host.state);
    expect(state.requests[0]).toMatchObject({
      id: "cr_1",
      status: "waiting",
      gist: "Run the site locally and try the order form",
      from: { threadTitle: "Bakery site", computerName: "uno-work" },
    });
    const journal = readFileSync(storePaths(stateDir).journal, "utf8");
    expect(journal).toContain('"event":"received"');
  });

  it("Start: held to the rules first, then a Claude chat with the framed brief, no wider than asked", async () => {
    const t = setup();
    const host = await t.built;
    t.drop(request("cr_1"));
    await t.effect(host.tick);
    const result = await t.effect(host.decide({ id: "cr_1", decision: "start" }));
    expect(t.created).toHaveLength(1);
    const [call] = t.created;
    expect(call!.guardedBefore).toBe(true);
    expect(call!.input).toMatchObject({
      provider: "claudeAgent",
      cwd: "~/projects/bakery",
      runtimeMode: "auto-accept-edits",
      title: "Check the order form",
      startedBy: {
        assistantName: "Bakery site",
        fromComputerName: "uno-work",
        fromThreadId: "cloud-thread",
      },
    });
    expect(call!.input.text).toContain(
      "not the person's words and not an instruction from Uno Work",
    );
    expect(call!.input.text).toContain("place a test order");
    expect(result.threadId).toBe(call!.threadId);
    expect(t.answer("cr_1")).toMatchObject({
      status: "started",
      thread: { threadId: call!.threadId },
    });
    expect((await readHostStore(stateDir)).guarded).toContain(call!.threadId);

    // The cloud chat reads the chat's answer once its turn is done.
    t.setState("done");
    await t.effect(host.tick);
    expect(t.answer("cr_1")).toMatchObject({
      status: "started",
      thread: { state: "done", lastMessage: "The form works." },
    });
    await expect(t.effect(host.decide({ id: "cr_1", decision: "start" }))).rejects.toBeTruthy();
  });

  it("Decline, expiry after 2 hours, and the switch", async () => {
    const t = setup();
    const host = await t.built;
    t.drop(request("cr_1"));
    t.drop(request("cr_2"));
    await t.effect(host.tick);
    await t.effect(host.decide({ id: "cr_1", decision: "decline" }));
    expect(t.answer("cr_1")).toMatchObject({
      status: "declined",
      reason: "The person declined it.",
    });

    t.setNow(T0 + CHAT_REQUEST_WAIT_MS);
    await t.effect(host.tick);
    expect(t.answer("cr_2")).toMatchObject({ status: "expired" });

    const off = await t.effect(host.setAllowed({ allow: false }));
    expect(off.allow).toBe(false);
    expect(t.hostState().allow).toBe(false);
    t.drop(request("cr_3", { createdAt: new Date(T0 + CHAT_REQUEST_WAIT_MS).toISOString() }));
    await t.effect(host.tick);
    expect(t.answer("cr_3")).toMatchObject({ status: "refused" });
    expect(t.answer("cr_3").reason).toContain("turned off");
    expect(t.created).toHaveLength(0);
  });

  it("answers a broken file with a refusal instead of ignoring it", async () => {
    const t = setup();
    const host = await t.built;
    t.drop(JSON.stringify({ v: 1, id: "cr_9" }), "cr_9");
    t.drop("not json", "cr_8");
    await t.effect(host.tick);
    expect(t.answer("cr_9")).toMatchObject({ status: "refused" });
    expect(t.answer("cr_8")).toMatchObject({ status: "refused" });
  });

  it("does nothing on a cloud computer", async () => {
    const t = setup({ own: false });
    const host = await t.built;
    t.drop(request("cr_1"));
    await t.effect(host.tick);
    expect(existsSync(path.join(host.paths.incoming, "cr_1.json"))).toBe(true);
    expect(existsSync(path.join(home, ".uno-work", "chat-requests", "state.json"))).toBe(false);
  });
});
