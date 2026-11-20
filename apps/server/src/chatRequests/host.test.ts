import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  existsSync,
} from "node:fs";
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

function setup(options: { own?: boolean; allow?: boolean } = {}) {
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
  // Off by default: the person turned it on (the off case is its own test).
  const built = effect(host).then(async (shape) => {
    if (options.allow !== false && options.own !== false)
      await effect(shape.setAllowed({ allow: true }));
    return shape;
  });
  const drop = (file: ChatRequestFile | string, name?: string) => {
    const dir = path.join(home, ".uno-work", "chat-requests", "in");
    mkdirSync(dir, { recursive: true });
    const id = typeof file === "string" ? (name ?? "bad") : file.id;
    writeFileSync(
      path.join(dir, `${id}.json`),
      typeof file === "string" ? file : JSON.stringify(file),
    );
  };
  /** Start / Decline pressed in Telegram, as the cloud side writes it; landed `writtenAt`. */
  const press = (id: string, decision: "start" | "decline", writtenAt = now) => {
    const dir = path.join(home, ".uno-work", "chat-requests", "decisions");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.json`);
    writeFileSync(
      file,
      JSON.stringify({ v: 1, id, decision, via: "telegram", at: new Date(now).toISOString() }),
    );
    utimesSync(file, writtenAt / 1000, writtenAt / 1000);
    return file;
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
    press,
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
    expect(t.answer("cr_3").reason).toContain("Settings → Computer");
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

  it("off by default: a request is refused at once with where to turn it on", async () => {
    const t = setup({ allow: false });
    const host = await t.built;
    t.drop(request("cr_1"));
    await t.effect(host.tick);
    expect(t.answer("cr_1")).toMatchObject({ status: "refused" });
    expect(t.answer("cr_1").reason).toContain("Settings → Computer");
    expect(t.hostState().allow).toBe(false);
    expect((await t.effect(host.state)).allow).toBe(false);
  });
});

describe("Start / Decline pressed in the person's Telegram", () => {
  it("Start from Telegram starts the chat here like the app's button, and says so", async () => {
    const t = setup();
    const host = await t.built;
    t.drop(request("cr_1"));
    await t.effect(host.tick);
    const file = t.press("cr_1", "start");
    await t.effect(host.tick);
    expect(existsSync(file)).toBe(false);
    expect(t.created).toHaveLength(1);
    expect(t.created[0]!.guardedBefore).toBe(true);
    expect(t.answer("cr_1")).toMatchObject({ status: "started", decidedVia: "telegram" });
    const state = await t.effect(host.state);
    expect(state.requests[0]).toMatchObject({ status: "started", decidedVia: "telegram" });
  });

  it("the first decision wins: Decline here, then Start from Telegram does nothing", async () => {
    const t = setup();
    const host = await t.built;
    t.drop(request("cr_1"));
    await t.effect(host.tick);
    await t.effect(host.decide({ id: "cr_1", decision: "decline" }));
    t.press("cr_1", "start");
    await t.effect(host.tick);
    expect(t.created).toHaveLength(0);
    expect(t.answer("cr_1")).toMatchObject({ status: "declined", decidedVia: "here" });
    const journal = readFileSync(storePaths(stateDir).journal, "utf8");
    expect(journal).toContain('"event":"telegram-dropped"');
    expect(journal).toContain("already declined");
  });

  it("…and Start from Telegram first: Start here then says it is already started", async () => {
    const t = setup();
    const host = await t.built;
    t.drop(request("cr_1"));
    await t.effect(host.tick);
    t.press("cr_1", "start");
    await t.effect(host.tick);
    await expect(t.effect(host.decide({ id: "cr_1", decision: "start" }))).rejects.toMatchObject({
      message: "That request is already started.",
    });
    expect(t.created).toHaveLength(1);
  });

  it("a press that landed while Uno Work was closed here is dropped, never run late", async () => {
    const t = setup();
    const host = await t.built;
    t.drop(request("cr_1"));
    await t.effect(host.tick);
    const file = t.press("cr_1", "start", T0 - 3 * 60 * 1000);
    await t.effect(host.tick);
    expect(existsSync(file)).toBe(false);
    expect(t.created).toHaveLength(0);
    expect(t.answer("cr_1")).toMatchObject({ status: "waiting" });
  });

  it("turned off here: a press from Telegram can't start anything", async () => {
    const t = setup();
    const host = await t.built;
    t.drop(request("cr_1"));
    await t.effect(host.tick);
    await t.effect(host.setAllowed({ allow: false }));
    t.press("cr_1", "start");
    await t.effect(host.tick);
    expect(t.created).toHaveLength(0);
    expect(t.answer("cr_1")).toMatchObject({ status: "refused" });
  });

  it("Decline from Telegram", async () => {
    const t = setup();
    const host = await t.built;
    t.drop(request("cr_1"));
    await t.effect(host.tick);
    t.press("cr_1", "decline");
    await t.effect(host.tick);
    expect(t.answer("cr_1")).toMatchObject({
      status: "declined",
      decidedVia: "telegram",
      reason: "The person declined it (in Telegram).",
    });
  });
});
