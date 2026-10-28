/**
 * Variant B (28.10): an assistant of its own on every computer. Each one
 * lives on one computer and sees only it, so everywhere it is named with its
 * computer ("Uno · MacBook"), and the person picks how the sidebar gathers
 * them (Misha: "how do we collect them in the sidebar? or not?"):
 *
 * - `group` (B1): one "Assistants" group, each row with its computer and
 *   whether it's awake;
 * - `switcher` (B2): this computer's assistants at the top of the sidebar,
 *   the others at the top of each computer in the computer switcher.
 *
 * A computer that sleeps (a Free cloud computer, a closed laptop) doesn't
 * answer, so its assistants come from what this browser saw last (or, for a
 * computer never opened here, its Uno alone) and show as asleep.
 */
import {
  ASSISTANT_PROJECT_ID,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo } from "react";
import { create } from "zustand";

import { fetchSubscription } from "../../account/accountOverview";
import { useActiveMachine } from "../../hooks/useActiveMachine";
import { useMachineRows } from "../../hooks/useMachineRows";
import { ensureAssistantChat } from "../../lib/managerApi";
import type { MachineKind } from "../../machineKind";
import { selectSidebarThreadsAcrossEnvironments, useStore } from "../../store";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { AssistantActivity, AvatarTone } from "./assistantTeam.logic";
import { type TeamMember, useAssistantTeam } from "./useAssistantTeam";

// ── The layout switch (B1 / B2) ──────────────────────────────────────────

export type AssistantsLayout = "group" | "switcher";
const LAYOUT_KEY = "uno:assistants-layout:v1";

function readLayout(): AssistantsLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "switcher" ? "switcher" : "group";
  } catch {
    return "group";
  }
}

export const useAssistantsLayout = create<{
  readonly layout: AssistantsLayout;
  readonly set: (layout: AssistantsLayout) => void;
}>((set) => ({
  layout: typeof localStorage === "undefined" ? "group" : readLayout(),
  set: (layout) => {
    try {
      localStorage.setItem(LAYOUT_KEY, layout);
    } catch {
      // fine: for this session
    }
    set({ layout });
  },
}));

export function setAssistantsLayout(layout: AssistantsLayout) {
  useAssistantsLayout.getState().set(layout);
}

// ── What a sleeping computer had (seen last in this browser) ─────────────

export interface KnownAssistant {
  readonly projectId: string;
  readonly name: string;
  readonly emoji: string | null;
  readonly tone: AvatarTone;
}

export const LAST_KNOWN_KEY = "uno:assistants-last-known:v1";

/** A computer's key in the cache: its environment, or its box before it ever connected. */
export const machineCacheKey = (environmentId: string | null, boxId: number | null) =>
  environmentId ?? `box:${boxId ?? "?"}`;

function readKnown(): Record<string, ReadonlyArray<KnownAssistant>> {
  try {
    return JSON.parse(localStorage.getItem(LAST_KNOWN_KEY) ?? "{}") as Record<
      string,
      ReadonlyArray<KnownAssistant>
    >;
  } catch {
    return {};
  }
}

function writeKnown(key: string, list: ReadonlyArray<KnownAssistant>) {
  try {
    const all = readKnown();
    if (JSON.stringify(all[key]) === JSON.stringify(list)) return;
    localStorage.setItem(LAST_KNOWN_KEY, JSON.stringify({ ...all, [key]: list }));
  } catch {
    // fine: nothing remembered
  }
}

// ── Computers with their assistants ──────────────────────────────────────

export interface MachineAssistant {
  readonly key: string;
  readonly name: string;
  readonly emoji: string | null;
  readonly tone: AvatarTone;
  readonly projectId: string;
  readonly environmentId: string | null;
  readonly isUno: boolean;
  /** Its computer answers: it can be talked to now. */
  readonly awake: boolean;
  /** The live record (null: its computer sleeps). */
  readonly member: TeamMember | null;
  readonly activity: AssistantActivity | null;
  readonly machine: MachineInfo;
}

export interface MachineInfo {
  readonly key: string;
  readonly environmentId: string | null;
  readonly boxId: number | null;
  readonly label: string;
  readonly kind: MachineKind;
  readonly awake: boolean;
  /** The computer the app looks at now. */
  readonly current: boolean;
}

export interface MachineGroup extends MachineInfo {
  readonly assistants: ReadonlyArray<MachineAssistant>;
}

/** "Uno · MacBook" — the name an assistant goes by in this variant. */
export function assistantFullName(name: string, machineLabel: string): string {
  return machineLabel ? `${name} · ${machineLabel}` : name;
}

function fromMember(member: TeamMember, machine: MachineInfo): MachineAssistant {
  return {
    key: member.key,
    name: member.profile.name,
    emoji: member.profile.emoji,
    tone: member.profile.tone,
    projectId: member.projectId,
    environmentId: member.environmentId,
    isUno: member.isUno,
    awake: true,
    member,
    activity: member.configured ? member.activity : null,
    machine,
  };
}

/**
 * Every computer of the person with its assistants: this one first, awake
 * ones next, sleeping ones last; Uno first on each.
 */
