/**
 * Settings → Apps: which apps on this computer use its AI (the App SDK,
 * docs/app-sdk.md), how much each spent against its limit, how much an app's
 * jobs may do on their own, how much of the account's cloud each app keeps
 * its files in, and turning an app's access off. Plus "AI for apps":
 * the model apps get for answers and the agent that does their jobs.
 *
 * Read from and written to the machine named in the URL: the daemon there
 * keeps the ledger and the tokens.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  APP_SDK_DEFAULT_CHAT_MODEL,
  type AppAiApp,
  type AppAiOverview,
  type AppAiProviderChoice,
  type AppAiProviders,
  type AppAiUpdateInput,
  type AppStorageScope,
  type AppTaskTools,
  type EnvironmentId,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { CloudIcon, SparklesIcon, WandSparklesIcon } from "lucide-react";
import { useCallback, useId, useMemo, useState } from "react";

import {
  useEnvironmentProviders,
  useEnvironmentSettings,
  useUpdateEnvironmentSettings,
} from "~/environments/settings/serverSettings";
import { useSettings } from "~/hooks/useSettings";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import { deriveProviderInstanceEntries, sortProviderInstanceEntries } from "~/providerInstances";

import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import {
  appAiModelsQueryOptions,
  appAiQueryKey,
  appAiQueryOptions,
  appAiUpdate,
  machineAppsQueryOptions,
} from "../computer/computerQueries";
import { useHomeLaunchers } from "../computer/useHomeLaunchers";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  type AddAiTarget,
  MANUAL_LOCAL_VALUE,
  addAiPrompt,
  choiceFromValue,
  choiceValue,
  providerOptions,
  providersSummary,
} from "./appAiProviderModel";
import { formatFileSize } from "../files/fileTypes";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

const TOOLS_LABELS: Record<AppTaskTools, string> = {
  read: "Only look",
  ask: "Ask me for every change",
  edit: "Edit files, ask before commands",
  full: "Do everything on its own",
};

const SCOPE_LABELS: Record<AppStorageScope, string> = {
  account: "Shared across my computers",
  computer: "Only this computer",
};

/** What the cloud folder choice means, in one line under the app. */
export function appStorageScopeHint(scope: AppStorageScope): string {
  return scope === "account"
    ? "Same folder on every computer of yours that has this app"
    : "This computer's own folder. Files in the shared folder stay there";
}

