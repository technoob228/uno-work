import { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dispatchCommand = vi.fn((_command: unknown) => Promise.resolve({ sequence: 1 }));
vi.mock("./environmentApi", () => ({
  readEnvironmentApi: () => ({ orchestration: { dispatchCommand } }),
}));

const { installThreadReadStateSync, mergeServerThreadReadState } = await import(
  "./threadReadStateSync"
);
const { useUiStateStore } = await import("./uiStateStore");

const ENV = EnvironmentId.make("env-1");
const key = (id: string) => `${ENV}:${id}`;
const T1 = "2026-10-29T10:00:01.000Z";
const T2 = "2026-10-29T10:00:02.000Z";
const T3 = "2026-10-29T10:00:03.000Z";
const turn = {
  turnId: TurnId.make("turn"),
  state: "completed" as const,
  requestedAt: T1,
  startedAt: T1,
  completedAt: T2,
  assistantMessageId: null,
};
const shell = (id: string, lastVisitedAt: string | null) => ({
  id: ThreadId.make(id),
  lastVisitedAt,
  latestTurn: turn,
});

describe("thread read state ↔ server", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    dispatchCommand.mockClear();
    useUiStateStore.setState({ threadLastVisitedAtById: {} });
    installThreadReadStateSync();
  });
  afterEach(() => vi.useRealTimers());

  it("takes only newer server marks, in one store write", () => {
    useUiStateStore.setState({ threadLastVisitedAtById: { [key("a")]: T3, [key("b")]: T1 } });
    let writes = 0;
    const unsubscribe = useUiStateStore.subscribe(() => (writes += 1));
    mergeServerThreadReadState(ENV, [shell("a", T2), shell("b", T2), shell("c", T3), shell("d", null)]);
    unsubscribe();
    expect(writes).toBe(1);
    expect(useUiStateStore.getState().threadLastVisitedAtById).toEqual({
      [key("a")]: T3, // local newer: kept
      [key("b")]: T2, // server newer: taken
      [key("c")]: T3, // only on the server: taken
    });
  });

  it("an unchanged snapshot costs no store write", () => {
    useUiStateStore.setState({ threadLastVisitedAtById: { [key("a")]: T2 } });
    let writes = 0;
    const unsubscribe = useUiStateStore.subscribe(() => (writes += 1));
    mergeServerThreadReadState(ENV, [shell("a", T2), shell("b", null)]);
    unsubscribe();
    expect(writes).toBe(0);
  });

  it("opening a chat writes to the server in the background, debounced", async () => {
    useUiStateStore.getState().markThreadVisited(key("a"), T1);
    useUiStateStore.getState().markThreadVisited(key("a"), T2);
    expect(useUiStateStore.getState().threadLastVisitedAtById[key("a")]).toBe(T2);
    expect(dispatchCommand).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(700);
    expect(dispatchCommand).toHaveBeenCalledTimes(1);
    expect(dispatchCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "thread.visit",
      threadId: "a",
      visitedAt: T2,
    });
  });

  it("a late echo of an older visit does not flip a chat marked unread back to read", async () => {
    useUiStateStore.setState({ threadLastVisitedAtById: { [key("a")]: T3 } });
    useUiStateStore.getState().markThreadUnread(key("a"), T2);
    const unread = useUiStateStore.getState().threadLastVisitedAtById[key("a")];
    mergeServerThreadReadState(ENV, [shell("a", T3)]);
    expect(useUiStateStore.getState().threadLastVisitedAtById[key("a")]).toBe(unread);
    await vi.advanceTimersByTimeAsync(700);
    expect(dispatchCommand.mock.calls[0]?.[0]).toMatchObject({ type: "thread.mark-unread" });
  });

  it("first sync sends local visits the server lacks", async () => {
    useUiStateStore.setState({ threadLastVisitedAtById: { [key("e")]: T3 } });
    mergeServerThreadReadState(ENV, [shell("e", null)], { backfill: true });
    await vi.advanceTimersByTimeAsync(700);
    expect(dispatchCommand.mock.calls[0]?.[0]).toMatchObject({ type: "thread.visit", visitedAt: T3 });
  });
});
