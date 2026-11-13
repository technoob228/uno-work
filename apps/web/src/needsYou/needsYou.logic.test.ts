import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { SidebarThreadSummary } from "../types";
import type { ExternalAsk } from "./externalAsks";
import { buildNeedsYouBoard, needsYouVerdict, quietLine } from "./needsYou.logic";

const NOW = "2026-11-13T12:00:00.000Z";

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

const question: ExternalAsk = {
  kind: "question",
  id: "q1",
  from: "Pricing page",
  createdAt: "2026-11-13T11:00:00.000Z",
  title: "Raise Plus to $12?",
  options: ["Yes", "No"],
};

const input = (threads: SidebarThreadSummary[], asks: ExternalAsk[] = []) => ({
  threads,
  asks,
  answered: {},
  skippedQuestions: new Set<string>(),
  now: NOW,
});

describe("buildNeedsYouBoard", () => {
  it("nothing waits: not needed, the running chats in the quiet line", () => {
    const board = buildNeedsYouBoard(input([summary("a", { session: running })]));
    expect(board.count).toBe(0);
    expect(needsYouVerdict(board)).toBe("You're not needed right now");
    expect(quietLine(board)).toBe("1 chat working — without you");
  });

  it("approvals, questions and tracker asks are to decide; minutes add up", () => {
    const board = buildNeedsYouBoard(
      input(
        [
          summary("approve", { hasPendingApprovals: true }),
          summary("ask", { hasPendingUserInput: true }),
        ],
        [question],
      ),
    );
    expect(board.sections.map((s) => [s.section, s.rows.length])).toEqual([["decide", 3]]);
    expect(needsYouVerdict(board)).toBe("You're needed in 3 places · about 3 min");
  });

  it("a question skipped for now stays out; an answered ask leaves the count", () => {
    const board = buildNeedsYouBoard({
      ...input([summary("ask", { hasPendingUserInput: true })], [question]),
      skippedQuestions: new Set(["env:ask"]),
      answered: { q1: { kind: "option", option: "Yes" } },
    });
    expect(board.count).toBe(0);
    expect(board.answered).toBe(1);
  });

  it("a task names its coordinator; archived and imported chats never count", () => {
    const board = buildNeedsYouBoard(
      input([
        summary("coord", { title: "Pricing page" }),
        summary("task", { spawnedByThreadId: ThreadId.make("coord"), hasPendingApprovals: true }),
        summary("old", { hasPendingApprovals: true, archivedAt: NOW }),
      ]),
    );
    expect(board.count).toBe(1);
    expect(board.sections[0]?.rows[0]?.where).toBe("task of “Pricing page”");
  });
});
