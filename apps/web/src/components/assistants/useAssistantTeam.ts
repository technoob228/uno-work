/**
 * The person's assistants as the sidebar and their pages show them: every
 * assistant folder (`assistant-*`) on the computers this app knows, joined
 * with its profile (`assistantTeamStore.ts`) and its chats.
 *
 * A folder without a profile is an assistant set up before the team existed
 * (Uno on every computer, "New assistant" from 0.0.106): it shows with what
 * the folder says — and if nobody ever talked to it, the first click on it
 * starts the setup instead of an empty chat.
 */
import { ASSISTANT_PROJECT_ID, isAssistantProjectId } from "@t3tools/contracts";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { useMachineLabels } from "../../hooks/useMachineRows";
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

export interface TeamMember {
  readonly key: AssistantKey;
  readonly environmentId: string;
  readonly projectId: string;
  /** Uno — the computer's default assistant. */
  readonly isUno: boolean;
  readonly profile: AssistantProfile;
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

/** Every assistant, Uno first, then in the order they were set up. */
export function useAssistantTeam(): ReadonlyArray<TeamMember> {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const profiles = useAssistantTeamStore((state) => state.profiles);
  const labels = useMachineLabels();

  return useMemo(() => {
    const members: TeamMember[] = [];
    for (const project of projects) {
      if (!isAssistantProjectId(project.id)) continue;
      const key = assistantKeyOf(project.environmentId, project.id);
      const profile =
        profiles[key] ?? fallbackProfile(project.environmentId, project.id, project.name);
      const chats = chatsOfAssistant(
        threads,
        { environmentId: project.environmentId, projectId: project.id },
        threadActivityMs,
      );
      members.push({
        key,
        environmentId: project.environmentId,
        projectId: project.id,
        isUno: project.id === ASSISTANT_PROJECT_ID,
        profile,
        createdBy: profile.createdBy,
        configured: profile.setUpAt !== null || chats.conversations.length > 0,
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
  }, [labels, profiles, projects, threads]);
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