export function formatUsd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(2).replace(/\.00$/, "")}`;
}

/** "Notetaker used $0.40 of $10" — the line a person reads at a glance. */
export function appUsageLine(app: Pick<AppAiApp, "name" | "spentUsd" | "limitUsd">): string {
  return `${app.name} used ${formatUsd(app.spentUsd)} of ${formatUsd(app.limitUsd)}`;
}

/**
 * "answers $0.10, jobs $0.30" — where the money went, once the app gives jobs
 * (both count against the one limit). null for an app that only answers.
 */
export function appSpendBreakdown(
  app: Pick<AppAiApp, "tasks" | "chatSpentUsd" | "tasksSpentUsd">,
): string | null {
  if (!app.tasks && app.tasksSpentUsd === 0) return null;
  return `answers ${formatUsd(app.chatSpentUsd)}, jobs ${formatUsd(app.tasksSpentUsd)}`;
}

/** Why jobs might not show in an app's spending — null when they do. */
export function taskSpendNote(
  overview: Pick<AppAiOverview, "taskSpend" | "taskHarnessUsesUnoAi">,
): string | null {
  if (!overview.taskHarnessUsesUnoAi) {
    return "This agent runs on your own subscription or keys — its jobs don't count against an app's limit.";
  }
  if (overview.taskSpend === "unavailable") {
    return "Uno AI can't report what jobs cost yet — until it can, jobs don't count against an app's limit.";
  }
  return null;
}

/** "5 GB", "1.5 GB", "500 MB" — a storage limit as a person reads it. */
export function formatLimitBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
  return formatFileSize(bytes);
}

/** "Keeps 120 MB of 5 GB in your cloud" — or "Nothing in your cloud yet". */
export function appStorageLine(storage: NonNullable<AppAiApp["storage"]>): string {
  const limit = formatLimitBytes(storage.limitBytes);
  if (storage.usedBytes === null) return `Can keep up to ${limit} in your cloud`;
  if (storage.usedBytes === 0) return `Nothing in your cloud yet · up to ${limit}`;
  return `Keeps ${formatFileSize(storage.usedBytes)} of ${limit} in your cloud`;
}

function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}

/**
 * "Answers from": where one app's answers go — Uno AI, a server on this
 * computer, Personal AI or the person's own key — and which model.
 */
function ProviderControl({
  app,
  providers,
  environmentId,
  onUpdate,
  pending,
}: {
  readonly app: AppAiApp;
  readonly providers: AppAiProviders | undefined;
  readonly environmentId: EnvironmentId;
  readonly onUpdate: (input: AppAiUpdateInput) => void;
  readonly pending: boolean;
}) {
  const current = app.provider;
  const options = providerOptions(providers, current);
  const [manual, setManual] = useState(false);
  const [wantModels, setWantModels] = useState(false);
  const listId = useId();
  const localModels =
    current?.kind === "local"
      ? (providers?.local.find((e) => e.baseUrl === current.baseUrl)?.models ?? null)
      : null;
  const remote = useQuery(
    appAiModelsQueryOptions(
      environmentId,
      wantModels && current && current.kind !== "local"
        ? {
            kind: current.kind,
            ...(current.keyProvider ? { keyProvider: current.keyProvider } : {}),
          }
        : null,
    ),
  );
  const models = localModels ?? remote.data?.models.map((m) => m.id) ?? [];
  const choose = (choice: AppAiProviderChoice) => onUpdate({ appId: app.id, provider: choice });
  const value = manual ? MANUAL_LOCAL_VALUE : choiceValue(current);
  const selected = options.find((o) => o.value === value);
  return (
    <div
      className="flex flex-wrap items-center justify-end gap-2"
      data-testid={`app-ai-provider-${app.id}`}
    >
      <Select
        value={value}
        onValueChange={(next) => {
          if (next === MANUAL_LOCAL_VALUE) {
            setManual(true);
            return;
          }
          setManual(false);
          const choice = choiceFromValue(String(next), current);
          if (choice && String(next) !== choiceValue(current)) choose(choice);
        }}
      >
        <SelectTrigger
          size="sm"
          className="w-60"
          aria-label={`Where ${app.name}'s answers come from`}
          title={selected?.hint}
          disabled={pending}
        >
          <SelectValue>{selected?.label ?? "Uno AI"}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
              <span className="flex flex-col">
                <span>{option.label}</span>
                <span className="text-[11px] text-muted-foreground">{option.hint}</span>
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {manual ? (
        <DraftInput
          className="w-60"
          value=""
          autoFocus
          placeholder="http://127.0.0.1:11434/v1"
          spellCheck={false}
          aria-label={`AI server address for ${app.name}`}
          onCommit={(next) => {
            if (next.trim()) {
              setManual(false);
              choose({ kind: "local", baseUrl: next.trim(), model: null });
            }
          }}
        />
      ) : (
        <>
          <DraftInput
            className="w-48"
            value={current?.model ?? ""}
            list={listId}
            placeholder={
              current?.kind === "local"
                ? (localModels?.[0] ?? "model")
                : current?.kind === "uno" || !current
                  ? "Model for answers"
                  : "Provider's first model"
            }
            spellCheck={false}
            aria-label={`Model ${app.name} gets`}
            onFocus={() => setWantModels(true)}
            onCommit={(next) => {
              const model = next.trim() || null;
              if (model !== (current?.model ?? null)) {
                choose({ ...(current ?? { kind: "uno" }), model });
              }
            }}
          />
          <datalist id={listId}>
            {models.slice(0, 200).map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
        </>
      )}
    </div>
  );
}

