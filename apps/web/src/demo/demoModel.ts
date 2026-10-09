/**
 * Demo mode: the chats of every computer as the variants see them — live
 * from the store (so a click that answers a chat moves it everywhere), plus
 * what the fixtures know on top: what exactly a chat asks for, who
 * coordinates whom across computers.
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import { type InboxEntry, useInboxStore, mergeInbox } from "../inbox/inboxStore";
import { selectSidebarThreadsAcrossEnvironments, useStore } from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import type { SidebarThreadSummary } from "../types";
import { answerChatIn, retryChatIn } from "./demoBoot";
import { demoHooks } from "./demoFlag";
import {
  CHATS,
  MACHINE_LIST,
  chatById,
  machineByEnv,
  projectTitle,
  type ChatSpec,
  type DemoMachine,
} from "./heavyFixtures";

export type LiveStatus =
  | "needs-you"
  | "running"
  | "failed"
  | "done"
  | "scheduled"
  | "snoozed"
  | "settled"
  | "archived";

export interface DemoChat {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly title: string;
  readonly machine: DemoMachine;
  /** Project name the person knows ("No project" for a Home folder, "Uno" for the assistant). */
  readonly project: string;
  readonly status: LiveStatus;
  /** Finished and not looked at yet (an unread "done" in the Inbox). */
  readonly unread: boolean;
  readonly spec: ChatSpec | null;
  readonly summary: SidebarThreadSummary;
  /** Running: the turn's start. */
  readonly startedAt: string | null;
  readonly updatedAt: string;
}

export const NO_PROJECT = "No project";

function projectNameOf(summary: SidebarThreadSummary): string {
  const title = projectTitle(summary.projectId);
  return title === "Home folder" ? NO_PROJECT : title;
}

function statusOf(summary: SidebarThreadSummary, nowMs: number, spec: ChatSpec | null): LiveStatus {
  if (summary.archivedAt) return "archived";
  const status = resolveSidebarThreadStatus(summary);
  if (status === "approval" || status === "input") return "needs-you";
  if (status === "working") return "running";
  if (status === "failed" || summary.latestTurn?.state === "error") return "failed";
  if (summary.snoozedUntil && Date.parse(summary.snoozedUntil) > nowMs) {
    return spec?.schedule ? "scheduled" : "snoozed";
  }
  if (summary.settledOverride === "settled") return "settled";
  return "done";
}

