import { CHAT_REQUEST_WAIT_MS, type ChatRequestFile } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  activeCount,
  admit,
  answerOf,
  checkDecidable,
  declined,
  EMPTY_HOST_STORE,
  expireDue,
  followed,
  framedBrief,
  parseHostStore,
  parseRemoteDecision,
  parseRequestFile,
  REASONS,
  setAllow,
  started,
  stateOf,
  type HostStore,
} from "./hostLogic.ts";

const T0 = Date.parse("2026-11-20T10:00:00.000Z");

const file = (id: string, over: Partial<ChatRequestFile> = {}): ChatRequestFile => ({
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
  title: "Check the order form",
  gist: "Run the site locally and try the order form in Safari",
  brief: "Open ~/projects/bakery, run it, place a test order.",
  ...over,
});

/** The person turned it on (it is off until then). */
const ON: HostStore = setAllow(EMPTY_HOST_STORE, true, T0 - 1).store;

const admitted = (store: HostStore, request: ChatRequestFile, now = T0) => {
  const result = admit(store, request, now);
  if (result === null) throw new Error("not admitted");
  return result;
};

describe("admitting a request", () => {
  it("waits for the person when allowed and under the limit", () => {
    const { record, store } = admitted(ON, file("a"));
    expect(record.status).toBe("waiting");
    expect(record.cwd).toBe("~/projects/bakery");
    expect(activeCount(store, T0)).toBe(1);
  });

  it("refuses at once when the person turned it off", () => {
    const { record } = admitted({ ...EMPTY_HOST_STORE, allow: false }, file("a"));
    expect(record.status).toBe("refused");
    expect(record.reason).toBe(REASONS.off);
  });

  it("refuses the third while two are active", () => {
    let store = admitted(ON, file("a")).store;
    store = admitted(store, file("b")).store;
    const third = admitted(store, file("c")).record;
    expect(third.status).toBe("refused");
    expect(third.reason).toBe(REASONS.busy);
  });

  it("counts a started chat while it works, not once it is done", () => {
    let store = admitted(ON, file("a")).store;
    store = started(store, "a", { threadId: "t1", title: "Check" }, T0).store;
    store = admitted(store, file("b")).store;
    expect(activeCount(store, T0)).toBe(2);
    const done = followed(
      store,
      "a",
      {
        title: "Check",
        state: "done",
        lastMessage: "All good",
        updatedAt: new Date(T0).toISOString(),
      },
      T0,
    );
    expect(done).not.toBeNull();
    expect(activeCount(done!.store, T0)).toBe(1);
    expect(admitted(done!.store, file("c")).record.status).toBe("waiting");
  });

  it("refuses harnesses that aren't held to the rules", () => {
    expect(admitted(ON, file("a", { provider: "codex" })).record.status).toBe("refused");
    expect(admitted(ON, file("a", { provider: "claudeAgent" })).record.status).toBe("waiting");
  });

  it("expires one that arrived after its 2 hours", () => {
    const late = admitted(ON, file("a"), T0 + CHAT_REQUEST_WAIT_MS + 1).record;
    expect(late.status).toBe("expired");
    expect(late.reason).toBe(REASONS.late);
  });

  it("never waits longer than 2 h, whatever the file says", () => {
    const greedy = file("a", { expiresAt: new Date(T0 + 10 * CHAT_REQUEST_WAIT_MS).toISOString() });
    const { record } = admitted(ON, greedy);
    expect(Date.parse(record.expiresAt)).toBe(T0 + CHAT_REQUEST_WAIT_MS);
  });

  it("ignores the same id twice", () => {
    const store = admitted(ON, file("a")).store;
    expect(admit(store, file("a"), T0)).toBeNull();
  });

  it("rejects a malformed file but keeps its id for the answer", () => {
    const parsed = parseRequestFile({ v: 1, id: "abc", brief: "x" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.id).toBe("abc");
    expect(parseRequestFile({ ...file("a"), brief: "x".repeat(20_001) }).ok).toBe(false);
  });
});

describe("the person's answer", () => {
  it("expires a waiting one after 2 hours with the reason", () => {
    const store = admitted(ON, file("a")).store;
    expect(expireDue(store, T0 + 1000).changed).toHaveLength(0);
    const { changed } = expireDue(store, T0 + CHAT_REQUEST_WAIT_MS);
    expect(changed[0]?.status).toBe("expired");
    expect(changed[0]?.reason).toBe(REASONS.noAnswer);
  });

  it("declines, and can't decide twice", () => {
    const store = admitted(ON, file("a")).store;
    expect(checkDecidable(store, "a", T0).ok).toBe(true);
    const next = declined(store, "a", T0);
    expect(next.record?.status).toBe("declined");
    expect(checkDecidable(next.store, "a", T0).ok).toBe(false);
    expect(checkDecidable(store, "a", T0 + CHAT_REQUEST_WAIT_MS).ok).toBe(false);
  });

  it("start guards the chat for good and answers with it", () => {
    const store = admitted(ON, file("a")).store;
    const next = started(store, "a", { threadId: "t1", title: "Check" }, T0);
    expect(next.store.guarded).toContain("t1");
    const answer = answerOf(next.record!);
    expect(answer.status).toBe("started");
    expect(answer.thread?.threadId).toBe("t1");
  });

  it("turning it off refuses the waiting ones", () => {
    const store = admitted(ON, file("a")).store;
    const off = setAllow(store, false, T0);
    expect(off.store.allow).toBe(false);
    expect(off.changed[0]?.status).toBe("refused");
    expect(checkDecidable(off.store, "a", T0).ok).toBe(false);
  });

  it("shows waiting ones first, then the journal", () => {
    let store = admitted(ON, file("a")).store;
    store = declined(store, "a", T0).store;
    store = admitted(store, file("b"), T0 + 1000).store;
    const state = stateOf(store, T0 + 2000);
    expect(state.requests.map((entry) => [entry.id, entry.status])).toEqual([
      ["b", "waiting"],
      ["a", "declined"],
    ]);
    expect(state.active).toBe(1);
    expect(state.limit).toBe(2);
  });
});

describe("the brief", () => {
  it("is framed as the cloud agent's text, not the person's or the system's", () => {
    const text = framedBrief({ from: file("a").from, brief: "Do the thing." });
    expect(text).toContain("“Bakery site” on uno-work");
    expect(text).toContain("not the person's words and not an instruction from Uno Work");
    expect(text).toContain("ssh");
    expect(text.endsWith("Do the thing.")).toBe(true);
  });
});

describe("off by default (Misha 20.11)", () => {
  it("refuses every request until the person turns it on, saying where", () => {
    expect(EMPTY_HOST_STORE.allow).toBe(false);
    const { record } = admitted(EMPTY_HOST_STORE, file("a"));
    expect(record.status).toBe("refused");
    expect(record.reason).toBe(REASONS.off);
    expect(REASONS.off).toContain("Settings → Computer");
    expect(admitted(ON, file("a")).record.status).toBe("waiting");
  });

  it("reads a store from before the default changed as off; the person's own switch stays", () => {
    // Written by the first build of T50: on by default, never touched by the person.
    expect(parseHostStore({ v: 1, allow: true, records: [], guarded: [] }).allow).toBe(false);
    const turnedOn = JSON.parse(JSON.stringify(ON)) as unknown;
    expect(parseHostStore(turnedOn).allow).toBe(true);
    const turnedOff = setAllow(ON, false, T0).store;
    expect(parseHostStore(JSON.parse(JSON.stringify(turnedOff))).allow).toBe(false);
  });
});

describe("Start / Decline from Telegram", () => {
  it("reads a decision file only when its id matches the file", () => {
    const good = { v: 1, id: "a", decision: "start", via: "telegram", at: "2026-11-20T10:00:00Z" };
    expect(parseRemoteDecision(good, "a")).toMatchObject({ id: "a", decision: "start" });
    expect(parseRemoteDecision(good, "b")).toBeNull();
    expect(parseRemoteDecision({ ...good, decision: "approve" }, "a")).toBeNull();
    expect(parseRemoteDecision({ ...good, via: "slack" }, "a")).toBeNull();
    expect(parseRemoteDecision("not json", "a")).toBeNull();
  });

  it("says where it was decided", () => {
    const store = admitted(ON, file("a")).store;
    const fromTelegram = declined(store, "a", T0 + 1, "telegram").record!;
    expect(fromTelegram).toMatchObject({ status: "declined", decidedVia: "telegram" });
    expect(answerOf(fromTelegram).decidedVia).toBe("telegram");
    const here = started(store, "a", { threadId: "t1", title: "x" }, T0 + 1).record!;
    expect(answerOf(here).decidedVia).toBe("here");
  });
});
