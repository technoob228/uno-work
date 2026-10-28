import { ASSISTANT_PROJECT_ID, MANAGER_WORK_STATUS_MAX_THREADS } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { assistantTokenLabel } from "@t3tools/contracts";
import { effectiveWaitTimeoutSec } from "./Layers/ManagerToolService.ts";
import {
  finishWorkStatus,
  pickRemoteWorkStatus,
  pickWorkStatusCandidates,
  remoteWorkStatusRow,
  WORK_STATUS_MAX_CHARS,
  WORK_STATUS_MAX_PERSON_THREADS,
  workStatusRow,
  type WorkStatusShell,
} from "./workStatus.ts";

const now = Date.parse("2026-10-21T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString();

const shell = (id: string, overrides: Partial<WorkStatusShell> = {}): WorkStatusShell =>
  ({
    id,
    projectId: "shop",
    title: `Chat ${id}`,
    updatedAt: hoursAgo(1),
    archivedAt: null,
    session: { status: "ready", updatedAt: hoursAgo(1) },
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  }) as WorkStatusShell;

describe("work_status", () => {
  it("lists the assistant's chats first, then the person's recent ones; old and archived out", () => {
    const { picked } = pickWorkStatusCandidates({
      own: [
        shell("own-old", { updatedAt: hoursAgo(100) }),
        shell("own-busy", { updatedAt: hoursAgo(100), hasPendingApprovals: true }),
        shell("own-new"),
      ],
      person: [
        shell("p-new"),
        shell("p-old", { updatedAt: hoursAgo(30) }),
        shell("p-arch", { archivedAt: hoursAgo(1) }),
      ],
      nowMs: now,
    });
    expect(picked.map((entry) => `${entry.startedBy}:${entry.shell.id}`)).toEqual([
      "you:own-busy",
      "you:own-new",
      "person:p-new",
    ]);
  });

  it("caps the person's chats and the total", () => {
    const person = Array.from({ length: 30 }, (_, index) => shell(`p${index}`));
    const own = Array.from({ length: 30 }, (_, index) => shell(`o${index}`));
    const onlyPerson = pickWorkStatusCandidates({ own: [], person, nowMs: now });
    expect(onlyPerson.picked).toHaveLength(WORK_STATUS_MAX_PERSON_THREADS);
    const both = pickWorkStatusCandidates({ own, person, nowMs: now });
    expect(both.picked).toHaveLength(MANAGER_WORK_STATUS_MAX_THREADS);
    expect(both.omitted).toBe(60 - MANAGER_WORK_STATUS_MAX_THREADS);
  });

  it("one row: status, running time, step and the wrapped first line of the answer", () => {
    const row = workStatusRow(
      {
        shell: shell("a", { session: { status: "running", updatedAt: hoursAgo(1) } as never }),
        startedBy: "you",
      },
      {
        projectTitle: "Shop",
        turns: [
          {
            turnId: "t" as never,
            state: "running",
            requestedAt: hoursAgo(0.5),
            startedAt: hoursAgo(0.5),
            completedAt: null,
          },
        ],
        messages: [{ role: "assistant", text: "\nRunning the tests now\nmore" }],
        activities: [{ kind: "tool.started", summary: "bun run test" }],
        reportPending: false,
      },
      now,
    );
    expect(row).toMatchObject({
      status: "running",
      runningForSec: 1_800,
      step: "bun run test",
      finishedAt: null,
    });
    expect(row.lastAnswer).toBe(
      "<untrusted_thread_output>Running the tests now</untrusted_thread_output>",
    );

    const done = workStatusRow(
      { shell: shell("b"), startedBy: "person" },
      {
        projectTitle: "Shop",
        turns: [
          {
            turnId: "t" as never,
            state: "completed",
            requestedAt: hoursAgo(2),
            startedAt: hoursAgo(2),
            completedAt: hoursAgo(1),
          },
        ],
        messages: [],
        activities: [],
        reportPending: true,
      },
      now,
    );
    expect(done).toMatchObject({
      status: "done",
      finishedAt: hoursAgo(1),
      reportPending: true,
      runningForSec: null,
    });
  });

  it("keeps the answer short: rows drop from the end", () => {
    const rows = Array.from({ length: 15 }, (_, index) =>
      workStatusRow(
        { shell: shell(`r${index}`, { title: "t".repeat(120) }), startedBy: "you" },
        {
          projectTitle: "Shop",
          turns: [],
          messages: [{ role: "assistant", text: "x".repeat(400) }],
          activities: [{ kind: "tool.started", summary: "s".repeat(200) }],
          reportPending: false,
        },
        now,
      ),
    );
    const finished = finishWorkStatus(rows, 0);
    expect(JSON.stringify(finished.threads).length).toBeLessThanOrEqual(WORK_STATUS_MAX_CHARS + 50);
    expect(finished.threads.length + finished.omitted).toBe(15);
    expect(finished.omitted).toBeGreaterThan(0);
  });
});

describe("wait_for_thread for an assistant", () => {
  const base = {
    tokenId: "t" as never,
    scopes: [],
    projectAllowlist: "all" as const,
    budget: null,
    autoApprove: true,
  };
  it("is capped at 30 s for an assistant's own token, untouched for others", () => {
    const assistant = { ...base, label: assistantTokenLabel(ASSISTANT_PROJECT_ID) };
    expect(effectiveWaitTimeoutSec(assistant, undefined)).toBe(30);
    expect(effectiveWaitTimeoutSec(assistant, 3_600)).toBe(30);
    expect(effectiveWaitTimeoutSec(assistant, 5)).toBe(5);
    expect(effectiveWaitTimeoutSec({ ...base, label: "brain" }, undefined)).toBe(900);
  });
});

describe("work_status: chats on another computer", () => {
  const nowMs = Date.parse("2026-10-28T12:00:00.000Z");
  const entry = {
    threadId: "remote-1",
    title: "Fix the build",
    computerName: "stage-work",
    startedAt: "2026-10-28T11:50:00.000Z",
    state: "running",
    lastMessage: null,
    checkedAt: null,
  };
  it("one row with the computer's name and how long it runs", () => {
    const row = remoteWorkStatusRow(entry, { nowMs, reportPending: false });
    expect(row).toMatchObject({
      status: "running",
      computer: "stage-work",
      startedBy: "you",
      runningForSec: 600,
    });
    expect(row.project).toContain("stage-work");
    const done = remoteWorkStatusRow(
      {
        ...entry,
        state: "done",
        lastMessage: "All green.\nDetails…",
        checkedAt: "2026-10-28T11:59:00.000Z",
      },
      { nowMs, reportPending: true },
    );
    expect(done).toMatchObject({
      status: "done",
      finishedAt: "2026-10-28T11:59:00.000Z",
      reportPending: true,
    });
    expect(done.lastAnswer).toContain("All green.");
  });
  it("keeps live ones a day, settled ones as long as its own chats", () => {
    const old = { ...entry, startedAt: "2026-10-26T11:00:00.000Z" };
    expect(pickRemoteWorkStatus([entry, old], nowMs)).toEqual([entry]);
    const settled = { ...old, state: "done", checkedAt: "2026-10-27T11:00:00.000Z" };
    expect(pickRemoteWorkStatus([settled], nowMs)).toEqual([settled]);
  });
});
