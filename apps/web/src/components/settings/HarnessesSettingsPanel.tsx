/**
 * Settings → Harnesses: custom (ACP) agents on one machine.
 *
 * Lists the harnesses added here (stored in the machine's settings) and the
 * ones registered as `~/.uno/harnesses/<id>.json`, with their live status,
 * Test connection, Install, secrets of file harnesses, and invalid files.
 * The built-in agents stay on the Agents page.
 *
 * @module components/settings/HarnessesSettingsPanel
 */
import {
  type CustomHarnessInstallStatus,
  type CustomHarnessListResult,
  type CustomHarnessSummary,
  type CustomHarnessTestResult,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { formatCommandLine } from "@t3tools/shared/customHarness";
import {
  AlertTriangleIcon,
  BookOpenIcon,
  DownloadIcon,
  FileJsonIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  refreshEnvironmentProviders,
  useEnvironmentProviders,
  useEnvironmentSettings,
  useUpdateEnvironmentSettings,
} from "~/environments/settings/serverSettings";

import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { resolveClient } from "../harness/useHarnessSetup";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { CustomHarnessDialog } from "./CustomHarnessDialog";
import { draftFromInstance, type HarnessDraft } from "./customHarnessForm";
import { HarnessGuideDialog } from "./HarnessGuideDialog";
import { HarnessTestResultView, HarnessTestRunning } from "./HarnessTestResult";
import { withoutProviderInstanceKey } from "./SettingsPanels.logic";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

const LIST_POLL_MS = 5_000;
const INSTALL_POLL_MS = 1_000;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function statusBadge(provider: ServerProvider | undefined, enabled: boolean) {
  if (!enabled) return <Badge variant="outline">Off</Badge>;
  if (!provider) return <Badge variant="outline">Checking…</Badge>;
  if (!provider.installed) return <Badge variant="error">Not installed</Badge>;
  if (provider.status === "ready") return <Badge variant="success">Ready</Badge>;
  if (provider.status === "error") return <Badge variant="error">Needs attention</Badge>;
  return <Badge variant="warning">Checking…</Badge>;
}

function HarnessRow({
  environmentId,
  harness,
  provider,
  canMutate,
  onEdit,
  onRemove,
  onToggle,
  onChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly harness: CustomHarnessSummary;
  readonly provider: ServerProvider | undefined;
  readonly canMutate: boolean;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
  readonly onToggle: (enabled: boolean) => void;
  readonly onChanged: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<CustomHarnessTestResult | null>(null);
  const [install, setInstall] = useState<CustomHarnessInstallStatus | null>(null);
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const client = () => resolveClient(environmentId);
  const commandLine = formatCommandLine([harness.config.command, ...harness.config.args]);

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await client().customHarness.test({ instanceId: harness.instanceId }));
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Test failed to run",
        description: errorText(error),
      });
    } finally {
      setTesting(false);
    }
  };

  useEffect(() => {
    if (!install || install.state !== "running") return;
    const timer = setTimeout(() => {
      void resolveClient(environmentId)
        .customHarness.installStatus({ jobId: install.jobId })
        .then((next) => {
          setInstall(next);
          if (next.state === "succeeded") {
            void refreshEnvironmentProviders(environmentId, harness.instanceId);
          }
        })
        .catch(() => undefined);
    }, INSTALL_POLL_MS);
    return () => clearTimeout(timer);
  }, [install, environmentId, harness.instanceId]);

  const startInstall = async () => {
    try {
      setInstall(await client().customHarness.installStart({ instanceId: harness.instanceId }));
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Install did not start",
        description: errorText(error),
      });
    }
  };

  const saveSecret = async (name: string) => {
    try {
      await client().customHarness.setSecret({
        instanceId: harness.instanceId,
        name,
        value: secretDrafts[name] ?? "",
      });
      setSecretDrafts((current) => ({ ...current, [name]: "" }));
      toastManager.add({
        type: "success",
        title: `${name} saved`,
        description: "Kept in this machine's secret store.",
      });
      onChanged();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Could not save ${name}`,
        description: errorText(error),
      });
    }
  };

  return (
    <div
      className="space-y-3 border-t border-border/60 px-4 py-4 first:border-t-0 sm:px-5"
      data-testid={`harness-row-${harness.instanceId}`}
    >
      <div className="flex flex-wrap items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-base">
          {harness.config.icon ? (
            harness.config.icon
          ) : (
            <ProviderInstanceIcon
              driverKind={provider?.driver ?? ("acp" as never)}
              displayName={harness.name}
            />
          )}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-[13px] font-semibold text-foreground">{harness.name}</h3>
            {statusBadge(provider, harness.config.enabled)}
            {provider?.version ? (
              <span className="text-[11px] text-muted-foreground">v{provider.version}</span>
            ) : null}
            {harness.source === "file" ? (
              <Badge variant="secondary" className="gap-1" title={harness.filePath}>
                <FileJsonIcon className="size-3" />
                File
              </Badge>
            ) : null}
          </div>
          <p className="truncate font-mono text-[11px] text-muted-foreground" title={commandLine}>
            {commandLine}
          </p>
          {harness.source === "file" && harness.filePath ? (
            <p className="truncate text-[11px] text-muted-foreground" title={harness.filePath}>
              {harness.filePath}
            </p>
          ) : null}
          {provider?.message && provider.status !== "ready" ? (
            <p className="text-[11px] text-amber-700 dark:text-amber-400">{provider.message}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {harness.config.installCommand.length > 0 && provider && !provider.installed ? (
            <Button
              size="xs"
              variant="outline"
              className="gap-1"
              disabled={!canMutate || install?.state === "running"}
              onClick={() => void startInstall()}
              title={formatCommandLine(harness.config.installCommand)}
            >
              <DownloadIcon className="size-3" />
              {install?.state === "running" ? "Installing…" : "Install"}
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            disabled={testing || !canMutate}
            onClick={() => void test()}
            data-testid={`harness-test-${harness.instanceId}`}
          >
            {testing ? "Testing…" : "Test connection"}
          </Button>
          {harness.source === "settings" ? (
            <>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Edit ${harness.name}`}
                onClick={onEdit}
                disabled={!canMutate}
              >
                <PencilIcon className="size-3" />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove ${harness.name}`}
                onClick={onRemove}
                disabled={!canMutate}
              >
                <Trash2Icon className="size-3" />
              </Button>
              <Switch
                checked={harness.config.enabled}
                onCheckedChange={onToggle}
                disabled={!canMutate}
                aria-label={`${harness.name} on/off`}
              />
            </>
          ) : null}
        </div>
      </div>

      {harness.source === "file" && harness.secrets.length > 0 ? (
        <div className="space-y-1.5 rounded-lg border border-border/70 bg-muted/20 px-3 py-2.5">
          <p className="text-[11px] text-muted-foreground">
            Secrets this harness needs (the file lists the names; values stay in this machine's
            secret store):
          </p>
          {harness.secrets.map((secret) => (
            <div key={secret.name} className="grid grid-cols-[10rem_1fr_auto] items-center gap-2">
              <span className="truncate font-mono text-xs">{secret.name}</span>
              <Input
                type="password"
                className="bg-background font-mono text-xs"
                placeholder={secret.isSet ? "•••••• set — type to replace" : "not set"}
                value={secretDrafts[secret.name] ?? ""}
                onChange={(event) =>
                  setSecretDrafts((current) => ({ ...current, [secret.name]: event.target.value }))
                }
                aria-label={`Value of ${secret.name}`}
              />
              <Button
                size="xs"
                variant="outline"
                disabled={!canMutate || !(secretDrafts[secret.name] ?? "").length}
                onClick={() => void saveSecret(secret.name)}
              >
                Set
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {install && install.state !== "running" ? (
        <details className="text-xs" open={install.state === "failed"}>
          <summary className="cursor-pointer text-muted-foreground">
            Install {install.state === "succeeded" ? "finished" : `failed: ${install.error ?? ""}`}
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 font-mono text-[11px]">
            {install.log}
          </pre>
        </details>
      ) : null}
      {testing ? <HarnessTestRunning /> : null}
      {result && !testing ? <HarnessTestResultView result={result} /> : null}
    </div>
  );
}

export function HarnessesSettingsPanel({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const providers = useEnvironmentProviders(environmentId);
  const { updateSettings, canMutate, mutationBlockedReason } =
    useUpdateEnvironmentSettings(environmentId);
  const [list, setList] = useState<CustomHarnessListResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{
    readonly editing?: ProviderInstanceId;
    readonly draft?: HarnessDraft;
  } | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await resolveClient(environmentId).customHarness.list());
      setLoadError(null);
    } catch (error) {
      setLoadError(errorText(error));
    }
  }, [environmentId]);

  // Settings changes (add / edit / remove) and new files both show up here.
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), LIST_POLL_MS);
    return () => clearInterval(timer);
  }, [load, settings]);

  const providerById = useMemo(
    () => new Map(providers.map((provider) => [provider.instanceId as string, provider])),
    [providers],
  );

  const save = (patch: Parameters<typeof updateSettings>[0], failure: string) =>
    updateSettings(patch)
      .then(() => load())
      .catch((error: unknown) =>
        toastManager.add({ type: "error", title: failure, description: errorText(error) }),
      );

  const editHarness = (harness: CustomHarnessSummary) => {
    const instance = settings?.providerInstances[harness.instanceId];
    if (!instance) return;
    setDialog({ editing: harness.instanceId, draft: draftFromInstance(instance, harness.config) });
  };

  const removeHarness = (harness: CustomHarnessSummary) => {
    if (!settings) return;
    void save(
      {
        providerInstances: withoutProviderInstanceKey(
          settings.providerInstances,
          harness.instanceId,
        ),
      },
      "Could not remove the harness",
    );
  };

  const toggleHarness = (harness: CustomHarnessSummary, enabled: boolean) => {
    const instance = settings?.providerInstances[harness.instanceId];
    if (!settings || !instance) return;
    const config = instance.config && typeof instance.config === "object" ? instance.config : {};
    void save(
      {
        providerInstances: {
          ...settings.providerInstances,
          [harness.instanceId]: { ...instance, enabled, config: { ...config, enabled } },
        },
      },
      "Could not switch the harness",
    );
  };

  const harnesses = list?.harnesses ?? [];

  return (
    <SettingsPageContainer>
      {mutationBlockedReason ? (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 text-xs text-amber-700 dark:text-amber-400">
          {mutationBlockedReason}
        </p>
      ) : null}

      <SettingsSection
        title="Custom harnesses"
        headerAction={
          <div className="flex items-center gap-1.5">
            <Button
              size="xs"
              variant="ghost"
              className="gap-1 text-muted-foreground"
              onClick={() => setGuideOpen(true)}
              data-testid="harness-guide-link"
            >
              <BookOpenIcon className="size-3" />
              Guide
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
              aria-label="Reload harnesses"
              onClick={() => {
                void load();
                void refreshEnvironmentProviders(environmentId);
              }}
            >
              <RefreshCwIcon className="size-3" />
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
            Bring your own agent: anything on this machine that speaks the Agent Client Protocol
            (ACP) — your own agent, Gemini CLI, opencode, Kimi Code… It appears in the model picker
            with its own chats, Approve / Deny cards and stop/resume.
          </p>
          <Button
            size="sm"
            className="shrink-0 gap-1"
            disabled={!canMutate}
            onClick={() => setDialog({})}
            data-testid="harness-add"
          >
            <PlusIcon className="size-3.5" />
            Add custom harness
          </Button>
        </div>
        {loadError ? (
          <p className="border-t border-border/60 px-5 py-3 text-xs text-destructive">
            Could not load harnesses: {loadError}
          </p>
        ) : null}
        {harnesses.map((harness) => (
          <HarnessRow
            key={harness.instanceId}
            environmentId={environmentId}
            harness={harness}
            provider={providerById.get(harness.instanceId)}
            canMutate={canMutate}
            onEdit={() => editHarness(harness)}
            onRemove={() => removeHarness(harness)}
            onToggle={(enabled) => toggleHarness(harness, enabled)}
            onChanged={() => void load()}
          />
        ))}
        {list && harnesses.length === 0 ? (
          <p className="border-t border-border/60 px-5 py-4 text-xs text-muted-foreground">
            No custom harnesses yet.
          </p>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Let an AI add one">
        <div className="space-y-2 px-4 py-4 text-xs leading-relaxed text-muted-foreground sm:px-5">
          <p>
            An agent on this machine can register a harness for you by writing one file:{" "}
            <code className="text-foreground">
              {list?.directory ?? "~/.uno/harnesses"}/&lt;id&gt;.json
            </code>
            . It shows up here within a few seconds. Ask it, for example: “Read{" "}
            <code className="text-foreground">
              {list?.guidePath ?? "~/.uno/docs/custom-harness.md"}
            </code>{" "}
            and add Gemini CLI to Uno Work.”
          </p>
          <p>API keys never go into the file — you enter them here.</p>
        </div>
        {list && list.invalid.length > 0 ? (
          <div className="space-y-1.5 border-t border-border/60 px-4 py-3 sm:px-5">
            {list.invalid.map((entry) => (
              <p key={entry.file} className="flex items-start gap-1.5 text-xs">
                <AlertTriangleIcon className="mt-px size-3.5 shrink-0 text-amber-600" />
                <span>
                  <span className="font-mono text-foreground">{entry.file}</span>{" "}
                  <span className="text-muted-foreground">— skipped: {entry.reason}</span>
                </span>
              </p>
            ))}
          </div>
        ) : null}
      </SettingsSection>

      <CustomHarnessDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDialog(null);
            void load();
          }
        }}
        environmentId={environmentId}
        editing={dialog?.editing}
        initialDraft={dialog?.draft}
      />
      <HarnessGuideDialog
        open={guideOpen}
        onOpenChange={setGuideOpen}
        guidePath={list?.guidePath ?? null}
      />
    </SettingsPageContainer>
  );
}
