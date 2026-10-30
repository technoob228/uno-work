import { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dispatchCommand = vi.fn((_command: unknown) => Promise.resolve({ sequence: 1 }));
vi.mock("./environmentApi", () => ({
  readEnvironmentApi: () => ({ orchestration: { dispatchCommand } }),
}));

const { installThreadReadStateSync, mergeServerThreadReadState, resetThreadReadStateSyncForTests } =
  await import("./threadReadStateSync");
const { useUiStateStore } = await import("./uiStateStore");
const { useStore } = await import("./store");
const { readThreadReadAt, writeThreadReadAt } = await import("./threadReadMarks");

const ENV = EnvironmentId.make("env-1");
const key = (id: string) => `${ENV}:${id}`;
const T1 = "2026-10-29T10:00:01.000Z";
const T2 = "2026-10-29T10:00:02.000Z";
const T3 = "2026-10-29T10:00:03.000Z";
const T4 = "2026-10-29T10:00:04.000Z";
const turn = {
  turnId: TurnId.make("turn"),
  state: "completed" as const,
  requestedAt: T1,
  startedAt: T1,
  completedAt: T2,
  assistantMessageId: null,
};
const shell = (
  id: string,
  lastVisitedAt: string | null,
  extra: { readAt?: string | null; readStateUpdatedAt?: string | null } = {},
) => ({
  id: ThreadId.make(id),
  lastVisitedAt,
  readAt: extra.readAt ?? null,
  readStateUpdatedAt: extra.readStateUpdatedAt ?? null,
  latestTurn: turn,
});
const commands = () => dispatchCommand.mock.calls.map((call) => call[0] as { type: string });

describe("thread read state ↔ server", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    dispatchCommand.mockClear();
    resetThreadReadStateSyncForTests();
    useUiStateStore.setState({ threadLastVisitedAtById: {} });
    installThreadReadStateSync();
  });
  afterEach(() => vi.useRealTimers());

  it("takes only newer server visits, in one store write", () => {
    useUiStateStore.setState({ threadLastVisitedAtById: { [key("a")]: T3, [key("b")]: T1 } });
    let writes = 0;
    const unsubscribe = useUiStateStore.subscribe(() => (writes += 1));
    mergeServerThreadReadState(ENV, [
      shell("a", T2),
      shell("b", T2),
      shell("c", T3),
      shell("d", null),
    ]);
    unsubscribe();
    expect(writes).toBe(1);
    expect(useUiStateStore.getState().threadLastVisitedAtById).toEqual({
      [key("a")]: T3, // local newer: kept
      [key("b")]: T2, // server newer: taken
      [key("c")]: T3, // only on the server: taken
    });
  });

  it("an unchanged snapshot costs no store write and sends nothing", async () => {
    useUiStateStore.setState({ threadLastVisitedAtById: { [key("a")]: T2, [key("e")]: T3 } });
    let writes = 0;
    const unsubscribe = useUiStateStore.subscribe(() => (writes += 1));
    const unsubscribeStore = useStore.subscribe(() => (writes += 1));
    mergeServerThreadReadState(ENV, [shell("a", T2), shell("b", null), shell("e", null)]);
    unsubscribe();
    unsubscribeStore();
    expect(writes).toBe(0);
    await vi.advanceTimersByTimeAsync(700);
    expect(dispatchCommand).not.toHaveBeenCalled(); // no backfill of local (seeded) marks
  });

  it("opening a chat writes to the server in the background, debounced", async () => {
    useUiStateStore.getState().markThreadVisited(key("a"), T1);
    useUiStateStore.getState().markThreadVisited(key("a"), T2);
    expect(useUiStateStore.getState().threadLastVisitedAtById[key("a")]).toBe(T2);
    expect(dispatchCommand).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(700);
    expect(commands()).toEqual([expect.objectContaining({ type: "thread.visit", visitedAt: T2 })]);
  });

  it("a late echo of an older visit does not flip a chat marked unread back to read", async () => {
    useUiStateStore.setState({ threadLastVisitedAtById: { [key("a")]: T3 } });
    useUiStateStore.getState().markThreadUnread(key("a"), T2);
    const unread = useUiStateStore.getState().threadLastVisitedAtById[key("a")];
    mergeServerThreadReadState(ENV, [shell("a", T3, { readStateUpdatedAt: T3 })]);
    expect(useUiStateStore.getState().threadLastVisitedAtById[key("a")]).toBe(unread);
    await vi.advanceTimersByTimeAsync(700);
    expect(commands()[0]).toMatchObject({ type: "thread.mark-unread" });
    // The real echo (unread on the server) replaces the stale one; after the
    // chat settles it is applied and keeps the chat unread.
    mergeServerThreadReadState(ENV, [shell("a", null, { readStateUpdatedAt: T4 })]);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(useUiStateStore.getState().threadLastVisitedAtById[key("a")]).toBe(unread);
  });

  it("mark unread on the phone reaches Work: dot back and Your turn back", () => {
    useUiStateStore.setState({ threadLastVisitedAtById: { [key("p")]: T3 } });
    const ref = scopeThreadRef(ENV, ThreadId.make("p"));
    writeThreadReadAt(ENV, "p", T3);
    mergeServerThreadReadState(ENV, [shell("p", T3, { readAt: T3, readStateUpdatedAt: T3 })]);
    mergeServerThreadReadState(ENV, [shell("p", null, { readAt: null, readStateUpdatedAt: T4 })]);
    expect(useUiStateStore.getState().threadLastVisitedAtById[key("p")]).toBe(
      new Date(Date.parse(T2) - 1).toISOString(),
    );
    expect(readThreadReadAt(ref.environmentId, ref.threadId)).toBeNull();
  });

  it("Read pressed on another device reaches Work once", () => {
    let writes = 0;
    const unsubscribe = useStore.subscribe(() => (writes += 1));
    mergeServerThreadReadState(ENV, [shell("r", T3, { readAt: T3, readStateUpdatedAt: T3 })]);
    expect(readThreadReadAt(ENV, "r")).toBe(T3);
    // The same decision again (any later upsert of that chat): nothing to do.
    writeThreadReadAt(ENV, "r", null);
    mergeServerThreadReadState(ENV, [shell("r", T3, { readAt: T3, readStateUpdatedAt: T3 })]);
    expect(readThreadReadAt(ENV, "r")).toBeNull();
    unsubscribe();
    expect(writes).toBeLessThanOrEqual(1);
  });

  it("Read in Work goes to the server and its echo changes nothing", async () => {
    const ref = scopeThreadRef(ENV, ThreadId.make("w"));
    useUiStateStore.setState({ threadLastVisitedAtById: { [key("w")]: T2 } });
    useStore.getState().setThreadReadAt(ref, T3);
    expect(useUiStateStore.getState().threadLastVisitedAtById[key("w")]).toBe(T3);
    await vi.advanceTimersByTimeAsync(700);
    expect(commands()).toEqual([expect.objectContaining({ type: "thread.read", readAt: T3 })]);
    let writes = 0;
    const unsubscribe = useUiStateStore.subscribe(() => (writes += 1));
    const unsubscribeStore = useStore.subscribe(() => (writes += 1));
    mergeServerThreadReadState(ENV, [shell("w", T3, { readAt: T3, readStateUpdatedAt: T4 })]);
    await vi.advanceTimersByTimeAsync(6_000);
    unsubscribe();
    unsubscribeStore();
    expect(writes).toBe(0);
  });

  it("Mark unread in Work sends one mark-unread", async () => {
    const ref = scopeThreadRef(ENV, ThreadId.make("u"));
    useUiStateStore.setState({ threadLastVisitedAtById: { [key("u")]: T3 } });
    useStore.getState().setThreadReadAt(ref, null);
    useUiStateStore.getState().markThreadUnread(key("u"), T2);
    await vi.advanceTimersByTimeAsync(700);
    expect(commands()).toEqual([expect.objectContaining({ type: "thread.mark-unread" })]);
  });
});
