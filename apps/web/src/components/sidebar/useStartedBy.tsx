/**
 * Who started each chat (assistants D, 28.10 p.5): asks every connected
 * computer's daemon (`GET /api/manager/started-by`), reads the store where a
 * daemon can't say (older one: 404), and names the assistant the way the
 * sidebar does (its team record). See startedBy.logic.ts for the rules.
 */
import { ASSISTANT_PROJECT_ID, type EnvironmentId } from "@t3tools/contracts";
import { useQueries } from "@tanstack/react-query";
import { memo, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";

import { listStartedBy } from "../../lib/managerApi";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../../store";
import type { SidebarThreadSummary } from "../../types";
import { AssistantAvatar, avatarImageOf } from "../assistants/AssistantAvatar";
import type { AssistantProfile } from "../assistants/assistantTeam.logic";
import { useAssistantTeam } from "../assistants/useAssistantTeam";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { UnoFace } from "./SidebarDParts";
import {
  type StartedBy,
  type StartedByEntry,
  resolveStartedBy,
  startedByKey,
  startedByLabel,
} from "./startedBy.logic";

/** Who started a chat, with the assistant's face when the app knows it. */
export interface StartedByView extends StartedBy {
  readonly label: string;
  readonly face: Pick<
    AssistantProfile,
    "emoji" | "tone" | "environmentId" | "projectId" | "avatar"
  > | null;
}

export interface StartedByIndex {
  /** By `startedByKey(environmentId, threadId)`. */
  readonly byKey: ReadonlyMap<string, StartedByView>;
  /** Every live chat an assistant started, on any connected computer. */
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
}

const EMPTY_INDEX: StartedByIndex = { byKey: new Map(), threads: [] };
const STARTED_BY_KEY = ["sidebar", "started-by"] as const;

type EntriesResult = ReadonlyArray<StartedByEntry> | null;

export function useStartedBy(enabled: boolean): StartedByIndex {
  const threads = useStore(
    useShallow((state) => (enabled ? selectSidebarThreadsAcrossEnvironments(state) : [])),
  );
  const projects = useStore(
    useShallow((state) => (enabled ? selectProjectsAcrossEnvironments(state) : [])),
  );
  const team = useAssistantTeam();
  const environmentIds = useMemo(
    () => [...new Set(threads.map((thread) => thread.environmentId))].toSorted(),
    [threads],
  );
  const lists = useQueries({
    queries: environmentIds.map((environmentId) => ({
      queryKey: [...STARTED_BY_KEY, environmentId],
      queryFn: async (): Promise<EntriesResult> =>
        (await listStartedBy({ environmentId: environmentId as EnvironmentId })).items,
      staleTime: 5_000,
      retry: false,
      // An older daemon has no such route: ask it again rarely, not every 15 s.
      refetchInterval: (query: { state: { status: string } }) =>
        query.state.status === "error" ? 120_000 : 15_000,
    })),
    combine: (results) => results.map((result) => result.data ?? null),
  });
  // Rows are memoized: a chat whose "started by" didn't change keeps its object.
  const previous = useRef<ReadonlyMap<string, StartedByView>>(EMPTY_INDEX.byKey);
  return useMemo(() => {
    if (!enabled) return EMPTY_INDEX;
    const entries = new Map<string, ReadonlyArray<StartedByEntry>>();
    environmentIds.forEach((environmentId, index) => {
      const list = lists[index];
      if (list) entries.set(environmentId, list);
    });
    const folderName = new Map<string, string>(
      projects.map((project) => [`${project.environmentId}:${project.id}`, project.name]),
    );
    const memberOf = (environmentId: string | null, projectId: string | null) =>
      projectId === null
        ? undefined
        : (team.find(
            (member) =>
              member.projectId === projectId &&
              (environmentId === null || member.environmentId === environmentId),
          ) ??
          // Uno is one per account: its face is the same on every computer.
          (projectId === ASSISTANT_PROJECT_ID ? team.find((member) => member.isUno) : undefined));
    const resolved = resolveStartedBy({
      threads,
      entries,
      assistantName: (environmentId, projectId) =>
        memberOf(environmentId, projectId)?.profile.name ??
        (projectId === ASSISTANT_PROJECT_ID
          ? "Uno"
          : (folderName.get(`${environmentId}:${projectId}`) ?? null)),
    });
    const byKey = new Map<string, StartedByView>();
    for (const [key, startedBy] of resolved) {
      const member = memberOf(startedBy.environmentId, startedBy.projectId);
      const next: StartedByView = {
        ...startedBy,
        label: startedByLabel(startedBy),
        face: member
          ? {
              emoji: member.profile.emoji,
              tone: member.profile.tone,
              environmentId: member.profile.environmentId,
              projectId: member.profile.projectId,
              avatar: member.profile.avatar ?? null,
            }
          : null,
      };
      const before = previous.current.get(key);
      byKey.set(key, before && sameStartedBy(before, next) ? before : next);
    }
    previous.current = byKey;
    return {
      byKey,
      threads: threads.filter((thread) => byKey.has(startedByKey(thread.environmentId, thread.id))),
    };
  }, [enabled, environmentIds, lists, projects, team, threads]);
}

function sameStartedBy(a: StartedByView, b: StartedByView): boolean {
  return (
    a.label === b.label &&
    a.projectId === b.projectId &&
    a.environmentId === b.environmentId &&
    a.isUno === b.isUno &&
    a.face?.emoji === b.face?.emoji &&
    a.face?.tone === b.face?.tone &&
    a.face?.avatar === b.face?.avatar &&
    a.face?.environmentId === b.face?.environmentId
  );
}

/** The small face before a chat's title: who started it, named on hover. */
export const StartedByFace = memo(function StartedByFace(props: {
  readonly startedBy: StartedByView;
  readonly threadId: string;
}) {
  const { startedBy } = props;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={startedBy.label}
            data-testid="sidebar-row-started-by"
            data-started-by={startedBy.name}
            data-thread={props.threadId}
            className="inline-flex shrink-0 items-center"
          />
        }
      >
        {startedBy.face && !startedBy.isUno ? (
          <AssistantAvatar
            emoji={startedBy.face.emoji}
            image={avatarImageOf(startedBy.face)}
            tone={startedBy.face.tone}
            className="size-3.5"
          />
        ) : (
          <UnoFace className="size-3.5" />
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">{startedBy.label}</TooltipPopup>
    </Tooltip>
  );
});
