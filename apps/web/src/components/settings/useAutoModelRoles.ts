/**
 * Uno applies the model set for the plans connected here by itself (Misha
 * 14.11, T41 v4): the first time a computer has any AI — only Uno AI gets
 * Smart / Fast without pressing "Use these" — and again when the person's
 * first own plan (Claude, ChatGPT) appears. A role the person set is never
 * changed; later changes wait for "Use these" (DefaultModelRoles.tsx). What
 * to do is shared/modelRoles.ts `planAutoRoles`; what Uno set is remembered
 * on the computer (`modelRolesPreset`).
 *
 * Runs for the computer in view, once per session and state.
 *
 * @module components/settings/useAutoModelRoles
 */
import {
  ASSISTANT_PROJECT_ID,
  type EnvironmentId,
  type ModelSelection,
  ProviderInstanceId,
  type ServerProvider,
  isProviderAvailable,
} from "@t3tools/contracts";
import { planAutoRoles, simpleTaskRule, suggestRoles } from "@t3tools/shared/modelRoles";
import { parseRouting } from "@t3tools/shared/assistantMemory";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";

import { useAssistantLlm } from "../../assistant/useAssistantLlm";
import {
  updateEnvironmentSettings,
  useEnvironmentProviders,
  useEnvironmentSettings,
} from "../../environments/settings/serverSettings";
import { useSettings } from "../../hooks/useSettings";
import { saveSimpleTaskRow, useAssistantFile } from "../assistants/AssistantMemoryModels";
import { useAssistantTeam, useTeamShown } from "../assistants/useAssistantTeam";
import { autoNewChatSelection } from "../computer/home/homeStartModel";
import { toastManager } from "../ui/toast";

/** A harness that can take a chat now; sign-ins are modelRoles' to check. */
export function isReadyHere(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    isProviderAvailable(provider) &&
    provider.status !== "disabled" &&
    provider.status !== "error" &&
    provider.models.length > 0
  );
}

/**
 * Still finding out: Claude Code installed and on, its sign-in not checked
 * yet. Deciding now could take a Claude plan for "only Uno AI".
 */
export function plansStillLoading(providers: ReadonlyArray<ServerProvider>): boolean {
  return (
    providers.length === 0 ||
    providers.some(
      (provider) =>
        provider.driver === "claudeAgent" &&
        provider.enabled &&
        provider.installed &&
        provider.auth.status === "unknown",
    )
  );
}

/** The assistants on this computer (Uno first): each has its own ROUTING.md. */
export function useAssistantProjectIdsHere(environmentId: EnvironmentId): ReadonlyArray<string> {
  const team = useAssistantTeam();
  const teamShown = useTeamShown();
  return useMemo(() => {
    const ids = teamShown
      ? team
          .filter((member) => member.environmentId === environmentId && !member.revoked)
          .map((member) => member.projectId)
      : [];
    return ids.includes(ASSISTANT_PROJECT_ID) ? ids : [ASSISTANT_PROJECT_ID, ...ids];
  }, [team, teamShown, environmentId]);
}

export function useAutoModelRoles(environmentId: EnvironmentId): void {
  const providers = useEnvironmentProviders(environmentId);
  const settings = useEnvironmentSettings(environmentId);
  const appChoice = useSettings((value) => value.newChatModelSelection);
  const llm = useAssistantLlm(environmentId);
  const routing = useAssistantFile(environmentId, ASSISTANT_PROJECT_ID, "ROUTING.md");
  const projectIds = useAssistantProjectIdsHere(environmentId);
  const queryClient = useQueryClient();
  const tried = useRef(new Set<string>());

  const unoReplies = llm.supported && llm.status?.gatewayConfigured === true;
  const llmKnown = !llm.supported || llm.status !== null || llm.error !== null;
  const routingKnown = !routing.file.isLoading;
  const content = routing.file.isError ? "" : (routing.file.data ?? "");

  useEffect(() => {
    if (settings === null || !llmKnown || !routingKnown || plansStillLoading(providers)) return;
    const roles = suggestRoles({ providers, isReady: isReadyHere, unoReplies });
    const preset = settings.modelRolesPreset ?? null;
    const row = content.trim() === "" ? undefined : simpleTaskRule(parseRouting(content).rules);
    const plan = planAutoRoles({
      roles,
      autoComplex: autoNewChatSelection(providers),
      preset,
      current: {
        complex: settings.defaultModelSelection ?? appChoice,
        ...(row === undefined
          ? {}
          : {
              simple:
                row === null
                  ? null
                  : {
                      selection:
                        row.harness && row.model
                          ? { instanceId: ProviderInstanceId.make(row.harness), model: row.model }
                          : null,
                      mine: row.source === "you",
                    },
            }),
        ...(llm.supported && llm.status
          ? { replies: { provider: llm.status.provider, model: llm.status.model } }
          : {}),
      },
      now: new Date().toISOString(),
    });
    if (plan === null) return;
    const key = `${environmentId}|${plan.preset.sources.join(",")}|${preset?.appliedAt ?? ""}`;
    if (tried.current.has(key)) return;
    tried.current.add(key);

    void (async () => {
      let changed = false;
      try {
        if (plan.complex !== undefined) {
          await updateEnvironmentSettings(environmentId, {
            defaultModelSelection: plan.complex as ModelSelection | null,
          });
          changed = true;
        }
        if (plan.simple !== undefined) {
          await saveSimpleTaskRow({
            environmentId,
            projectIds,
            selection: plan.simple,
            queryClient,
            auto: { unoSet: preset?.simple ?? null },
          });
          changed = true;
        }
        if (plan.replies !== undefined) {
          await llm.setLlm(plan.replies);
          changed = true;
        }
        // Last: a step that failed is tried again next time.
        await updateEnvironmentSettings(environmentId, { modelRolesPreset: plan.preset });
        if (changed) {
          toastManager.add({
            type: "success",
            title: "Models set for your plans",
            description: `${roles.why} Change any of them in Settings → AI.`,
          });
        }
      } catch {
        // Quietly: "Use these" in Settings → AI still offers the set.
      }
    })();
  }, [
    environmentId,
    settings,
    appChoice,
    providers,
    unoReplies,
    llm,
    llmKnown,
    routingKnown,
    content,
    projectIds,
    queryClient,
  ]);
}
