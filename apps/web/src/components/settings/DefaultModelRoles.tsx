/**
 * Settings → AI → "Default model" by role (14.11, Misha on T41 v3: "the
 * defaults depend on the plans you have; with several harnesses let me pick
 * a different one per job"). Three roles:
 *
 * - Complex tasks and new chats — the "Default model" itself
 *   (`defaultModelSelection`, NewChatDefaultsRows.tsx);
 * - Simple tasks — the "Simple tasks" row of each assistant's ROUTING.md on
 *   this computer, set as the person's own row (the server applies it,
 *   personRouting.ts);
 * - Assistant replies — what the assistant itself answers with (Hermes' AI).
 *
 * On top, the set Uno suggests for the plans connected here
 * (shared/modelRoles.ts) with one "Use these"; below, the person's own
 * ROUTING.md rules as applied, and the folds (by kind of task, Advanced).
 *
 * @module components/settings/DefaultModelRoles
 */
import {
  ASSISTANT_PROJECT_ID,
  type EnvironmentId,
  type ModelSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { sameSelection, simpleTaskRule, suggestRoles } from "@t3tools/shared/modelRoles";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";

import { useAssistantLlm } from "../../assistant/useAssistantLlm";
import { useEnvironmentSettings } from "../../environments/settings/serverSettings";
import { AppliedRules, saveSimpleTaskRow, useRouting } from "../assistants/AssistantMemoryModels";
import { AssistantModelPicker } from "../chat/AssistantEngine";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { DefaultModelFolds } from "./DefaultModelFolds";
import {
  DefaultModelControl,
  defaultModelStatus,
  modelSelectionLabel,
  useDefaultModelState,
} from "./NewChatDefaultsRows";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { isReadyHere, useAssistantProjectIdsHere } from "./useAutoModelRoles";

function RoleLine(props: {
  readonly title: string;
  readonly hint: ReactNode;
  readonly control: ReactNode;
  readonly testId: string;
}) {
  return (
    <div
      className="flex flex-col gap-1.5 border-t border-border/60 py-2.5 sm:flex-row sm:items-center sm:justify-between"
      data-testid={props.testId}
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-foreground">{props.title}</p>
        <p className="text-[11px] text-muted-foreground">{props.hint}</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
        {props.control}
      </div>
    </div>
  );
}

export function DefaultModelRoles({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const state = useDefaultModelState(environmentId);
  const { providers, effective, auto, picker, pickerEnvironmentId, save, scope, setHere } = state;
  const llm = useAssistantLlm(environmentId);
  const queryClient = useQueryClient();
  const uno = useRouting(environmentId, ASSISTANT_PROJECT_ID, "Uno");
  const [applying, setApplying] = useState(false);

  const unoReplies = llm.supported && llm.status?.gatewayConfigured === true;
  const roles = useMemo(
    () => suggestRoles({ providers, isReady: isReadyHere, unoReplies }),
    [providers, unoReplies],
  );

  // Every assistant on this computer gets the same "Simple tasks" row.
  const projectIds = useAssistantProjectIdsHere(environmentId);
  const unoSetAt = useEnvironmentSettings(environmentId)?.modelRolesPreset?.appliedAt ?? null;

  const complexNow = effective ?? auto;
  const simpleRow = simpleTaskRule(uno.parsed.rules);
  const simpleNow: ModelSelection | null =
    simpleRow && simpleRow.harness && simpleRow.model
      ? { instanceId: ProviderInstanceId.make(simpleRow.harness), model: simpleRow.model }
      : null;
  const repliesNow = llm.status ? { provider: llm.status.provider, model: llm.status.model } : null;

  const complexInUse = roles.complex === null || sameSelection(complexNow, roles.complex);
  const simpleInUse = roles.simple === null || sameSelection(simpleNow, roles.simple);
  const repliesInUse =
    roles.replies === null ||
    (repliesNow?.provider === roles.replies.provider && repliesNow.model === roles.replies.model);
  const allInUse = complexInUse && simpleInUse && repliesInUse;

  const saveSimple = async (selection: ModelSelection) => {
    await saveSimpleTaskRow({ environmentId, projectIds, selection, queryClient });
  };

  const applySuggested = async () => {
    setApplying(true);
    try {
      if (!complexInUse && roles.complex) {
        // Auto already gives it: leave Auto on; else the suggested model.
        save(sameSelection(auto, roles.complex) ? null : roles.complex);
      }
      if (!simpleInUse && roles.simple) await saveSimple(roles.simple);
      if (!repliesInUse && roles.replies) await llm.setLlm(roles.replies);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't apply all of it",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setApplying(false);
    }
  };

  // The row's model when it can run here; else what Uno suggests (a template
  // row for Claude on a computer with only Uno AI says nothing useful).
  const simpleHere =
    simpleNow !== null &&
    providers.some(
      (provider) =>
        provider.instanceId === simpleNow.instanceId &&
        isReadyHere(provider) &&
        provider.models.some((model) => model.slug === simpleNow.model),
    );
  const simpleShown = simpleHere ? simpleNow : roles.simple;
  const simpleHint = [
    "Small fixes and quick jobs your assistant hands out.",
    simpleRow?.source === "you"
      ? "Your pick, saved in ROUTING.md."
      : simpleHere && simpleNow
        ? `Now the table's starting point, ${modelSelectionLabel(providers, simpleNow)}.`
        : simpleNow && roles.simple
          ? "The table's starting point isn't on this computer: Use these, or pick one."
          : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <SettingsRow
      title="Default model"
      description={
        <>
          {roles.why}{" "}
          {allInUse && roles.sources.length > 0 ? (
            <span className="text-success-foreground">
              {unoSetAt ? "In use: Uno set it when your plans connected." : "In use."}
            </span>
          ) : null}
        </>
      }
      settingKeys={["defaultModelSelection"]}
      mixed={state.mixed}
      status={defaultModelStatus(state)}
      resetAction={
        scope.kind === "environment" && setHere ? (
          <SettingResetButton label="the default model" onClick={() => save(null)} />
        ) : null
      }
      control={
        !allInUse && roles.sources.length > 0 ? (
          <Button
            size="sm"
            variant="outline"
            disabled={applying}
            onClick={() => void applySuggested()}
            data-testid="settings-roles-use-suggested"
          >
            Use these
          </Button>
        ) : null
      }
    >
      <div className="mt-3 flex flex-col" data-testid="settings-model-roles">
        <RoleLine
          testId="settings-role-complex"
          title="Complex tasks and new chats"
          hint="New chats, the chats your assistant starts and automations. A pick inside a chat changes only that chat."
          control={<DefaultModelControl state={state} />}
        />
        <RoleLine
          testId="settings-role-simple"
          title="Simple tasks"
          hint={simpleHint}
          control={
            simpleShown ? (
              <ProviderModelPicker
                compact
                activeInstanceId={simpleShown.instanceId}
                model={simpleShown.model}
                lockedProvider={null}
                instanceEntries={picker.instanceEntries}
                environmentId={pickerEnvironmentId}
                modelOptionsByInstance={picker.modelOptionsByInstance}
                onInstanceModelChange={(instanceId, model) =>
                  void saveSimple({ instanceId, model }).catch((error: unknown) =>
                    toastManager.add({
                      type: "error",
                      title: "Couldn't save",
                      description: error instanceof Error ? error.message : String(error),
                    }),
                  )
                }
                triggerVariant="outline"
              />
            ) : (
              <span className="text-xs text-muted-foreground">No AI on this computer yet</span>
            )
          }
        />
        {llm.supported ? (
          <RoleLine
            testId="settings-role-replies"
            title="Assistant replies"
            hint="What your assistant answers you with in its own chat. A quick model keeps replies fast; the work goes to the models above."
            control={
              <AssistantModelPicker environmentId={environmentId} testId="settings-assistant-ai" />
            }
          />
        ) : null}
        <div className="border-t border-border/60 py-2.5 empty:hidden">
          <AppliedRules name="Uno" routing={uno} compact />
        </div>
      </div>
      <DefaultModelFolds environmentId={environmentId} />
    </SettingsRow>
  );
}
