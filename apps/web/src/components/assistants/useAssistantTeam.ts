/**
 * The person's assistants as the sidebar and their pages show them: every
 * assistant folder (`assistant-*`) on the computers this app knows, joined
 * with its profile and its chats. The profile is the daemon's (its token,
 * app levels and team record, `teamFromDaemon.logic.ts`); the mock
 * (`?demo=w0138`) keeps its own in this browser (`assistantTeamStore.ts`).
 *
 * A folder without a profile is an assistant set up before the team existed
 * (Uno on every computer, "New assistant" from 0.0.106): it shows with what
 * the folder says — and if nobody ever talked to it, the first click on it
 * starts the setup instead of an empty chat.
 */
import {
  ASSISTANT_PROJECT_ID,
  type EnvironmentId,
  isAssistantProjectId,
  type ManagerAssistantSummary,
} from "@t3tools/contracts";
import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { DEMO } from "../../demo/demoFlag";
import { useMachineLabels } from "../../hooks/useMachineRows";
import { listAssistants } from "../../lib/managerApi";
import { toSortableTimestamp } from "../../lib/threadSort";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../../store";
import type { SidebarThreadSummary } from "../../types";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { resolveThreadActivityMs } from "../Sidebar.sections";
import {
  type AssistantActivity,
  type AssistantKey,
  type AssistantProfile,
  type TeamChats,
  assistantActivity,
  assistantKeyOf,
  chatsOfAssistant,
} from "./assistantTeam.logic";
import { useAssistantTeamStore } from "./assistantTeamStore";
import { isConfigured, profileFromDaemon } from "./teamFromDaemon.logic";
import { LOCAL_ASSISTANTS_KEY, useAssistantsAvailability } from "./useAssistants";

export interface TeamMember {
  readonly key: AssistantKey;
  readonly environmentId: string;
  readonly projectId: string;
  /** Uno — the computer's default assistant. */
  readonly isUno: boolean;
  readonly profile: AssistantProfile;
  /** What its daemon says (null in the mock, or before the first answer). */
  readonly summary: ManagerAssistantSummary | null;
  readonly createdBy: AssistantKey | null;
  /** The setup was done (or it was already in use before the setup existed). */
  readonly configured: boolean;
  readonly revoked: boolean;
  readonly computerLabel: string;
  readonly chats: TeamChats<SidebarThreadSummary>;
  readonly activity: AssistantActivity;
}

export function threadActivityMs(thread: SidebarThreadSummary): number {
  return (
    resolveThreadActivityMs(thread) ??
    toSortableTimestamp(thread.updatedAt ?? undefined) ??
    toSortableTimestamp(thread.createdAt) ??
    0
  );
}

function fallbackProfile(
  environmentId: string,
  projectId: string,
  title: string,
): AssistantProfile {
  const isUno = projectId === ASSISTANT_PROJECT_ID;
  return {
    environmentId,
    projectId,
    name: isUno ? "Uno" : title,
    emoji: isUno ? null : "🙂",
    tone: "violet",
    roles: isUno ? ["Personal assistant"] : [],
    character: "",
    skills: [],
    preset: "full",
    brain: "uno",
    channel: "uno-bot",
    channelHandle: null,
    projects: "all",
    computers: [environmentId],
    createdBy: null,
    createdAt: new Date(0).toISOString(),
    setUpAt: null,
    revokedAt: null,
  };
}

const ORDER = (member: TeamMember) => (member.isUno ? 0 : 1);

/**
 * Whether the team of assistants (its block in the sidebar, "New assistant",
 * their pages, access and Activity) is shown: for an account with the
 * assistants update (`assistants_mvp`, 22.10), and in the mock.
 */
export function useTeamShown(): boolean {
  const availability = useAssistantsAvailability();
  return DEMO || availability === "on";
}

/** The daemon's list of assistants, per computer. */
export const TEAM_SUMMARIES_KEY = [...LOCAL_ASSISTANTS_KEY, "team"] as const;

type SummariesResult = UseQueryResult<ReadonlyArray<ManagerAssistantSummary>>;
const summariesData = (results: ReadonlyArray<SummariesResult>) =>
  results.map((result) => result.data ?? null);

