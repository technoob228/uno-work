/**
 * Per-assistant configuration view (`/assistant/$environmentId/$projectId`).
 *
 * The assistant lives on exactly one daemon, and every read and write on this
 * page — overview, access token, Telegram, Slack, context files, default
 * harness — goes to the environment named in the URL. That id is a route
 * param rather than "whatever environment is active" on purpose: the active
 * environment can change while this page is mounted, and a bot token saved
 * against the wrong daemon looks like a success and does nothing.
 *
 * While the environment is not confirmed live the page is read-only: what is
 * on screen is the last sync, and a save that cannot reach its daemon is the
 * exact failure this design exists to prevent.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BotIcon,
  FileTextIcon,
  SendIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react";
import type {
  AssistantEditableFileName,
  EnvironmentId,
  ManagerAssistantSummary,
  ManagerConnectorHealth,
  ManagerConnectorHealthStatus,
  ManagerScope,
  ProjectId,
} from "@t3tools/contracts";
import { isAssistantProjectId } from "@t3tools/contracts";

import {
  getAssistant,
  listProjectsForAccessPicker,
  readAssistantFile,
  saveAssistantTelegram,
  saveAssistantSlack,
  setAssistantDefaultModel,
  updateAssistantAccess,
  writeAssistantFile,
} from "../lib/managerApi";
import { EnvironmentScopeBanner } from "../environments/scope/EnvironmentScopeBanner";
import { useEnvironmentScope } from "../environments/scope/scopes";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { SidebarInset, SidebarTrigger } from "./ui/sidebar";
import { SettingsRow, SettingsSection } from "./settings/settingsLayout";

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        checked ? "bg-primary" : "bg-muted-foreground/30"
      }`}
    >
      <span
        className={`inline-block size-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-4.5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

const CONNECTOR_HEALTH_CHIP: Record<
  ManagerConnectorHealthStatus,
  { readonly label: string; readonly variant: "success" | "warning" | "error" }
> = {
  connected: { label: "Connected", variant: "success" },
  reconnecting: { label: "Reconnecting", variant: "warning" },
  auth_expired: { label: "Auth expired", variant: "error" },
  delivery_failed: { label: "Delivery failed", variant: "error" },
  provider_unavailable: { label: "Provider unavailable", variant: "warning" },
};

const formatClock = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
};

/**
 * Persisted connector health (see `ManagerConnectorHealth`): a chip for the
 * state, when the link was last known good, and the last error while the
 * state is not `connected`. `fallbackError` is the poller's in-memory error
 * for problems that are not provider health (invalid config, storage).
 */
function ConnectorHealthStatus({
  health,
  fallbackError,
}: {
  health: ManagerConnectorHealth | null;
  fallbackError: string | null;
}) {
  if (health === null) {
    return fallbackError ? (
      <span className="text-destructive-foreground">{fallbackError}</span>
    ) : (
      <span>Not polled yet.</span>
    );
  }
  const chip = CONNECTOR_HEALTH_CHIP[health.status];
  const showError = health.status !== "connected" && health.lastError !== null;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Badge variant={chip.variant} size="sm">
        {chip.label}
      </Badge>
      {health.lastOkAt !== null ? <span>last ok {formatClock(health.lastOkAt)}</span> : null}
      {showError ? (
        <span className="text-destructive-foreground">
          {health.lastError}
          {health.lastErrorAt !== null ? ` (${formatClock(health.lastErrorAt)})` : ""}
        </span>
      ) : null}
      {!showError && fallbackError !== null ? (
        <span className="text-destructive-foreground">{fallbackError}</span>
      ) : null}
    </span>
  );
}