/** "Add AI to an app": pick an app you made here → a new chat with the task typed in. */
function AddAiToAppButton({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const [open, setOpen] = useState(false);
  const machineApps = useQuery(machineAppsQueryOptions(environmentId, open));
  const overview = useQuery(appAiQueryOptions(environmentId, open));
  const launchers = useHomeLaunchers(environmentId);
  const withAi = new Set(
    (overview.data?.apps ?? []).filter((a) => a.chat || a.tasks).map((a) => a.id),
  );
  const targets: AddAiTarget[] = (machineApps.data?.apps ?? [])
    .filter((app) => app.source === "manifest")
    .map((app) => {
      const id = app.id.replace(/^manifest:/, "");
      return { id, name: app.name, codeDir: app.codeDir ?? null, hasAi: withAi.has(id) };
    })
    .toSorted((a, b) => Number(a.hasAi) - Number(b.hasAi) || a.name.localeCompare(b.name));
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="add-ai-to-app">
        <WandSparklesIcon className="size-3.5" /> Add AI to an app
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add AI to an app</DialogTitle>
            <DialogDescription>
              Pick an app you or Uno made on this computer. A new chat opens with the task typed in
              — read it, change it, then send.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {machineApps.isPending ? (
              <p className="text-sm text-muted-foreground">Looking at this computer's apps…</p>
            ) : targets.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No apps made on this computer yet. Ask Uno to build one first — e.g. "a notes app
                with an AI assistant".
              </p>
            ) : (
              <ul className="flex flex-col gap-1" aria-label="Apps">
                {targets.map((target) => (
                  <li key={target.id}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted/60"
                      onClick={() => {
                        setOpen(false);
                        void launchers.askUno(addAiPrompt(target));
                      }}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{target.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {target.codeDir ?? `~/.uno/apps/${target.id}.json`}
                        </span>
                      </span>
                      {target.hasAi ? (
                        <Badge variant="outline" size="sm">
                          Uses AI
                        </Badge>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function AppRow({
  app,
  onUpdate,
  pending,
  providers,
  environmentId,
}: {
  readonly app: AppAiApp;
  readonly onUpdate: (input: AppAiUpdateInput) => void;
  readonly pending: boolean;
  readonly providers: AppAiProviders | undefined;
  readonly environmentId: EnvironmentId;
}) {
  const usesAi = app.chat || app.tasks;
  const uses = [app.chat ? "answers" : null, app.tasks ? "jobs" : null]
    .filter(Boolean)
    .join(" and ");
  const lastUsed = relativeTime(app.lastUsedAt);
  const percent = app.limitUsd > 0 ? Math.min(100, (app.spentUsd / app.limitUsd) * 100) : 100;
  const storage = app.storage;
  const storagePercent =
    storage && storage.usedBytes !== null && storage.limitBytes > 0
      ? Math.min(100, (storage.usedBytes / storage.limitBytes) * 100)
      : 0;
  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2" data-testid={`app-ai-${app.id}`}>
          <span aria-hidden>{app.icon ?? "▢"}</span>
          {app.name}
          {app.status === "revoked" ? (
            <Badge variant="outline" size="sm">
              {usesAi ? "AI off" : "Turned off"}
            </Badge>
          ) : app.status === "over-limit" ? (
            <Badge variant="outline" size="sm" className="text-amber-700 dark:text-amber-400">
              Limit reached
            </Badge>
          ) : null}
        </span>
      }
      description={
        <>
          {app.chat && app.status !== "revoked" ? (
            <span className="block" data-testid={`app-ai-via-${app.id}`}>
              Answers from {app.providerLabel ?? "Uno AI"}
              {app.metered === false ? " · no Uno AI limit applies" : ""}
            </span>
          ) : null}
          {usesAi ? (
            <span className="block">
              {appUsageLine(app)}
              {appSpendBreakdown(app) ? ` (${appSpendBreakdown(app)})` : ""}
              {` · uses AI for ${uses}`}
              {app.tasksStarted > 0
                ? ` · ${app.tasksStarted} job${app.tasksStarted === 1 ? "" : "s"}`
                : ""}
              {lastUsed ? ` · last used ${lastUsed}` : ""}
            </span>
          ) : null}
          {storage ? (
            <span className="flex items-center gap-1" data-testid={`app-storage-${app.id}`}>
              <CloudIcon className="size-3 shrink-0 text-sky-500" aria-hidden />
              {appStorageLine(storage)}
              {storage.bucketId !== null ? (
                <>
                  {" · "}
                  <Link
                    to="/files"
                    search={{ cloud: "1", bucket: storage.bucketId, prefix: storage.prefix }}
                    className="underline-offset-4 hover:text-foreground hover:underline"
                  >
                    Open in Files
                  </Link>
                </>
              ) : null}
            </span>
          ) : null}
          {storage ? (
            <span className="block text-xs" data-testid={`app-storage-scope-${app.id}`}>
              {appStorageScopeHint(storage.scope)}
            </span>
          ) : null}
        </>
      }
      status={
        <span className="flex w-full max-w-72 flex-col gap-1">
          {usesAi ? (
            <span className="block h-1 w-full overflow-hidden rounded bg-muted">
              <span
                className={
                  app.status === "over-limit"
                    ? "block h-full bg-amber-500"
                    : "block h-full bg-primary/70"
                }
                style={{ width: `${percent}%` }}
              />
            </span>
          ) : null}
          {storage ? (
            <span className="block h-1 w-full overflow-hidden rounded bg-muted">
              <span
                className={
                  storagePercent >= 90 ? "block h-full bg-amber-500" : "block h-full bg-sky-500"
                }
                style={{ width: `${storagePercent}%` }}
              />
            </span>
          ) : null}
        </span>
      }
      control={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {usesAi ? (
            <label
              className="flex items-center gap-1 text-xs text-muted-foreground"
              title="What the app may spend on Uno AI. AI on this computer and your own key don't count."
            >
              Limit $
              <DraftInput
                className="w-20"
                inputMode="decimal"
                value={String(app.limitUsd)}
                aria-label={`${app.name} AI limit in dollars`}
                onCommit={(next) => {
                  const value = Number(next.replace(",", "."));
                  if (Number.isFinite(value) && value >= 0 && value !== app.limitUsd) {
                    onUpdate({ appId: app.id, limitUsd: value });
                  }
                }}
              />
            </label>
          ) : null}
          {storage ? (
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              Cloud GB
              <DraftInput
                className="w-16"
                inputMode="decimal"
                value={String(Math.round((storage.limitBytes / 1024 ** 3) * 100) / 100)}
                aria-label={`${app.name} cloud storage limit in gigabytes`}
                onCommit={(next) => {
                  const value = Number(next.replace(",", "."));
                  if (
                    Number.isFinite(value) &&
                    value > 0 &&
                    Math.round(value * 1024 ** 3) !== storage.limitBytes
                  ) {
                    onUpdate({ appId: app.id, storageLimitGb: value });
                  }
                }}
              />
            </label>
          ) : null}
          {storage ? (
            <Select
              value={storage.scope}
              onValueChange={(value) => {
                if (value !== storage.scope) {
                  onUpdate({ appId: app.id, storageScope: value as AppStorageScope });
                }
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-52"
                aria-label={`Cloud folder of ${app.name}`}
                title="Cloud folder. Switching moves no files: the app starts using the other folder."
              >
                <SelectValue>{SCOPE_LABELS[storage.scope]}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {(Object.keys(SCOPE_LABELS) as AppStorageScope[]).map((scope) => (
                  <SelectItem key={scope} value={scope}>
                    {SCOPE_LABELS[scope]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
          {app.tasks ? (
            <Select
              value={app.taskToolsCap}
              onValueChange={(value) =>
                onUpdate({ appId: app.id, taskToolsCap: value as AppTaskTools })
              }
            >
              <SelectTrigger
                size="sm"
                className="w-56"
                aria-label={`What ${app.name}'s jobs may do`}
              >
                <SelectValue>{TOOLS_LABELS[app.taskToolsCap]}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {(Object.keys(TOOLS_LABELS) as AppTaskTools[]).map((tools) => (
                  <SelectItem key={tools} value={tools}>
                    {TOOLS_LABELS[tools]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
          {app.status === "revoked" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={pending}
              onClick={() => onUpdate({ appId: app.id, revoked: false })}
            >
              {usesAi ? "Turn AI back on" : "Turn back on"}
            </Button>
          ) : (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={pending}
              data-testid={`app-ai-revoke-${app.id}`}
              title={
                storage
                  ? "Turns off this app's AI and cloud access. Its files stay in your cloud."
                  : undefined
              }
              onClick={() => onUpdate({ appId: app.id, revoked: true })}
            >
              Revoke
            </Button>
          )}
        </div>
      }
    >
      {app.chat && app.status !== "revoked" ? (
        <div className="flex flex-wrap items-center gap-2 pt-3 pb-4">
          <span className="text-xs text-muted-foreground">Answers from</span>
          <ProviderControl
            app={app}
            providers={providers}
            environmentId={environmentId}
            onUpdate={onUpdate}
            pending={pending}
          />
        </div>
      ) : null}
    </SettingsRow>
  );
}

export function AppsAiSettingsPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const queryClient = useQueryClient();
  const serverSettings = useEnvironmentSettings(environmentId);
  const providers = useEnvironmentProviders(environmentId);
  const clientSettings = useSettings();
  const { updateSettings, mutationBlockedReason } = useUpdateEnvironmentSettings(environmentId);
  const settings = serverSettings ?? DEFAULT_UNIFIED_SETTINGS;

  const overview = useQuery(appAiQueryOptions(environmentId));
  const update = useMutation({
    mutationFn: (input: AppAiUpdateInput) => appAiUpdate(environmentId, input),
    onSuccess: (data: AppAiOverview) =>
      queryClient.setQueryData(appAiQueryKey(environmentId), data),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Couldn't change the app",
        description: error instanceof Error ? error.message : String(error),
      }),
  });

  const save = useCallback(
    (patch: Parameters<typeof updateSettings>[0], title: string) => {
      void updateSettings(patch)
        .then(() => queryClient.invalidateQueries({ queryKey: appAiQueryKey(environmentId) }))
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title,
            description: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [environmentId, queryClient, updateSettings],
  );

  const merged = useMemo(() => ({ ...clientSettings, ...settings }), [clientSettings, settings]);
  const instanceEntries = sortProviderInstanceEntries(deriveProviderInstanceEntries(providers));
  const chosen = settings.appsAi?.taskModelSelection ?? null;
  // What jobs run on now: the person's choice, else the machine's default.
  const effective = chosen ?? overview.data?.taskModelDefault ?? null;
  const taskInstanceId = effective?.instanceId ?? instanceEntries[0]?.instanceId ?? null;
  const taskModel = effective?.model ?? instanceEntries[0]?.models[0]?.slug ?? "";
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    merged,
    providers,
    taskInstanceId,
    taskModel,
  );

  const data = overview.data;
  const chatModel = settings.appsAi?.chatModel ?? "";

  return (
    <SettingsPageContainer>
      {mutationBlockedReason ? (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 text-xs text-amber-700 dark:text-amber-400">
          {mutationBlockedReason}
        </p>
      ) : null}

      <SettingsSection title="AI for apps" icon={<SparklesIcon className="size-3" />}>
        <SettingsRow
          title="Apps on this computer can use its AI"
          description="An app you or Uno build here asks this computer's AI for answers or gives it jobs — no API key of its own. Each app gets its answers from Uno AI, from AI running on this computer, or from your own key — you choose per app below. You see what each app spends and can stop it any time."
          status={
            data
              ? data.gatewayConnected
                ? data.apiUrl
                  ? (providersSummary(data.providers) ?? "On")
                  : "The App API couldn't start on this computer (its port is busy)."
                : "Sign in to Uno on this computer to turn it on."
              : null
          }
          control={<AddAiToAppButton environmentId={environmentId} />}
        />
        <SettingsRow
          title="Model for answers"
          description="What apps on Uno AI get when they don't pick a model themselves. Any model of the Uno AI gateway."
          resetAction={
            chatModel.length > 0 ? (
              <SettingResetButton
                label="model for answers"
                onClick={() => save({ appsAi: { chatModel: "" } }, "Could not save the model")}
              />
            ) : null
          }
          control={
            <DraftInput
              className="w-full sm:w-72"
              value={chatModel}
              placeholder={APP_SDK_DEFAULT_CHAT_MODEL}
              spellCheck={false}
              aria-label="Model for app answers"
              onCommit={(next) =>
                save({ appsAi: { chatModel: next.trim() } }, "Could not save the model")
              }
            />
          }
        />
        <SettingsRow
          title="Agent for jobs"
          description="Which agent does the jobs apps hand over. Each job appears as a chat named after the app, where you can watch it and approve its steps."
          status={data ? taskSpendNote(data) : null}
          resetAction={
            chosen ? (
              <SettingResetButton
                label="agent for jobs"
                onClick={() =>
                  save({ appsAi: { taskModelSelection: null } }, "Could not save the agent")
                }
              />
            ) : null
          }
          control={
            taskInstanceId !== null ? (
              <ProviderModelPicker
                activeInstanceId={taskInstanceId}
                model={taskModel}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onInstanceModelChange={(instanceId, model) =>
                  save(
                    { appsAi: { taskModelSelection: createModelSelection(instanceId, model) } },
                    "Could not save the agent",
                  )
                }
              />
            ) : (
              <span className="text-xs text-muted-foreground">No agent installed</span>
            )
          }
        />
      </SettingsSection>

      <SettingsSection title="Apps using AI or cloud storage">
        {overview.isError ? (
          <SettingsRow
            title="Couldn't read the apps"
            description={
              overview.error instanceof Error ? overview.error.message : String(overview.error)
            }
          />
        ) : !data ? (
          <SettingsRow title="Loading…" description="" />
        ) : data.apps.length === 0 ? (
          <SettingsRow
            title="No app uses this computer's AI or your cloud yet"
            description={
              'Ask Uno "make me an app that translates text" or "a photo album" — it builds the app and connects it here: AI with a $10 limit, files in your cloud.'
            }
          />
        ) : (
          data.apps.map((app) => (
            <AppRow
              key={app.id}
              app={app}
              providers={data.providers}
              environmentId={environmentId}
              pending={update.isPending}
              onUpdate={(input) => update.mutate(input)}
            />
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