/** Every assistant, Uno first, then in the order they were set up. Without the team — Uno only. */
export function useAssistantTeam(teamShownOverride?: boolean): ReadonlyArray<TeamMember> {
  const shownByAccount = useTeamShown();
  const teamShown = teamShownOverride ?? shownByAccount;
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const storeProfiles = useAssistantTeamStore((state) => state.profiles);
  const labels = useMachineLabels();
  // Outside the mock the team is what each computer's daemon keeps.
  const fromDaemon = teamShown && !DEMO;
  const environmentIds = useMemo(
    () =>
      fromDaemon
        ? [
            ...new Set(
              projects
                .filter((project) => isAssistantProjectId(project.id))
                .map((project) => project.environmentId),
            ),
          ].toSorted()
        : [],
    [fromDaemon, projects],
  );
  const summaryLists = useQueries({
    queries: environmentIds.map((environmentId) => ({
      queryKey: [...TEAM_SUMMARIES_KEY, environmentId],
      queryFn: async () =>
        (await listAssistants({ environmentId: environmentId as EnvironmentId })).assistants,
      refetchInterval: 15_000,
      staleTime: 5_000,
      retry: false,
    })),
    combine: summariesData,
  });
  const daemon = useMemo(() => {
    const titles = new Map<string, Map<string, string>>();
    for (const project of projects) {
      const map = titles.get(project.environmentId) ?? new Map<string, string>();
      map.set(project.id, project.name);
      titles.set(project.environmentId, map);
    }
    const summaries = new Map<AssistantKey, ManagerAssistantSummary>();
    const profiles: Record<AssistantKey, AssistantProfile> = {};
    environmentIds.forEach((environmentId, index) => {
      for (const summary of summaryLists[index] ?? []) {
        const key = assistantKeyOf(environmentId, summary.projectId);
        summaries.set(key, summary);
        profiles[key] = profileFromDaemon({
          environmentId,
          summary,
          projectTitles: titles.get(environmentId) ?? new Map(),
        });
      }
    });
    return { summaries, profiles };
  }, [environmentIds, projects, summaryLists]);
  const profiles = fromDaemon ? daemon.profiles : storeProfiles;

  return useMemo(() => {
    const members: TeamMember[] = [];
    for (const project of projects) {
      if (!isAssistantProjectId(project.id)) continue;
      // The release has Uno alone (Misha 16.10): other assistant folders —
      // "New assistant" from 0.0.106 — stay under Settings → Assistants.
      // The team is the mock's (?demo=w0138).
      if (!teamShown && project.id !== ASSISTANT_PROJECT_ID) continue;
      const key = assistantKeyOf(project.environmentId, project.id);
      const profile =
        profiles[key] ?? fallbackProfile(project.environmentId, project.id, project.name);
      const chats = chatsOfAssistant(
        threads,
        { environmentId: project.environmentId, projectId: project.id },
        threadActivityMs,
      );
      const summary = fromDaemon ? (daemon.summaries.get(key) ?? null) : null;
      // The daemon makes Uno's main chat by itself on a fresh computer: outside
      // the mock "set up" means the setup started, or the person wrote to it.
      const personWrote = chats.conversations.some((thread) => thread.latestUserMessageAt !== null);
      members.push({
        key,
        environmentId: project.environmentId,
        projectId: project.id,
        isUno: project.id === ASSISTANT_PROJECT_ID,
        profile,
        summary,
        createdBy: profile.createdBy,
        configured:
          profile.setUpAt !== null ||
          (DEMO
            ? teamShown
              ? chats.conversations.length > 0
              : personWrote
            : isConfigured(summary?.team?.team ?? null, personWrote)),
        revoked: profile.revokedAt !== null,
        computerLabel: labels.get(project.environmentId) ?? "",
        chats,
        activity: assistantActivity(
          [...chats.conversations, ...chats.work],
          resolveSidebarThreadStatus,
        ),
      });
    }
    // Every computer has a Uno of its own: the team shows one — the one the
    // person talks to (latest conversation), else the first.
    const unos = members.filter((member) => member.isUno);
    const lastTalk = (member: TeamMember) =>
      member.chats.conversations[0] ? threadActivityMs(member.chats.conversations[0]) : -1;
    const mainUno = unos.toSorted((a, b) => lastTalk(b) - lastTalk(a))[0];
    return members
      .filter((member) => !member.isUno || member === mainUno)
      .toSorted(
        (a, b) =>
          ORDER(a) - ORDER(b) ||
          a.profile.createdAt.localeCompare(b.profile.createdAt) ||
          a.key.localeCompare(b.key),
      );
  }, [daemon.summaries, fromDaemon, labels, profiles, projects, teamShown, threads]);
}

export function useTeamMember(environmentId: string, projectId: string): TeamMember | null {
  const team = useAssistantTeam();
  return (
    team.find(
      (member) => member.environmentId === environmentId && member.projectId === projectId,
    ) ?? null
  );
}

/**
 * The teammate a chat belongs to (its folder is a teammate's, not Uno's):
 * its header shows that face and name instead of Uno's.
 */
export function useTeammateOfThread(environmentId: string, threadId: string): TeamMember | null {
  const projectId = useStore(
    (state) =>
      selectSidebarThreadsAcrossEnvironments(state).find(
        (thread) => thread.environmentId === environmentId && thread.id === threadId,
      )?.projectId ?? null,
  );
  const team = useAssistantTeam();
  if (projectId === null || projectId === ASSISTANT_PROJECT_ID) return null;
  return (
    team.find(
      (member) => member.environmentId === environmentId && member.projectId === projectId,
    ) ?? null
  );
}