/** A clock for "running 42m" that moves while the page is open. */
export function useNow(intervalMs = 20_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function useDemoChats(): ReadonlyArray<DemoChat> {
  const summaries = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const byEnvironment = useInboxStore((state) => state.byEnvironment);
  const now = useNow();
  return useMemo(() => {
    const unreadDone = new Set<string>();
    for (const item of mergeInbox(byEnvironment)) {
      if (item.kind === "agent.done" && item.readAt === null && item.open?.kind === "thread") {
        unreadDone.add(`${item.environmentId}:${item.open.threadId}`);
      }
    }
    const out: DemoChat[] = [];
    for (const summary of summaries) {
      const machine = machineByEnv(summary.environmentId);
      if (!machine) continue;
      const spec = chatById(summary.id) ?? null;
      const key = `${summary.environmentId}:${summary.id}`;
      const status = statusOf(summary, now, spec);
      const turn = summary.latestTurn;
      out.push({
        key,
        environmentId: summary.environmentId,
        id: summary.id,
        title: summary.title,
        machine,
        project: projectNameOf(summary),
        status,
        unread: status === "done" && unreadDone.has(key),
        spec,
        summary,
        startedAt: status === "running" ? (turn?.startedAt ?? turn?.requestedAt ?? null) : null,
        updatedAt: summary.updatedAt ?? summary.createdAt,
      });
    }
    return out.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [byEnvironment, now, summaries]);
}

// ── Coordination ─────────────────────────────────────────────────────────

export interface DemoTeam {
  readonly lead: DemoChat;
  readonly helpers: ReadonlyArray<DemoChat>;
  readonly counts: { done: number; running: number; needs: number; failed: number };
  /** "coordinator", "validator", "MacBook chat" — how a helper names its lead. */
  readonly leadWord: string;
}

/** Leads whose helpers live in their own tree (Uno's chats stay under Uno). */
const TEAM_LEADS = CHATS.filter(
  (chat) => chat.role !== "assistant" && CHATS.some((other) => other.parent === chat.id),
).map((chat) => chat.id);

const PARENT_OF = new Map(
  CHATS.filter((chat) => chat.parent && TEAM_LEADS.includes(chat.parent)).map((chat) => [
    chat.id,
    chat.parent!,
  ]),
);

export function leadWordOf(lead: ChatSpec): string {
  if (lead.role === "coordinator") return "coordinator";
  if (lead.role === "validator") return "validator";
  if (lead.role === "assistant") return "Uno";
  return `${MACHINE_LIST.find((machine) => machine.key === lead.machine)?.label ?? ""} chat`;
}

/** "from coordinator · uno-work" — for a helper; null for everything else. */
export function fromLine(chat: DemoChat): string | null {
  const parentId = chat.spec?.parent;
  if (!parentId) return null;
  const lead = chatById(parentId);
  if (!lead) return null;
  const machine = MACHINE_LIST.find((item) => item.key === lead.machine);
  if (lead.role === "assistant") return "from Uno";
  return `from ${leadWordOf(lead)} · ${machine?.label ?? ""}`;
}

export function isTeamMember(threadId: string): boolean {
  return TEAM_LEADS.includes(threadId) || PARENT_OF.has(threadId);
}

export function useDemoTeams(chats: ReadonlyArray<DemoChat>): ReadonlyArray<DemoTeam> {
  return useMemo(() => {
    const byId = new Map(chats.map((chat) => [chat.id as string, chat]));
    return TEAM_LEADS.flatMap((leadId) => {
      const lead = byId.get(leadId);
      if (!lead || lead.status === "archived") return [];
      const helpers = CHATS.filter((chat) => chat.parent === leadId)
        .map((chat) => byId.get(chat.id))
        .filter((chat): chat is DemoChat => chat !== undefined);
      const counts = { done: 0, running: 0, needs: 0, failed: 0 };
      for (const helper of helpers) {
        if (helper.status === "needs-you") counts.needs += 1;
        else if (helper.status === "running") counts.running += 1;
        else if (helper.status === "failed") counts.failed += 1;
        else counts.done += 1;
      }
      return [{ lead, helpers, counts, leadWord: leadWordOf(lead.spec!) }];
    }).toSorted((a, b) => {
      const urgency = (team: DemoTeam) =>
        team.counts.needs > 0 || team.lead.status === "needs-you"
          ? 0
          : team.counts.running > 0
            ? 1
            : 2;
      return urgency(a) - urgency(b) || b.lead.updatedAt.localeCompare(a.lead.updatedAt);
    });
  }, [chats]);
}

/**
 * V3: the Inbox folds what helpers report into one card per coordinator —
 * "Train 10.10: L5 asks you · 1 done · 1 stopped".
 */
export function collapseInboxForTeams<T extends InboxEntry>(entries: ReadonlyArray<T>): T[] {
  const groups = new Map<string, T[]>();
  const out: T[] = [];
  for (const entry of entries) {
    const threadId = entry.open?.kind === "thread" ? entry.open.threadId : null;
    const lead = threadId
      ? (PARENT_OF.get(threadId) ?? (TEAM_LEADS.includes(threadId) ? threadId : null))
      : null;
    if (!lead) {
      out.push(entry);
      continue;
    }
    const list = groups.get(lead) ?? [];
    list.push(entry);
    groups.set(lead, list);
  }
  for (const [leadId, items] of groups) {
    // Only the coordinator's own items: nothing to fold.
    if (items.every((item) => item.open?.kind === "thread" && item.open.threadId === leadId)) {
      out.push(...items);
      continue;
    }
    const lead = chatById(leadId)!;
    const own = items.filter(
      (item) => item.open?.kind === "thread" && item.open.threadId === leadId,
    );
    const leadMachine = MACHINE_LIST.find((machine) => machine.key === lead.machine)!;
    const needs = items.filter(
      (item) => item.kind === "agent.input" || item.kind === "agent.approval",
    );
    const failed = items.filter((item) => item.kind === "agent.error");
    const done = items.filter((item) => item.kind === "agent.done");
    const parts = [
      ...needs.map((item) =>
        own.includes(item) ? "asks you" : `${shortTitle(item.title)} asks you`,
      ),
      done.length > 0 ? `${done.length} done` : null,
      failed.length > 0 ? `${failed.length} stopped` : null,
    ].filter(Boolean);
    const newest = items.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b));
    const computers = [
      ...new Set(
        items.map((item) => machineByEnv(item.environmentId)?.label).filter(Boolean) as string[],
      ),
    ];
    out.push({
      ...newest,
      id: `team:${leadId}`,
      environmentId: leadMachine.environmentId,
      kind: needs.length > 0 ? needs[0]!.kind : failed.length > 0 ? "agent.error" : "agent.done",
      source: { kind: "agent", id: leadId, name: lead.title, icon: null },
      title: lead.title,
      body: `${parts.join(" · ")} — helpers on ${computers.join(", ")}`,
      open: { kind: "thread", threadId: leadId },
      count: items.length,
      readAt: items.every((item) => item.readAt !== null) ? newest.readAt : null,
    });
  }
  return out.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function shortTitle(title: string): string {
  const head = title.split(":")[0] ?? title;
  return head.length > 24 ? `${head.slice(0, 22)}…` : head;
}

// ── Actions ──────────────────────────────────────────────────────────────

export function useOpenChat() {
  const navigate = useNavigate();
  return useCallback(
    (chat: Pick<DemoChat, "environmentId" | "id">) => {
      useStore.getState().setActiveEnvironmentId(chat.environmentId);
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({ environmentId: chat.environmentId, threadId: chat.id }),
      });
    },
    [navigate],
  );
}

export function answer(chat: DemoChat, choice: string) {
  answerChatIn(chat.environmentId, chat.id, choice);
}

export function retry(chat: DemoChat, text: string) {
  retryChatIn(chat.environmentId, chat.id, text);
}

/** Options of the one thing a chat waits for, the main one first. */
export function actionsOf(chat: DemoChat): ReadonlyArray<{ label: string; primary?: boolean }> {
  const ask = chat.spec?.ask;
  if (!ask) {
    return chat.summary.hasPendingApprovals
      ? [{ label: "Allow", primary: true }, { label: "Deny" }]
      : [{ label: "Open", primary: true }];
  }
  switch (ask.kind) {
    case "question":
      return ask.options.map((label, index) => ({ label, primary: index === 0 }));
    case "permission":
      return [{ label: "Allow", primary: true }, { label: "Deny" }];
    case "review":
      return [{ label: "Merge", primary: true }, { label: "Not yet" }];
    case "payment":
      return [{ label: `Pay ${ask.amount}`, primary: true }, { label: "Remind me later" }];
  }
}

export function askTextOf(chat: DemoChat): string {
  return chat.spec?.ask?.text ?? "Waiting for your answer";
}

export function installDemoHooks() {
  demoHooks.collapseInbox = collapseInboxForTeams as never;
  demoHooks.isTeamMember = isTeamMember;
}
