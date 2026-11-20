/**
 * T51 "Team in a project" as this window holds it: what's on (`collab`), who
 * I am, the team of a chat's project, chats shared both ways, what waits in
 * my Inbox (a long poll on `requests/inbox`), a shared chat's live feed, the
 * levels and the journal. Nothing here is asked while T51 is off for the
 * account, and every hook then answers "nothing": no piece of T51 draws.
 *
 * @module team/teamStore
 */
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";

import {
  loadTeam,
  loadTeams,
  projectTeamsQueryKey,
} from "../components/projectSync/projectTeam.api";
import { teamProjectOf, type TeamCard } from "../components/projectSync/projectTeam.logic";
import { useProjectSyncStatuses } from "../components/projectSync/useProjectSync";
import { useMinuteClock } from "../hooks/useMinuteClock";
import {
  decideRequest,
  loadFeed,
  loadInbox,
  loadJournal,
  loadLevels,
  loadMyId,
  loadParts,
  loadProjectChats,
  type RequestDecision,
} from "./teamApi";
import {
  PARTS_OFF,
  isCollabOff,
  teamCollabErrorMessage,
  type FeedEvent,
  type ProjectChats,
  type ShareLevel,
  type SharedChat,
  type SharedChatStatus,
  type TeamParts,
  type TeamPersonRef,
  type TeamRequest,
} from "./teamApi.logic";
import { mergeFeed, waitingInbox } from "./team.logic";

export const teamPartsQueryKey = ["teamParts"] as const;
export const teamChatsQueryKey = (projectId: number) => ["teamChats", projectId] as const;
export const teamLevelsQueryKey = (projectId: number) => ["teamLevels", projectId] as const;
export const teamJournalQueryKey = (projectId: number) => ["teamJournal", projectId] as const;
const teamCardQueryKey = (projectId: number | null) => ["projectTeam", projectId] as const;

/** How often "Shared with you" and "Chats you share" are asked again. */
export const SHARED_CHATS_POLL_MS = 30_000;

/** What of T51 is on for me; all off until the console says otherwise. */
export function useTeamParts(): TeamParts {
  const parts = useQuery({
    queryKey: teamPartsQueryKey,
    queryFn: loadParts,
    retry: false,
    staleTime: 5 * 60_000,
  });
  return parts.data ?? PARTS_OFF;
}

/** My Uno user id (the console's), to tell me from the others in a team. */
export function useMyUserId(enabled = true): number | null {
  const me = useQuery({
    queryKey: ["accountMeId"],
    queryFn: loadMyId,
    enabled,
    retry: false,
    staleTime: 10 * 60_000,
  });
  return me.data ?? null;
}

export function useTeamsList(enabled: boolean) {
  return useQuery({
    queryKey: projectTeamsQueryKey,
    queryFn: loadTeams,
    enabled,
    retry: false,
    staleTime: 15_000,
  });
}

/** A team's card: its people (shared with Project settings → Team). */
export function useTeamCard(projectId: number | null) {
  return useQuery<TeamCard>({
    queryKey: teamCardQueryKey(projectId),
    enabled: projectId !== null,
    retry: false,
    staleTime: 30_000,
    queryFn: () => loadTeam(projectId!),
  });
}

export interface ChatTeamProject {
  readonly projectId: number;
  readonly name: string;
  readonly role: "owner" | "editor";
}

/**
 * The team project a chat's folder belongs to: the folder is "On all my
 * computers" and that project has a team. Null otherwise — a chat outside a
 * team has nobody to share with.
 */
export function useChatTeamProject(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | string | null | undefined,
  enabled: boolean,
): ChatTeamProject | null {
  const ids = useMemo(
    () => (enabled && environmentId ? [environmentId] : []),
    [enabled, environmentId],
  );
  const { entries } = useProjectSyncStatuses(ids);
  const entry = environmentId && projectId ? entries.get(`${environmentId}:${projectId}`) : null;
  const synced = entry?.enabled === true && Boolean(entry.name);
  const teams = useTeamsList(enabled && synced);
  if (!entry?.name || !synced) return null;
  const row = teamProjectOf(teams.data, entry.name, entry.team?.id ?? null);
  return row ? { projectId: row.id, name: row.name, role: row.role } : null;
}

