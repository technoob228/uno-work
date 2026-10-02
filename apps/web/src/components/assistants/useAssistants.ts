/**
 * Assistants across the account (assistants MVP): every computer with the
 * role `assistant`, joined with what this interface knows about it — is it
 * connected here, is its assistant working or waiting for the person.
 */
import { ASSISTANT_PROJECT_ID, type EnvironmentId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { accountTransport } from "../../account/unoAccount";
import { ensureAssistantChatWhenReady } from "../../assistant/assistantChat.logic";
import { isPrimaryEnvironmentId } from "../../environments/http/target";
import { useSavedEnvironmentRuntimeStore } from "../../environments/runtime";
import { updateEnvironmentSettings } from "../../environments/settings/serverSettings";
import { useMachineRows } from "../../hooks/useMachineRows";
import {
  createAssistantSchedule,
  fetchAssistantsEnabled,
  getConnectorPermissions,
  listAssistantComputers,
  putConnectorPermissions,
  type AssistantComputer,
} from "../../lib/assistantsConsoleApi";
import { assistantsDemo, isAssistantsDemo } from "../../lib/assistantsDemo";
import { ensureAssistantChat, readAssistantFile, writeAssistantFile } from "../../lib/managerApi";
import { getServerConfig } from "../../rpc/serverState";
import { useStore } from "../../store";
import { createUnoBoxAndConnect } from "../../unoBoxCreation";
import { isUnoBoxStillStartingError } from "../../unoBoxConnect";
import { EMPTY_SETUP_PROGRESS } from "../setup/setupModel";
import {
  assistantBoxName,
  assistantStatus,
  type AssistantPlan,
  type AssistantStatus,
} from "./assistantTemplates";
import type { CreateAssistantDeps, CreateStage } from "./createAssistant";

export const ASSISTANT_COMPUTERS_KEY = ["uno-assistants", "computers"] as const;

/** The account can make computers from here (signed in, or the demo stand). */
export function canCreateAssistantComputers(): boolean {
  return isAssistantsDemo || accountTransport() !== "none";
}

export type AssistantsAvailability = "loading" | "on" | "not-yet" | "no-account";

/**
 * Can this person get an assistant on its own computer: signed in here, and
 * the account has the assistants update (`/auth/me` features).
 */
export function useAssistantsAvailability(): AssistantsAvailability {
  const signedIn = canCreateAssistantComputers();
  const feature = useQuery({
    queryKey: ["uno-assistants", "enabled"],
    queryFn: fetchAssistantsEnabled,
    enabled: signedIn,
    staleTime: 60_000,
    retry: false,
  });
  if (!signedIn) return "no-account";
  if (feature.isLoading) return "loading";
  return feature.data === true ? "on" : "not-yet";
}

export function useAssistantComputers() {
  return useQuery({
    queryKey: ASSISTANT_COMPUTERS_KEY,
    queryFn: () => listAssistantComputers(),
    enabled: canCreateAssistantComputers(),
    refetchInterval: 15_000,
    retry: false,
  });
}

const NO_COMPUTERS: ReadonlyArray<AssistantComputer> = [];

export interface AssistantListItem {
  readonly computer: AssistantComputer;
  /** Connected here and answering; null = asleep or not connected yet. */
  readonly environmentId: EnvironmentId | null;
  readonly status: AssistantStatus;
}

function environmentForBox(
  rows: ReturnType<typeof useMachineRows>,
  boxId: number,
): { environmentId: EnvironmentId | null; online: boolean } {
  const row = rows.find((candidate) => candidate.box?.id === boxId);
  return {
    environmentId: row?.environmentId ?? null,
    online: row?.status === "online" && row.environmentId !== null,
  };
}

/** Assistants the person deleted that are still kept (Restore is possible). */
export function useDeletedAssistants(): ReadonlyArray<AssistantComputer> {
  const all = useAssistantComputers().data ?? NO_COMPUTERS;
  return useMemo(() => all.filter((computer) => Boolean(computer.deletedAt)), [all]);
}

export function useAssistantList(
  activeEnvironmentId: EnvironmentId | null,
): ReadonlyArray<AssistantListItem> {
  const all = useAssistantComputers().data ?? NO_COMPUTERS;
  const computers = useMemo(() => all.filter((computer) => !computer.deletedAt), [all]);
  const rows = useMachineRows();
  // One word per computer ("waiting" / "working" / "idle") keeps the
  // selector shallow-comparable while threads stream.
  const activityByEnvironment = useStore(
    useShallow((state) => {
      const out: Record<string, "waiting" | "working" | "idle"> = {};
      for (const [environmentId, environmentState] of Object.entries(state.environmentStateById)) {
        const ids = environmentState.threadIdsByProjectId[ASSISTANT_PROJECT_ID] ?? [];
        const threads = ids.flatMap((id) => {
          const thread = environmentState.sidebarThreadSummaryById[id];
          return thread ? [thread] : [];
        });
        out[environmentId] = threads.some((t) => t.hasPendingApprovals || t.hasPendingUserInput)
          ? "waiting"
          : threads.some((t) => t.session?.status === "running")
            ? "working"
            : "idle";
      }
      return out;
    }),
  );
  return useMemo(
    () =>
      computers.map((computer) => {
        // The demo's computers are this one.
        const target = isAssistantsDemo
          ? { environmentId: activeEnvironmentId, online: activeEnvironmentId !== null }
          : environmentForBox(rows, computer.boxId);
        const activity =
          target.online && target.environmentId
            ? (activityByEnvironment[target.environmentId] ?? "idle")
            : "idle";
        const threads = [
          {
            hasPendingApprovals: activity === "waiting",
            hasPendingUserInput: false,
            session: activity === "working" ? { status: "running" } : null,
          },
        ];
        return {
          computer,
          environmentId: target.online ? target.environmentId : null,
          status: assistantStatus({ boxStatus: computer.status, threads }),
        };
      }),
    [activeEnvironmentId, activityByEnvironment, computers, rows],
  );
}

/** The box the computer this page talks to is, if it is one. */
export function useBoxIdOfEnvironment(environmentId: EnvironmentId | null): number | null {
  const rows = useMachineRows();
  return rows.find((row) => row.environmentId === environmentId)?.box?.id ?? null;
}

function readSetup(environmentId: EnvironmentId) {
  const config = isPrimaryEnvironmentId(environmentId)
    ? getServerConfig()
    : (useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.serverConfig ?? null);
  return config?.settings.setup ?? EMPTY_SETUP_PROGRESS;
}

/** The setup steps that run on the assistant's own computer (also "Finish setup"). */
export const computerSetupDeps: Pick<
  CreateAssistantDeps,
  "ensureAssistant" | "readFile" | "writeFile" | "readSetup" | "saveSetup"
> = {
  ensureAssistant: async (environmentId) =>
    (await ensureAssistantChatWhenReady(() => ensureAssistantChat({ environmentId }), {
      waitMs: 60_000,
      retryMs: 2_000,
    })) !== null,
  readFile: (environmentId, name) =>
    readAssistantFile({ environmentId, projectId: ASSISTANT_PROJECT_ID, name }).then(
      (file) => file.content,
    ),
  writeFile: (environmentId, name, content) =>
    writeAssistantFile({ environmentId, projectId: ASSISTANT_PROJECT_ID, name, content }).then(
      () => undefined,
    ),
  readSetup,
  saveSetup: (environmentId, setup) => updateEnvironmentSettings(environmentId, { setup }),
};

export function makeCreateAssistantDeps(
  accountEnvironmentId: EnvironmentId,
  plan: AssistantPlan,
  onStage: (stage: CreateStage) => void,
): CreateAssistantDeps {
  const label = { name: plan.name, emoji: plan.emoji, template: plan.template };
  return {
    ...computerSetupDeps,
    createComputer: async () => {
      const boxName = assistantBoxName(plan.name);
      if (isAssistantsDemo) {
        const boxId = await assistantsDemo.addComputer({
          boxName,
          status: "running",
          label,
          createdAt: new Date().toISOString(),
        });
        return { boxId, environmentId: accountEnvironmentId };
      }
      try {
        const { status, record } = await createUnoBoxAndConnect(accountEnvironmentId, {
          name: boxName,
          preset: "medium",
          computerRole: "assistant",
          assistant: { ...label, template: plan.template ?? "custom" },
        });
        const boxId = record.unoBoxId ?? status.boxId ?? status.box?.id;
        if (boxId == null) throw new Error("Uno made the computer but didn't say which one.");
        return { boxId, environmentId: record.environmentId };
      } catch (cause) {
        if (isUnoBoxStillStartingError(cause)) return { boxId: cause.boxId, environmentId: null };
        throw cause;
      }
    },
    getPermissions: getConnectorPermissions,
    putPermissions: putConnectorPermissions,
    createSchedule: createAssistantSchedule,
    onStage,
  };
}