function FileEditor({
  environmentId,
  projectId,
  name,
  readOnly,
  onError,
}: {
  environmentId: EnvironmentId;
  projectId: string;
  name: AssistantEditableFileName;
  readOnly: boolean;
  onError: (message: string) => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setContent(null);
    setDirty(false);
    void readAssistantFile({ environmentId, projectId, name })
      .then((result) => setContent(result.content))
      .catch(() => onError(`Failed to read ${name}.`));
  }, [environmentId, projectId, name, onError]);

  const save = useCallback(() => {
    if (content === null) return;
    void writeAssistantFile({ environmentId, projectId, name, content })
      .then(() => setDirty(false))
      .catch(() => onError(`Failed to save ${name}.`));
  }, [environmentId, projectId, name, content, onError]);

  return (
    <div className="space-y-2 pb-4">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] text-muted-foreground">{name}</span>
        <Button size="xs" variant="outline" disabled={!dirty || readOnly} onClick={save}>
          {dirty ? "Save" : "Saved"}
        </Button>
      </div>
      <textarea
        value={content ?? "Loading…"}
        disabled={content === null || readOnly}
        onChange={(event) => {
          setContent(event.target.value);
          setDirty(true);
        }}
        spellCheck={false}
        className="h-48 w-full resize-y rounded-lg border border-border bg-background p-3 font-mono text-[11px] leading-relaxed"
      />
    </div>
  );
}

