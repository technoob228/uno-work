import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { withChildChatWork } from "./childChatWork";
import type { SidebarThreadSummary } from "./types";

const summary = (
  id: string,
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary => ({
  id: ThreadId.make(id),
  environmentId: EnvironmentId.make("env"),
  projectId: ProjectId.make("p"),
  title: id,
  interactionMode: "default",
  session: null,
  createdAt: "2026-11-13T10:00:00.000Z",
  archivedAt: null,
  pinnedAt: null,
  latestTurn: null,
  branch: null,
  worktreePath: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

const running = {
  provider: "codex",
  status: "running",
  createdAt: "x",
  updatedAt: "x",
  orchestrationStatus: "running",
} as unknown as SidebarThreadSummary["session"];

const byId = (...rows: SidebarThreadSummary[]) =>
  Object.fromEntries(rows.map((row) => [row.id, row])) as Record<ThreadId, SidebarThreadSummary>;

describe("withChildChatWork", () => {
  it("folds the chats a chat started onto it: how many still go, the newest start", () => {
    const parent = ThreadId.make("parent");
    const out = withChildChatWork(
      byId(
        summary("parent"),
        summary("a", { spawnedByThreadId: parent, session: running }),
        summary("b", {
          spawnedByThreadId: parent,
          hasPendingApprovals: true,
          createdAt: "2026-11-13T11:00:00.000Z",
        }),
        summary("c", { spawnedByThreadId: parent, archivedAt: "2026-11-13T12:00:00.000Z" }),
        summary("lonely"),
      ),
    );
    expect(out[parent]?.childWork).toEqual({
      working: 2,
      latestStartedAt: "2026-11-13T11:00:00.000Z",
    });
    expect(out[ThreadId.make("lonely")]?.childWork).toBeUndefined();
  });

  it("keeps the same record when nothing changed", () => {
    const parent = ThreadId.make("parent");
    const once = withChildChatWork(
      byId(summary("parent"), summary("a", { spawnedByThreadId: parent })),
    );
    expect(withChildChatWork(once)).toBe(once);
    const unrelated = withChildChatWork(byId(summary("x")));
    expect(withChildChatWork(unrelated)).toBe(unrelated);
  });

  it("drops it when the children are gone", () => {
    const parent = ThreadId.make("parent");
    const once = withChildChatWork(
      byId(summary("parent"), summary("a", { spawnedByThreadId: parent })),
    );
    const { [ThreadId.make("a")]: _gone, ...rest } = once;
    expect(withChildChatWork(rest as typeof once)[parent]?.childWork).toBeUndefined();
  });
});
