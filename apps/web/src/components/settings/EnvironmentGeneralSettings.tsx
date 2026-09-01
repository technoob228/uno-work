/**
 * The settings one environment's daemon owns: its Uno credentials, the
 * defaults it applies to new work, the model it uses for generated text, and
 * the files it keeps on its own disk.
 *
 * Everything here is read from and written to the environment named in the
 * URL. Actions that only make sense on the machine the user is sitting at —
 * opening a file in a local editor — say so instead of quietly operating on
 * the local daemon's copy.
 *
 * @module components/settings/EnvironmentGeneralSettings
 */
import { type EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { useCallback, useMemo, useState } from "react";

import {
  useEnvironmentProviders,
  useEnvironmentServerConfig,
  useEnvironmentSettings,
  useUpdateEnvironmentSettings,
} from "~/environments/settings/serverSettings";
import { isPrimaryEnvironmentId } from "~/environments/http/target";
import { useSettings } from "~/hooks/useSettings";
import { resolveAndPersistPreferredEditor } from "~/editorPreferences";
import { ensureLocalApi } from "~/localApi";
import { getCustomModelOptionsByInstance, resolveAppModelSelectionState } from "~/modelSelection";
import { deriveProviderInstanceEntries, sortProviderInstanceEntries } from "~/providerInstances";
import { useServerAvailableEditors } from "~/rpc/serverState";

import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { UnoGatewayBalance } from "./SettingsPanels";

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");

/** Shown where an action can only ever act on the machine running the app. */
function LocalOnlyNote({ what }: { readonly what: string }) {
  return (
    <span className="mt-1 block text-muted-foreground">
      {what} is available on this device only.
    </span>
  );
}

export function EnvironmentGeneralSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const config = useEnvironmentServerConfig(environmentId);
  const serverSettings = useEnvironmentSettings(environmentId);
  const providers = useEnvironmentProviders(environmentId);
  const { updateSettings, mutationBlockedReason } = useUpdateEnvironmentSettings(environmentId);
  const clientSettings = useSettings();
  const availableEditors = useServerAvailableEditors();

  const [openError, setOpenError] = useState<string | null>(null);
  const [isOpening, setIsOpening] = useState(false);

  const isLocalDaemon = isPrimaryEnvironmentId(environmentId);
  const settings = serverSettings ?? DEFAULT_UNIFIED_SETTINGS;
  const unoApiKey = settings.uno?.apiKey ?? "";
  const observability = config?.observability ?? null;
  const keybindingsConfigPath = config?.keybindingsConfigPath ?? null;
  const logsDirectoryPath = observability?.logsDirectoryPath ?? null;

  const save = useCallback(
    (patch: Parameters<typeof updateSettings>[0], title: string) => {
      void updateSettings(patch).catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title,
          description: error instanceof Error ? error.message : String(error),
        });
      });
    },
    [updateSettings],
  );

  // The model pickers read device-local preferences (hidden models, order)
  // alongside the environment's own selection, so they get both.
  const mergedForModelPickers = useMemo(
    () => ({ ...clientSettings, ...settings }),
    [clientSettings, settings],
  );
  const modelSelection = resolveAppModelSelectionState(mergedForModelPickers, providers);
  const instanceEntries = sortProviderInstanceEntries(deriveProviderInstanceEntries(providers));
  const selectedEntry = instanceEntries.find(
    (entry) => entry.instanceId === modelSelection.instanceId,
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    mergedForModelPickers,
    providers,
    modelSelection.instanceId,
    modelSelection.model,
  );
  const isTextGenerationDirty =
    JSON.stringify(settings.textGenerationModelSelection ?? null) !==
    JSON.stringify(DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null);

  const openLogsDirectory = useCallback(() => {
    if (!logsDirectoryPath) return;
    setOpenError(null);
    setIsOpening(true);
    const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
    if (!editor) {
      setOpenError("No available editors found.");
      setIsOpening(false);
      return;
    }
    void ensureLocalApi()
      .shell.openInEditor(logsDirectoryPath, editor)
      .catch((error: unknown) => {
        setOpenError(error instanceof Error ? error.message : "Unable to open logs folder.");
      })
      .finally(() => setIsOpening(false));
  }, [availableEditors, logsDirectoryPath]);

  const diagnosticsDescription = (() => {
    const exports: string[] = [];
    if (observability?.otlpTracesEnabled && observability.otlpTracesUrl) {
      exports.push(`traces to ${observability.otlpTracesUrl}`);
    }
    if (observability?.otlpMetricsEnabled && observability.otlpMetricsUrl) {
      exports.push(`metrics to ${observability.otlpMetricsUrl}`);
    }
    const mode = observability?.localTracingEnabled ? "Local trace file" : "Terminal logs only";
    return exports.length > 0 ? `${mode}. OTLP exporting ${exports.join(" and ")}.` : `${mode}.`;
  })();

  return (
    <SettingsPageContainer>
      {mutationBlockedReason ? (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 text-xs text-amber-700 dark:text-amber-400">
          {mutationBlockedReason}
        </p>
      ) : null}

      <SettingsSection title="Uno account">
        {unoApiKey.length > 0 ? (
          <SettingsRow
            title="Balance"
            description="Uno LLM Gateway credits. Each model call and web search is billed from this balance."
            control={<UnoGatewayBalance apiKey={unoApiKey} />}
          />
        ) : null}

        <SettingsRow
          title="API key"
          description="Used by Uno Code on this environment to call the Uno LLM Gateway. Stored in plain text on that machine's disk."
          resetAction={
            unoApiKey.length > 0 ? (
              <SettingResetButton
                label="Uno API key"
                onClick={() => save({ uno: { apiKey: "" } }, "Could not clear the API key")}
              />
            ) : null
          }
          control={
            <DraftInput
              type="password"
              className="w-full sm:w-72"
              value={unoApiKey}
              onCommit={(next) => save({ uno: { apiKey: next } }, "Could not save the API key")}
              placeholder="Paste your Uno API key…"
              spellCheck={false}
              autoComplete="off"
              aria-label="Uno API key"
            />
          }
        />

        <SettingsRow
          title="Web search"
          description={
            unoApiKey.length > 0
              ? "Enabled — Uno harness exposes a `web_search` tool (Brave-powered). Each query is billed against your Uno LLM balance."
              : "Add an API key above to let the Uno harness search the web through Uno's billed proxy."
          }
          control={
            <span
              className={
                unoApiKey.length > 0
                  ? "rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400"
                  : "rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
              }
            >
              {unoApiKey.length > 0 ? "Active" : "Inactive"}
            </span>
          }
        />
      </SettingsSection>

      <SettingsSection title="Defaults for new work">
        <SettingsRow
          title="Assistant output"
          description="Show token-by-token output while a response is in progress."
          resetAction={
            settings.enableAssistantStreaming !==
            DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming ? (
              <SettingResetButton
                label="assistant output"
                onClick={() =>
                  save(
                    {
                      enableAssistantStreaming: DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming,
                    },
                    "Could not save assistant output",
                  )
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableAssistantStreaming}
              onCheckedChange={(checked) =>
                save(
                  { enableAssistantStreaming: Boolean(checked) },
                  "Could not save assistant output",
                )
              }
              aria-label="Stream assistant messages"
            />
          }
        />

        <SettingsRow
          title="New threads"
          description="Pick the default workspace mode for newly created draft threads on this environment."
          resetAction={
            settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode ? (
              <SettingResetButton
                label="new threads"
                onClick={() =>
                  save(
                    { defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode },
                    "Could not save the thread default",
                  )
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.defaultThreadEnvMode}
              onValueChange={(value) => {
                if (value === "local" || value === "worktree") {
                  save({ defaultThreadEnvMode: value }, "Could not save the thread default");
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-44" aria-label="Default thread mode">
                <SelectValue>
                  {settings.defaultThreadEnvMode === "worktree" ? "New worktree" : "Local"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="local">
                  Local
                </SelectItem>
                <SelectItem hideIndicator value="worktree">
                  New worktree
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Add project starts in"
          description='A path on this environment. Leave empty to use "~/" when the Add Project browser opens.'
          resetAction={
            settings.addProjectBaseDirectory !==
            DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory ? (
              <SettingResetButton
                label="add project base directory"
                onClick={() =>
                  save(
                    { addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory },
                    "Could not save the base directory",
                  )
                }
              />
            ) : null
          }
          control={
            <DraftInput
              className="w-full sm:w-72"
              value={settings.addProjectBaseDirectory}
              onCommit={(next) =>
                save({ addProjectBaseDirectory: next }, "Could not save the base directory")
              }
              placeholder="~/"
              spellCheck={false}
              aria-label="Add project base directory"
            />
          }
        />

        <SettingsRow
          title="Text generation model"
          description="Model this environment uses for generated commit messages, PR titles, and similar Git text."
          resetAction={
            isTextGenerationDirty ? (
              <SettingResetButton
                label="text generation model"
                onClick={() =>
                  save(
                    {
                      textGenerationModelSelection:
                        DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                    },
                    "Could not reset the text generation model",
                  )
                }
              />
            ) : null
          }
          control={
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <ProviderModelPicker
                activeInstanceId={modelSelection.instanceId}
                model={modelSelection.model}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onInstanceModelChange={(instanceId, model) =>
                  save(
                    {
                      textGenerationModelSelection: resolveAppModelSelectionState(
                        {
                          ...mergedForModelPickers,
                          textGenerationModelSelection: createModelSelection(instanceId, model),
                        },
                        providers,
                      ),
                    },
                    "Could not save the text generation model",
                  )
                }
              />
              <TraitsPicker
                provider={selectedEntry?.driverKind ?? DEFAULT_DRIVER_KIND}
                models={selectedEntry?.models ?? []}
                model={modelSelection.model}
                prompt=""
                onPromptChange={() => {}}
                modelOptions={modelSelection.options}
                allowPromptInjectedEffort={false}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onModelOptionsChange={(nextOptions) =>
                  save(
                    {
                      textGenerationModelSelection: resolveAppModelSelectionState(
                        {
                          ...mergedForModelPickers,
                          textGenerationModelSelection: createModelSelection(
                            modelSelection.instanceId,
                            modelSelection.model,
                            nextOptions,
                          ),
                        },
                        providers,
                      ),
                    },
                    "Could not save the text generation model",
                  )
                }
              />
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection title="Files on this environment">
        <SettingsRow
          title="Keybindings"
          description="The persisted `keybindings.json` this daemon reads."
          status={
            <>
              <span className="block break-all font-mono text-[11px] text-foreground">
                {keybindingsConfigPath ?? "Resolving keybindings path…"}
              </span>
              {!isLocalDaemon ? <LocalOnlyNote what="Opening the file in an editor" /> : null}
            </>
          }
        />

        <SettingsRow
          title="Diagnostics"
          description={diagnosticsDescription}
          status={
            <>
              <span className="block break-all font-mono text-[11px] text-foreground">
                {logsDirectoryPath ?? "Resolving logs directory…"}
              </span>
              {openError ? <span className="mt-1 block text-destructive">{openError}</span> : null}
              {!isLocalDaemon ? <LocalOnlyNote what="Opening the logs folder" /> : null}
            </>
          }
          control={
            isLocalDaemon ? (
              <Button
                size="xs"
                variant="outline"
                disabled={!logsDirectoryPath || isOpening}
                onClick={openLogsDirectory}
              >
                {isOpening ? "Opening…" : "Open logs folder"}
              </Button>
            ) : null
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