export function useAssistantsByMachine(): ReadonlyArray<MachineGroup> {
  const rows = useMachineRows();
  const team = useAssistantTeam();
  const { environmentId: activeId } = useActiveMachine();

  // Remember what each awake computer has, for when it sleeps.
  useEffect(() => {
    const byEnv = new Map<string, KnownAssistant[]>();
    for (const member of team) {
      if (member.revoked) continue;
      const list = byEnv.get(member.environmentId) ?? [];
      list.push({
        projectId: member.projectId,
        name: member.profile.name,
        emoji: member.profile.emoji,
        tone: member.profile.tone,
      });
      byEnv.set(member.environmentId, list);
    }
    for (const [environmentId, list] of byEnv) writeKnown(environmentId, list);
  }, [team]);

  return useMemo(() => {
    const known = readKnown();
    const groups: MachineGroup[] = rows.map((row) => {
      const boxId = row.box?.id ?? null;
      const live = team.filter(
        (member) => !member.revoked && member.environmentId === row.environmentId,
      );
      const awake = row.status === "online" && live.length > 0;
      const machine: MachineInfo = {
        key: machineCacheKey(row.environmentId, boxId),
        environmentId: row.environmentId,
        boxId,
        label: row.label,
        kind: row.kind,
        awake: row.status === "online",
        current: row.environmentId !== null && row.environmentId === activeId,
      };
      const cached = known[machine.key] ?? (boxId !== null ? known[`box:${boxId}`] : undefined);
      const asleep: ReadonlyArray<KnownAssistant> = cached?.length
        ? cached
        : [{ projectId: ASSISTANT_PROJECT_ID, name: "Uno", emoji: null, tone: "violet" }];
      // An awake computer whose list hasn't come yet shows nothing (no flash of "asleep").
      const assistants: MachineAssistant[] = awake
        ? live.map((member) => fromMember(member, machine))
        : row.status === "online"
          ? []
          : asleep.map((item) => ({
              key: `${machine.key}:${item.projectId}`,
              name: item.name,
              emoji: item.emoji,
              tone: item.tone,
              projectId: item.projectId,
              environmentId: row.environmentId,
              isUno: item.projectId === ASSISTANT_PROJECT_ID,
              awake: false,
              member: null,
              activity: null,
              machine: { ...machine, awake: false },
            }));
      return { ...machine, awake, assistants };
    });
    const rank = (group: MachineGroup) => (group.current ? 0 : group.awake ? 1 : 2);
    return groups
      .filter((group) => group.assistants.length > 0)
      .toSorted((a, b) => rank(a) - rank(b));
  }, [activeId, rows, team]);
}

/** The assistant a chat belongs to (Uno too), with its computer — or null. */
export function useAssistantOfThread(
  environmentId: string,
  threadId: string,
): { readonly member: TeamMember; readonly machineLabel: string } | null {
  const projectId = useStore(
    (state) =>
      selectSidebarThreadsAcrossEnvironments(state).find(
        (thread) => thread.environmentId === environmentId && thread.id === threadId,
      )?.projectId ?? null,
  );
  const team = useAssistantTeam();
  const machines = useMachineRows();
  if (projectId === null) return null;
  const member =
    team.find((item) => item.environmentId === environmentId && item.projectId === projectId) ??
    null;
  if (member === null) return null;
  const label =
    machines.find((row) => row.environmentId === environmentId)?.label ?? member.computerLabel;
  return { member, machineLabel: label };
}

/** The account's plan ("free", "plus"…), null while unknown. */
export function useAccountPlan(): string | null {
  const plan = useQuery({
    queryKey: ["uno-account", "subscription", "assistants-b"],
    queryFn: fetchSubscription,
    staleTime: 60_000,
    retry: false,
  });
  return plan.data?.plan ?? null;
}

// ── Opening one ──────────────────────────────────────────────────────────

/** The sheet that explains a sleeping assistant (one for the whole app). */
export const useAsleepSheet = create<{
  readonly open: MachineAssistant | null;
  readonly show: (assistant: MachineAssistant | null) => void;
}>((set) => ({ open: null, show: (open) => set({ open }) }));

/** Opens its chat (its latest conversation, else its main one); a sleeping one explains itself. */
export function useOpenMachineAssistant() {
  const navigate = useNavigate();
  return useCallback(
    async (assistant: MachineAssistant) => {
      if (!assistant.awake || assistant.environmentId === null || assistant.member === null) {
        useAsleepSheet.getState().show(assistant);
        return;
      }
      const environmentId = assistant.environmentId as EnvironmentId;
      const latest = assistant.member.chats.conversations[0] ?? null;
      const threadId =
        latest?.id ??
        (
          await ensureAssistantChat({
            environmentId,
            projectId: assistant.projectId as ProjectId,
          })
        ).threadId;
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({ environmentId, threadId: threadId as ThreadId }),
      });
    },
    [navigate],
  );
}

/** "Others are in the computer switcher" — the switcher listens for this. */
export const OPEN_COMPUTER_SWITCHER_EVENT = "uno:open-computer-switcher";
export function openComputerSwitcher() {
  window.dispatchEvent(new Event(OPEN_COMPUTER_SWITCHER_EVENT));
}