export function AssistantConfig({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: string;
}) {
  const scope = useEnvironmentScope(environmentId);
  // No scope means the URL names an environment this device no longer knows;
  // no live connection means read-only. Either way, writes are refused here
  // rather than being retried somewhere they would succeed.
  const canMutate = scope?.availability.canMutate ?? false;
  const environmentLabel = scope?.label ?? "this environment";
  const [assistant, setAssistant] = useState<ManagerAssistantSummary | null>(null);
  const [projects, setProjects] = useState<ReadonlyArray<{ id: ProjectId; title: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [allowAll, setAllowAll] = useState(false);
  const [selectedProjects, setSelectedProjects] = useState<ReadonlySet<string>>(new Set());
  const [canWrite, setCanWrite] = useState(true);
  const [autoApprove, setAutoApprove] = useState(true);

  const [defaultInstance, setDefaultInstance] = useState("claudeAgent");
  const [defaultModel, setDefaultModel] = useState("");

  const [botToken, setBotToken] = useState("");
  const [chatIds, setChatIds] = useState("");
  const [telegramEnabled, setTelegramEnabled] = useState(false);
  const [telegramInstance, setTelegramInstance] = useState("uno");
  const [telegramModel, setTelegramModel] = useState("");

  // Addressing: when the bot reacts in group chats.
  const [botNames, setBotNames] = useState("");
  const [requireMention, setRequireMention] = useState(true);
  const [smartWake, setSmartWake] = useState(false);
  const [hotWindowSec, setHotWindowSec] = useState("0");

  // Slack connector.
  const [slackBotToken, setSlackBotToken] = useState("");
  const [slackAppToken, setSlackAppToken] = useState("");
  const [slackChannels, setSlackChannels] = useState("");
  const [slackEnabled, setSlackEnabled] = useState(false);
  const [slackInstance, setSlackInstance] = useState("uno");
  const [slackModel, setSlackModel] = useState("");
  const [slackNames, setSlackNames] = useState("");
  const [slackRequireMention, setSlackRequireMention] = useState(true);
  const [slackSmartWake, setSlackSmartWake] = useState(false);
  const [slackHotWindowSec, setSlackHotWindowSec] = useState("0");

  const refresh = useCallback(async () => {
    try {
      const [nextAssistant, nextProjects] = await Promise.all([
        getAssistant({ environmentId, projectId }),
        listProjectsForAccessPicker({ environmentId }),
      ]);
      setAssistant(nextAssistant);
      setProjects(nextProjects.filter((project) => !isAssistantProjectId(project.id)));
      if (nextAssistant.token !== null) {
        setAllowAll(nextAssistant.token.projectAllowlist === "all");
        setSelectedProjects(
          new Set(
            nextAssistant.token.projectAllowlist === "all"
              ? []
              : nextAssistant.token.projectAllowlist,
          ),
        );
        setCanWrite(nextAssistant.token.scopes.includes("threads:write"));
        setAutoApprove(nextAssistant.token.autoApprove);
      }
      setTelegramEnabled(nextAssistant.telegram.enabled);
      setChatIds(nextAssistant.telegram.allowedChatIds.join(", "));
      if (nextAssistant.telegram.defaultModelSelection !== null) {
        setTelegramInstance(nextAssistant.telegram.defaultModelSelection.instanceId);
        setTelegramModel(nextAssistant.telegram.defaultModelSelection.model);
      }
      const addressing = nextAssistant.telegram.addressing;
      setBotNames(addressing.names.join(", "));
      setRequireMention(addressing.requireMentionInGroups);
      setSmartWake(addressing.smartWake);
      setHotWindowSec(String(addressing.hotWindowSec));

      setSlackEnabled(nextAssistant.slack.enabled);
      setSlackChannels(nextAssistant.slack.allowedChannelIds.join(", "));
      if (nextAssistant.slack.defaultModelSelection !== null) {
        setSlackInstance(nextAssistant.slack.defaultModelSelection.instanceId);
        setSlackModel(nextAssistant.slack.defaultModelSelection.model);
      }
      const slackAddressing = nextAssistant.slack.addressing;
      setSlackNames(slackAddressing.names.join(", "));
      setSlackRequireMention(slackAddressing.requireMentionInGroups);
      setSlackSmartWake(slackAddressing.smartWake);
      setSlackHotWindowSec(String(slackAddressing.hotWindowSec));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load assistant settings.");
    }
  }, [environmentId, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSaveDefaultModel = useCallback(() => {
    // The button is disabled too; this is the guard that actually holds.
    if (!canMutate) return;
    if (defaultModel.trim().length === 0) return;
    setNotice(null);
    void setAssistantDefaultModel({
      environmentId,
      projectId,
      instanceId: defaultInstance,
      model: defaultModel.trim(),
    })
      .then(() =>
        setNotice(`Default harness saved on ${environmentLabel} — new chats will start on it.`),
      )
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Failed to save default harness."),
      );
  }, [canMutate, environmentId, environmentLabel, projectId, defaultInstance, defaultModel]);

  const handleSaveAccess = useCallback(() => {
    // The button is disabled too; this is the guard that actually holds.
    if (!canMutate) return;
    setNotice(null);
    const scopes: ManagerScope[] = canWrite
      ? ["threads:read", "threads:write", "threads:approve"]
      : ["threads:read"];
    void updateAssistantAccess({
      environmentId,
      projectId,
      projectAllowlist: allowAll ? "all" : [...selectedProjects],
      scopes,
      autoApprove,
    })
      .then(() => {
        setNotice(`Access saved on ${environmentLabel}.`);
        void refresh();
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Failed to save access."),
      );
  }, [
    canMutate,
    environmentId,
    environmentLabel,
    projectId,
    allowAll,
    selectedProjects,
    canWrite,
    autoApprove,
    refresh,
  ]);

  const handleSaveTelegram = useCallback(() => {
    // The button is disabled too; this is the guard that actually holds.
    if (!canMutate) return;
    setNotice(null);
    void saveAssistantTelegram({
      environmentId,
      projectId,
      ...(botToken.trim().length > 0 ? { botToken: botToken.trim() } : {}),
      allowedChatIds: chatIds
        .split(/[\s,;]+/)
        .map((chatId) => chatId.trim())
        .filter((chatId) => chatId.length > 0),
      enabled: telegramEnabled,
      defaultModelSelection:
        telegramModel.trim().length > 0
          ? { instanceId: telegramInstance, model: telegramModel.trim() }
          : null,
      addressing: {
        names: botNames
          .split(/[,;\n]+/)
          .map((name) => name.trim())
          .filter((name) => name.length > 0),
        requireMentionInGroups: requireMention,
        smartWake,
        hotWindowSec: Math.max(0, Math.trunc(Number(hotWindowSec) || 0)),
      },
    })
      .then(() => {
        setBotToken("");
        setNotice(`Telegram connector saved on ${environmentLabel}.`);
        void refresh();
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Failed to save Telegram connector."),
      );
  }, [
    canMutate,
    environmentId,
    environmentLabel,
    projectId,
    botToken,
    chatIds,
    telegramEnabled,
    telegramInstance,
    telegramModel,
    botNames,
    requireMention,
    smartWake,
    hotWindowSec,
    refresh,
  ]);

  const handleSaveSlack = useCallback(() => {
    // The button is disabled too; this is the guard that actually holds.
    if (!canMutate) return;
    setNotice(null);
    void saveAssistantSlack({
      environmentId,
      projectId,
      ...(slackBotToken.trim().length > 0 ? { botToken: slackBotToken.trim() } : {}),
      ...(slackAppToken.trim().length > 0 ? { appToken: slackAppToken.trim() } : {}),
      allowedChannelIds: slackChannels
        .split(/[\s,;]+/)
        .map((channelId) => channelId.trim())
        .filter((channelId) => channelId.length > 0),
      enabled: slackEnabled,
      defaultModelSelection:
        slackModel.trim().length > 0
          ? { instanceId: slackInstance, model: slackModel.trim() }
          : null,
      addressing: {
        names: slackNames
          .split(/[,;\n]+/)
          .map((name) => name.trim())
          .filter((name) => name.length > 0),
        requireMentionInGroups: slackRequireMention,
        smartWake: slackSmartWake,
        hotWindowSec: Math.max(0, Math.trunc(Number(slackHotWindowSec) || 0)),
      },
    })
      .then(() => {
        setSlackBotToken("");
        setSlackAppToken("");
        setNotice(`Slack connector saved on ${environmentLabel}.`);
        void refresh();
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Failed to save Slack connector."),
      );
  }, [
    canMutate,
    environmentId,
    environmentLabel,
    projectId,
    slackBotToken,
    slackAppToken,
    slackChannels,
    slackEnabled,
    slackInstance,
    slackModel,
    slackNames,
    slackRequireMention,
    slackSmartWake,
    slackHotWindowSec,
    refresh,
  ]);

  const toggleProject = useCallback((id: string) => {
    setSelectedProjects((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const telegram = assistant?.telegram ?? null;
  const slack = assistant?.slack ?? null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header className="border-b border-border px-3 py-2 sm:px-5 sm:py-3">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            <Button
              size="xs"
              variant="ghost"
              aria-label="Back"
              onClick={() => window.history.back()}
            >
              <ArrowLeftIcon className="size-3.5" />
            </Button>
            <BotIcon className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">
              {assistant?.title ?? "Assistant"} — settings
            </span>
            <span className="truncate text-xs text-muted-foreground">· {environmentLabel}</span>
            <Button size="xs" variant="ghost" className="ml-auto" render={<Link to="/assistant" />}>
              All assistants
            </Button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
            <EnvironmentScopeBanner scope={scope} environmentId={environmentId} />
            {error ? (
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
                {error}
              </div>
            ) : null}
            {notice ? (
              <div className="rounded-xl border border-border bg-card/40 px-4 py-3 text-xs text-muted-foreground">
                {notice}
              </div>
            ) : null}

            <SettingsSection
              title="Brain"
              icon={<BotIcon className="size-3.5" />}
              headerAction={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!canMutate}
                  onClick={handleSaveDefaultModel}
                >
                  Save
                </Button>
              }
            >
              <SettingsRow
                title="Default harness for new chats"
                description="Which harness/model answers by default. You can always switch a live chat with the model picker in the composer — the assistant's memory lives in its files, so it survives the swap."
                control={
                  <span className="flex gap-2">
                    <select
                      value={defaultInstance}
                      onChange={(event) => setDefaultInstance(event.target.value)}
                      className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs"
                    >
                      <option value="claudeAgent">Claude</option>
                      <option value="uno">Uno</option>
                      <option value="opencode">OpenCode</option>
                      <option value="codex">Codex</option>
                      <option value="cursor">Cursor</option>
                      <option value="hermes">Hermes</option>
                    </select>
                    <input
                      type="text"
                      value={defaultModel}
                      onChange={(event) => setDefaultModel(event.target.value)}
                      placeholder="claude-haiku-4-5"
                      className="w-44 rounded-lg border border-border bg-background px-3 py-1.5 text-xs"
                    />
                  </span>
                }
              />
            </SettingsSection>

            <SettingsSection
              title="Access & permissions"
              icon={<ShieldCheckIcon className="size-3.5" />}
              headerAction={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!canMutate}
                  onClick={handleSaveAccess}
                >
                  Save
                </Button>
              }
            >
              <SettingsRow
                title="All projects"
                description="Let this assistant see and dispatch into every project in this environment."
                control={<Toggle checked={allowAll} onChange={setAllowAll} label="All projects" />}
              />
              {!allowAll ? (
                <SettingsRow
                  title="Allowed projects"
                  description="This assistant only sees the selected projects."
                >
                  <div className="flex flex-wrap gap-2 pb-4">
                    {projects.length === 0 ? (
                      <span className="text-xs text-muted-foreground">No projects yet.</span>
                    ) : (
                      projects.map((project) => {
                        const selected = selectedProjects.has(project.id);
                        return (
                          <button
                            key={project.id}
                            type="button"
                            onClick={() => toggleProject(project.id)}
                            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                              selected
                                ? "border-primary/40 bg-primary/10 text-primary"
                                : "border-border text-muted-foreground hover:bg-accent"
                            }`}
                          >
                            {project.title}
                          </button>
                        );
                      })
                    )}
                  </div>
                </SettingsRow>
              ) : null}
              <SettingsRow
                title="Can act (write)"
                description="Create threads, send turns, interrupt, answer permission requests. Off = read-only observer."
                control={<Toggle checked={canWrite} onChange={setCanWrite} label="Can act" />}
              />
              <SettingsRow
                title="Act without confirmation"
                description="Execute actions immediately (audited). Off = every action waits for your approval."
                control={
                  <Toggle checked={autoApprove} onChange={setAutoApprove} label="Auto approve" />
                }
              />
            </SettingsSection>

            <SettingsSection
              title="Connectors"
              icon={<SendIcon className="size-3.5" />}
              headerAction={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!canMutate}
                  onClick={handleSaveTelegram}
                >
                  Save
                </Button>
              }
            >
              <SettingsRow
                title="Telegram bot"
                description={
                  telegram?.configured
                    ? `Bot ${telegram.botUsername ? `@${telegram.botUsername}` : "configured"} · ${
                        telegram.enabled ? "enabled" : "disabled"
                      }`
                    : "This assistant's own bot: paste a token from @BotFather and list allowed chat ids."
                }
                status={
                  telegram?.configured && telegram.enabled ? (
                    <ConnectorHealthStatus
                      health={telegram.health}
                      fallbackError={telegram.lastError}
                    />
                  ) : undefined
                }
                control={
                  <Toggle
                    checked={telegramEnabled}
                    onChange={setTelegramEnabled}
                    label="Telegram enabled"
                  />
                }
              />
              <SettingsRow
                title="Bot token"
                description={
                  telegram?.configured
                    ? "Leave empty to keep the current token."
                    : "Required for the first setup."
                }
                control={
                  <input
                    type="password"
                    value={botToken}
                    onChange={(event) => setBotToken(event.target.value)}
                    placeholder="123456:ABC-…"
                    className="w-64 rounded-lg border border-border bg-background px-3 py-1.5 text-xs"
                  />
                }
              />
              <SettingsRow
                title="Allowed chat ids"
                description="Personal and/or group chat ids (comma-separated; groups are negative numbers)."
                control={
                  <input
                    type="text"
                    value={chatIds}
                    onChange={(event) => setChatIds(event.target.value)}
                    placeholder="128841517, -1001234567890"
                    className="w-64 rounded-lg border border-border bg-background px-3 py-1.5 text-xs"
                  />
                }
              />
              <SettingsRow
                title="Default harness for Telegram"
                description="Telegram chats of this assistant always start on this harness/model — pick one that is authorized here."
                control={
                  <span className="flex gap-2">
                    <select
                      value={telegramInstance}
                      onChange={(event) => setTelegramInstance(event.target.value)}
                      className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs"
                    >
                      <option value="uno">Uno</option>
                      <option value="claudeAgent">Claude</option>
                      <option value="opencode">OpenCode</option>
                      <option value="codex">Codex</option>
                      <option value="cursor">Cursor</option>
                      <option value="hermes">Hermes</option>
                    </select>
                    <input
                      type="text"
                      value={telegramModel}
                      onChange={(event) => setTelegramModel(event.target.value)}
                      placeholder="uno/moonshotai/kimi-k2.7-code"
                      className="w-44 rounded-lg border border-border bg-background px-3 py-1.5 text-xs"
                    />
                  </span>
                }
              />
              <SettingsRow
                title="Bot names"
                description="Names the bot answers to in groups (comma-separated). Matched loosely, so “Антоха” also answers to “Антон”. Private chats always get a reply."
                control={
                  <input
                    type="text"
                    value={botNames}
                    onChange={(event) => setBotNames(event.target.value)}
                    placeholder="Антоха, Антон"
                    className="w-64 rounded-lg border border-border bg-background px-3 py-1.5 text-xs"
                  />
                }
              />
              <SettingsRow
                title="Only reply when addressed (groups)"
                description="In group chats, react only to an @mention, a reply to the bot, or one of its names above. Turn off to answer every message (only for a chat dedicated to the bot)."
                control={
                  <Toggle
                    checked={requireMention}
                    onChange={setRequireMention}
                    label="Require addressing in groups"
                  />
                }
              />
              <SettingsRow
                title="Smart wake"
                description="When the name isn't literally said, let an LLM decide if the message is aimed at the bot. Costs one cheap call per unmatched group message; also enables catching the name in group voice messages."
                control={<Toggle checked={smartWake} onChange={setSmartWake} label="Smart wake" />}
              />
              <SettingsRow
                title="Follow-up window (seconds)"
                description="After the bot replies, keep answering the same chat without re-addressing it for this many seconds. 0 disables it."
                control={
                  <input
                    type="number"
                    min={0}
                    value={hotWindowSec}
                    onChange={(event) => setHotWindowSec(event.target.value)}
                    placeholder="0"
                    className="w-24 rounded-lg border border-border bg-background px-3 py-1.5 text-xs"
                  />
                }
              />
            </SettingsSection>

            <SettingsSection
              title="Slack"
              icon={<SendIcon className="size-3.5" />}
              headerAction={
                <Button size="xs" variant="outline" disabled={!canMutate} onClick={handleSaveSlack}>
                  Save
                </Button>
              }
            >
              <SettingsRow
                title="Slack bot"
                description={
                  slack?.configured
                    ? `Bot ${slack.botUserName ? `@${slack.botUserName}` : "configured"} · ${
                        slack.enabled ? "enabled" : "disabled"
                      }${slack.lastError ? ` · error: ${slack.lastError}` : ""}`
                    : "Socket Mode bot: create the app from docs/slack-app-manifest.yaml, then paste both tokens."
                }
                control={
                  <Toggle checked={slackEnabled} onChange={setSlackEnabled} label="Slack enabled" />
                }
              />
              <SettingsRow
                title="Bot token (xoxb-…)"
                description={
                  slack?.configured
                    ? "Leave empty to keep the current token."
                    : "Bot User OAuth Token."
                }
                control={
                  <input
                    type="password"
                    value={slackBotToken}
                    onChange={(event) => setSlackBotToken(event.target.value)}
                    placeholder="xoxb-…"
                    className="w-64 rounded-lg border border-border bg-background px-3 py-1.5 text-xs"
                  />
                }
              />
              <SettingsRow
                title="App token (xapp-…)"
                description={
                  slack?.configured
                    ? "Leave empty to keep the current token."
                    : "App-Level Token with connections:write (for Socket Mode)."
                }
                control={
                  <input
                    type="password"
                    value={slackAppToken}
                    onChange={(event) => setSlackAppToken(event.target.value)}
                    placeholder="xapp-…"
                    className="w-64 rounded-lg border border-border bg-background px-3 py-1.5 text-xs"
                  />
                }
              />
              <SettingsRow
                title="Allowed channel ids"
                description="Channel and/or DM ids the bot may act in (comma-separated). Invite the bot to each channel with /invite."
                control={
                  <input
                    type="text"
                    value={slackChannels}
                    onChange={(event) => setSlackChannels(event.target.value)}
                    placeholder="C0123ABCD, D0456WXYZ"
                    className="w-64 rounded-lg border border-border bg-background px-3 py-1.5 text-xs"
                  />
                }
              />
              <SettingsRow
                title="Default harness for Slack"
                description="Slack threads of this assistant always start on this harness/model — pick one that is authorized here."
                control={
                  <span className="flex gap-2">
                    <select
                      value={slackInstance}
                      onChange={(event) => setSlackInstance(event.target.value)}
                      className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs"
                    >
                      <option value="uno">Uno</option>
                      <option value="claudeAgent">Claude</option>
                      <option value="opencode">OpenCode</option>
                      <option value="codex">Codex</option>
                      <option value="cursor">Cursor</option>
                      <option value="hermes">Hermes</option>
                    </select>
                    <input
                      type="text"
                      value={slackModel}
                      onChange={(event) => setSlackModel(event.target.value)}
                      placeholder="uno/moonshotai/kimi-k2.7-code"
                      className="w-44 rounded-lg border border-border bg-background px-3 py-1.5 text-xs"
                    />
                  </span>
                }
              />
              <SettingsRow
                title="Bot names"
                description="Names the bot answers to in channels (comma-separated). Matched loosely. DMs always get a reply."
                control={
                  <input
                    type="text"
                    value={slackNames}
                    onChange={(event) => setSlackNames(event.target.value)}
                    placeholder="Антоха, Антон"
                    className="w-64 rounded-lg border border-border bg-background px-3 py-1.5 text-xs"
                  />
                }
              />
              <SettingsRow
                title="Only reply when addressed (channels)"
                description="In channels, react only to an @mention, a live bot thread, or one of its names. Off = answer every message the bot can see."
                control={
                  <Toggle
                    checked={slackRequireMention}
                    onChange={setSlackRequireMention}
                    label="Require addressing in channels"
                  />
                }
              />
              <SettingsRow
                title="Smart wake"
                description="When the name isn't literally said, let an LLM decide if the message is aimed at the bot. Costs one cheap call per unmatched channel message."
                control={
                  <Toggle
                    checked={slackSmartWake}
                    onChange={setSlackSmartWake}
                    label="Smart wake"
                  />
                }
              />
              <SettingsRow
                title="Follow-up window (seconds)"
                description="After the bot replies, keep answering the same thread without re-addressing it for this many seconds. 0 disables it."
                control={
                  <input
                    type="number"
                    min={0}
                    value={slackHotWindowSec}
                    onChange={(event) => setSlackHotWindowSec(event.target.value)}
                    placeholder="0"
                    className="w-24 rounded-lg border border-border bg-background px-3 py-1.5 text-xs"
                  />
                }
              />
            </SettingsSection>

            <SettingsSection title="Context files" icon={<FileTextIcon className="size-3.5" />}>
              <SettingsRow
                title="Instructions, notes & routing"
                description="AGENTS.md is what every harness reads when it runs this assistant's chats; NOTES.md is its durable memory; ROUTING.md maps task types to harness/model/effort and accumulates outcomes. Edit freely."
              >
                {(["AGENTS.md", "NOTES.md", "ROUTING.md"] as const).map((name) => (
                  <FileEditor
                    key={name}
                    environmentId={environmentId}
                    projectId={projectId}
                    name={name}
                    readOnly={!canMutate}
                    onError={setError}
                  />
                ))}
              </SettingsRow>
            </SettingsSection>

            <SettingsSection title="Skills" icon={<SparklesIcon className="size-3.5" />}>
              <SettingsRow
                title="Workspace skills"
                description={`Files under the assistant's skills/ directory. Add them from any chat of this assistant or drop files into ${assistant?.workspaceRoot ?? "the workspace"}/skills.`}
                control={
                  (assistant?.skills.length ?? 0) === 0 ? (
                    <span className="text-xs text-muted-foreground">No skills yet</span>
                  ) : (
                    <span className="flex max-w-[320px] flex-wrap justify-end gap-1">
                      {assistant?.skills.map((skill) => (
                        <Badge key={skill} variant="outline">
                          {skill}
                        </Badge>
                      ))}
                    </span>
                  )
                }
              />
            </SettingsSection>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