export function useProjectChats(projectId: number | null, enabled: boolean) {
  return useQuery<ProjectChats>({
    queryKey: teamChatsQueryKey(projectId ?? 0),
    enabled: enabled && projectId !== null,
    retry: false,
    staleTime: 10_000,
    refetchInterval: SHARED_CHATS_POLL_MS,
    queryFn: () => loadProjectChats(projectId!),
  });
}

export interface SharedWithMeChat extends SharedChat {
  readonly projectName: string;
}

/** Chats colleagues shared with me, across my team projects (asked every 30 s). */
export function useSharedWithMe(): ReadonlyArray<SharedWithMeChat> {
  const parts = useTeamParts();
  const teams = useTeamsList(parts.share);
  const projects = parts.share ? (teams.data?.projects ?? []) : [];
  return useQueries({
    queries: projects.map((project) => ({
      queryKey: teamChatsQueryKey(project.id),
      queryFn: () => loadProjectChats(project.id),
      retry: false,
      staleTime: 10_000,
      refetchInterval: SHARED_CHATS_POLL_MS,
    })),
    combine: (results) => {
      const seen = new Set<number>();
      const out: SharedWithMeChat[] = [];
      results.forEach((result, index) => {
        for (const chat of result.data?.sharedWithMe ?? []) {
          if (seen.has(chat.id)) continue;
          seen.add(chat.id);
          out.push({ ...chat, projectName: projects[index]?.name ?? "" });
        }
      });
      return out.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
  });
}

export function useTeamLevels(projectId: number | null, enabled: boolean) {
  return useQuery({
    queryKey: teamLevelsQueryKey(projectId ?? 0),
    enabled: enabled && projectId !== null,
    retry: false,
    staleTime: 15_000,
    queryFn: () => loadLevels(projectId!),
  });
}

export function useTeamJournal(projectId: number | null, enabled: boolean) {
  return useQuery({
    queryKey: teamJournalQueryKey(projectId ?? 0),
    enabled: enabled && projectId !== null,
    retry: false,
    staleTime: 15_000,
    refetchInterval: 60_000,
    queryFn: () => loadJournal(projectId!),
  });
}

/** After a share changed: the lists everywhere ask again. */
export function useInvalidateTeamChats() {
  const queryClient = useQueryClient();
  return (projectId: number) =>
    void queryClient.invalidateQueries({ queryKey: teamChatsQueryKey(projectId) });
}

// ── A shared chat's feed (long poll) ────────────────────────────────────

export interface SharedFeedState {
  readonly events: ReadonlyArray<FeedEvent>;
  readonly status: SharedChatStatus;
  readonly title: string;
  readonly myLevel: ShareLevel | null;
  readonly loaded: boolean;
  /** Not shared with me any more (or gone). */
  readonly gone: boolean;
  readonly error: string | null;
}

const FEED_EMPTY: SharedFeedState = {
  events: [],
  status: "idle",
  title: "",
  myLevel: null,
  loaded: false,
  gone: false,
  error: null,
};

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The feed of a chat shared with me, kept live: `events?after_seq=…&wait=25` in a loop. */
export function useSharedChatFeed(chatId: number | null): SharedFeedState {
  const [state, setState] = useState<SharedFeedState>(FEED_EMPTY);
  useEffect(() => {
    setState(FEED_EMPTY);
    if (chatId === null) return;
    const life = { disposed: false };
    const run = async () => {
      let after = 0;
      let first = true;
      while (!life.disposed) {
        const started = Date.now();
        try {
          const page = await loadFeed(chatId, after, first ? 0 : 25);
          if (life.disposed) return;
          after = Math.max(after, page.nextSeq);
          setState((current) => ({
            events: mergeFeed(current.events, page.events),
            status: page.status,
            title: page.title || current.title,
            myLevel: page.myLevel ?? current.myLevel,
            loaded: true,
            gone: false,
            error: null,
          }));
          // A server that answers at once with nothing new mustn't be asked in a tight loop.
          if (!first && page.events.length === 0 && Date.now() - started < 2_000) {
            await sleep(5_000);
          }
          // More pages waiting: the next one at once, no long poll.
          first = page.more;
        } catch (error) {
          if (life.disposed) return;
          const status = (error as { status?: unknown } | null)?.status;
          if (status === 403 || status === 404 || isCollabOff(error)) {
            setState((current) => ({ ...current, loaded: true, gone: true }));
            return;
          }
          setState((current) => ({
            ...current,
            loaded: true,
            error: teamCollabErrorMessage(error),
          }));
          await sleep(10_000);
        }
      }
    };
    void run();
    return () => {
      life.disposed = true;
    };
  }, [chatId]);
  return state;
}

// ── My Inbox: what colleagues sent (long poll) ──────────────────────────

interface TeamInboxState {
  readonly byId: Readonly<Record<number, TeamRequest>>;
  readonly rev: number;
  readonly busy: Readonly<Record<number, true>>;
}

export const useTeamInboxStore = create<TeamInboxState>(() => ({ byId: {}, rev: 0, busy: {} }));

/** Put what the server said into the store; the requests that just started waiting. */
export function absorbInbox(requests: ReadonlyArray<TeamRequest>, rev: number): TeamRequest[] {
  const before = useTeamInboxStore.getState();
  const fresh: TeamRequest[] = [];
  const byId: Record<number, TeamRequest> = { ...before.byId };
  for (const request of requests) {
    const held = byId[request.id];
    if (held && held.rev > request.rev) continue;
    if (request.status === "waiting" && held?.status !== "waiting") fresh.push(request);
    byId[request.id] = request;
  }
  useTeamInboxStore.setState({ byId, rev: Math.max(before.rev, rev) });
  return fresh;
}

export function resetTeamInbox(): void {
  useTeamInboxStore.setState({ byId: {}, rev: 0, busy: {} });
}

/** Ask once now (after deciding), without waiting. */
export async function refreshTeamInbox(): Promise<void> {
  try {
    const page = await loadInbox(useTeamInboxStore.getState().rev, 0);
    absorbInbox(page.requests, page.rev);
  } catch {
    // The listener's next round tries again.
  }
}

/** Waiting messages, questions and "may I write" — the cards of "From your team". */
export function useTeamInboxWaiting(): ReadonlyArray<TeamRequest> {
  useMinuteClock();
  const byId = useTeamInboxStore((store) => store.byId);
  const parts = useTeamParts();
  const meId = useMyUserId(parts.requests);
  return useMemo(
    () => (parts.requests ? waitingInbox(Object.values(byId), meId) : []),
    [byId, meId, parts.requests],
  );
}

/** Added to every Needs you count. */
export function useTeamInboxWaitingCount(): number {
  return useTeamInboxWaiting().length;
}

export function setTeamInboxBusy(id: number, on: boolean): void {
  useTeamInboxStore.setState((store) => {
    if (on) return { busy: { ...store.busy, [id]: true } };
    const { [id]: _done, ...rest } = store.busy;
    return { busy: rest };
  });
}

const DECIDED_STATUS: Readonly<Record<RequestDecision, TeamRequest["status"]>> = {
  read: "read",
  declined: "declined",
  answer: "answered",
  allow: "started",
  deny: "declined",
};

/** Answer a request; null on success, else the sentence to show. */
export async function decideTeamRequest(
  request: TeamRequest,
  decision: RequestDecision,
  text?: string,
): Promise<string | null> {
  setTeamInboxBusy(request.id, true);
  try {
    await decideRequest(request.id, decision, text);
    absorbInbox([{ ...request, status: DECIDED_STATUS[decision] }], 0);
    void refreshTeamInbox();
    return null;
  } catch (error) {
    void refreshTeamInbox();
    return teamCollabErrorMessage(error);
  } finally {
    setTeamInboxBusy(request.id, false);
  }
}

/** The person a request or a chat names, with their name from the team when the answer had only an id. */
export function personFromCard(
  card: TeamCard | undefined,
  person: TeamPersonRef | null,
): TeamPersonRef | null {
  if (!person) return null;
  if (person.username || person.email) return person;
  const member = card?.members.find((item) => item.user_id === person.userId);
  return member
    ? { userId: member.user_id, email: member.email, username: member.username }
    : person;
}
