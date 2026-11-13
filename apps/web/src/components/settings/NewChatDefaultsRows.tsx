/**
 * What a new chat starts with: model (the "Default model"), access and where it works. Each row
 * follows the scope sentence, so the same rows serve Settings → AI, a
 * computer's General page and each project's settings.
 *
 * @module components/settings/NewChatDefaultsRows
 */
import {
  DEFAULT_RUNTIME_MODE,
  type EnvironmentId,
  type ModelSelection,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import type { ReactNode } from "react";

import { useEnvironmentProviders } from "../../environments/settings/serverSettings";
import { useSettings } from "../../hooks/useSettings";
import {
  CHAT_WORKSPACE_MODE_EXPLANATIONS,
  CHAT_WORKSPACE_MODE_LABELS,
  PERMISSION_MODE_ORDER,
  PERMISSION_MODES,
} from "../../plainLanguage";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { useHomeModelPicker } from "../computer/home/HomeComposer";
import { autoNewChatSelection, newChatModelSelection } from "../computer/home/homeStartModel";
import { Explain } from "../Explain";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedNewChatModel,
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const NEW_CHAT_START_INHERIT = "inherit";
const NEW_CHAT_START_FIXED = "fixed";
const MIXED_VALUE = "mixed";

const MIXED_LABEL = "Different on each";

/** "Claude Opus 5.5": the model's short name as its harness lists it. */
export function modelSelectionLabel(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection,
): string {
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  const model = provider?.models.find((entry) => entry.slug === selection.model);
  return model?.shortName ?? model?.name ?? selection.model;
}

/**
 * "Default model" (13.11 v2, Misha: one setting, not five). The model new
 * chats, the assistant and the chats it starts, and automations run on; a
 * pick inside a chat changes only that chat. Auto (unset) — the strongest
 * model on the person's own Claude or ChatGPT plan here (the app,
 * `autoNewChatSelection`; the server, personRouting.ts), else Uno AI.
 *
 * Same storage as the old "New chats start on" (Misha 15.10): the app's
 * `newChatModelSelection` and each computer's `defaultModelSelection`, which
 * the server reads for the assistant's work. `children`: what folds inside
 * it on Settings → AI (by kind of task, the assistant's own AI).
 */
export function NewChatModelRow({
  environmentId,
  children,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly children?: ReactNode;
}) {
  const { scope, target, singleComputer } = useSettingsScope();
  const pickerEnvironmentId = target?.environmentId ?? environmentId;
  const picker = useHomeModelPicker(pickerEnvironmentId);
  const providers = useEnvironmentProviders(pickerEnvironmentId);
  const settings = useSettings();
  const update = useUpdateScopedSettings();
  const { effective, mixed, setHere } = useScopedNewChatModel();
  const save = (next: ModelSelection | null) => update({ defaultModelSelection: next });
  const usable =
    effective !== null &&
    newChatModelSelection({
      providers,
      settings: { ...settings, defaultModelSelection: null, newChatModelSelection: null },
      projectChoice: effective,
    }) !== null;
  const isProject = scope.kind === "project";
  const auto = autoNewChatSelection(providers);
  const autoLabel = auto ? `Auto · ${modelSelectionLabel(providers, auto)}` : "Auto";
  const inheritLabel = isProject
    ? "Same as the computer"
    : scope.kind === "environment" && !singleComputer
      ? "Same as all computers"
      : autoLabel;
  const shown = effective ?? auto ?? picker.selection;
  const description: ReactNode = setHere
    ? isProject
      ? "New chats in this project and the work your assistant does in it run on this model. Switching the model inside a chat changes only that chat."
      : "New chats, your assistant and the chats it starts, and automations run on this model. Switching the model inside a chat changes only that chat."
    : effective
      ? `Inherited: ${modelSelectionLabel(providers, effective)}.`
      : "New chats, your assistant and the chats it starts, and automations run on it. Auto picks the strongest model on your own Claude or ChatGPT plan; without one, Uno AI. Switching the model inside a chat changes only that chat.";
  return (
    <SettingsRow
      title="Default model"
      description={description}
      settingKeys={["defaultModelSelection"]}
      mixed={mixed}
      status={
        effective && !usable
          ? "Not available on this computer now, so Auto is used here until it is."
          : null
      }
      resetAction={
        !isProject && scope.kind === "environment" && setHere ? (
          <SettingResetButton label="the default model" onClick={() => save(null)} />
        ) : null
      }
      control={
        shown ? (
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <Select
              value={mixed ? MIXED_VALUE : setHere ? NEW_CHAT_START_FIXED : NEW_CHAT_START_INHERIT}
              onValueChange={(value) => {
                if (value === NEW_CHAT_START_INHERIT) save(null);
                // Starts on what Auto gives now; the effort stays the chat's.
                else if (value === NEW_CHAT_START_FIXED && (!setHere || mixed) && shown) {
                  save({ instanceId: shown.instanceId, model: shown.model });
                }
              }}
            >
              <SelectTrigger
                className="w-full sm:w-56"
                aria-label="Default model"
                data-testid="settings-new-chat-start"
              >
                <SelectValue>
                  {mixed ? MIXED_LABEL : setHere ? "A model I choose" : inheritLabel}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value={NEW_CHAT_START_INHERIT}>
                  {inheritLabel}
                </SelectItem>
                <SelectItem hideIndicator value={NEW_CHAT_START_FIXED}>
                  A model I choose
                </SelectItem>
              </SelectPopup>
            </Select>
            {setHere && effective ? (
              <ProviderModelPicker
                compact
                activeInstanceId={effective.instanceId}
                model={effective.model}
                lockedProvider={null}
                instanceEntries={picker.instanceEntries}
                environmentId={pickerEnvironmentId}
                modelOptionsByInstance={picker.modelOptionsByInstance}
                onInstanceModelChange={(instanceId, model) => save({ instanceId, model })}
                triggerVariant="outline"
              />
            ) : null}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">No AI on this computer yet</span>
        )
      }
    >
      {children}
    </SettingsRow>
  );
}

function isRuntimeMode(value: unknown): value is RuntimeMode {
  return typeof value === "string" && Object.hasOwn(PERMISSION_MODES, value);
}

export function NewChatAccessRow() {
  const { scope } = useSettingsScope();
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["defaultRuntimeMode"]);
  const mode = settings.defaultRuntimeMode;
  return (
    <SettingsRow
      title="Access for new chats"
      description={
        mixed
          ? "Differs across these computers. Pick one to use everywhere here."
          : PERMISSION_MODES[mode].consequence
      }
      settingKeys={["defaultRuntimeMode"]}
      resetAction={
        scope.kind !== "project" && !mixed && mode !== DEFAULT_RUNTIME_MODE ? (
          <SettingResetButton
            label="access for new chats"
            onClick={() => update({ defaultRuntimeMode: DEFAULT_RUNTIME_MODE })}
          />
        ) : null
      }
      control={
        <Select
          value={mixed ? MIXED_VALUE : mode}
          onValueChange={(value) => {
            if (isRuntimeMode(value)) update({ defaultRuntimeMode: value });
          }}
        >
          <SelectTrigger className="w-full sm:w-48" aria-label="Access for new chats">
            <SelectValue>{mixed ? MIXED_LABEL : PERMISSION_MODES[mode].label}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {PERMISSION_MODE_ORDER.map((value) => (
              <SelectItem
                key={value}
                hideIndicator
                value={value}
                title={PERMISSION_MODES[value].consequence}
              >
                {PERMISSION_MODES[value].label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

export function NewChatWorkspaceRow() {
  const { scope } = useSettingsScope();
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["defaultThreadEnvMode"]);
  const mode = settings.defaultThreadEnvMode;
  const defaultMode = DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode;
  return (
    <SettingsRow
      title={
        <span className="inline-flex items-center gap-1.5">
          New chats
          <Explain term="chat" technical />
        </span>
      }
      description="Where a new chat works by default: straight in the project folder, or in a separate copy (a git worktree) so other chats are not disturbed."
      settingKeys={["defaultThreadEnvMode"]}
      resetAction={
        scope.kind !== "project" && !mixed && mode !== defaultMode ? (
          <SettingResetButton
            label="new chats"
            onClick={() => update({ defaultThreadEnvMode: defaultMode })}
          />
        ) : null
      }
      control={
        <Select
          value={mixed ? MIXED_VALUE : mode}
          onValueChange={(value) => {
            if (value === "local" || value === "worktree") {
              update({ defaultThreadEnvMode: value });
            }
          }}
        >
          <SelectTrigger className="w-full sm:w-52" aria-label="Where new chats work">
            <SelectValue>{mixed ? MIXED_LABEL : CHAT_WORKSPACE_MODE_LABELS[mode]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem hideIndicator value="local" title={CHAT_WORKSPACE_MODE_EXPLANATIONS.local}>
              {CHAT_WORKSPACE_MODE_LABELS.local}
            </SelectItem>
            <SelectItem
              hideIndicator
              value="worktree"
              title={CHAT_WORKSPACE_MODE_EXPLANATIONS.worktree}
            >
              {CHAT_WORKSPACE_MODE_LABELS.worktree}
            </SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );
}

/** Rows that only exist per computer step aside for a project or for all computers. */
export function PerComputerNote({ what }: { readonly what: string }) {
  return (
    <p className="px-1 text-xs text-muted-foreground" data-testid="settings-per-computer-note">
      {what} are set per computer. Pick one computer to see them.
    </p>
  );
}
