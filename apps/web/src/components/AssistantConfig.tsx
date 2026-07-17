/**
 * Per-assistant configuration view (`/assistant/$projectId`): access &
 * permissions, connectors (this assistant's own Telegram bot), editable
 * context files (AGENTS.md / NOTES.md) and the skills present in its
 * workspace. This is the assistant's own settings — app-wide settings stay
 * under /settings.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
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
  ManagerAssistantSummary,
  ManagerScope,
  ProjectId,
} from "@t3tools/contracts";
import { isAssistantProjectId } from "@t3tools/contracts";

import {
  getAssistant,
  listProjectsForAccessPicker,
  ManagerApiError,
  readAssistantFile,
  saveAssistantTelegram,
  saveAssistantSlack,
  setAssistantDefaultModel,
  updateAssistantAccess,
  writeAssistantFile,
} from "../lib/managerApi";
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

function FileEditor({
  projectId,
  name,
  onError,
}: {
  projectId: string;
  name: AssistantEditableFileName;
  onError: (message: string) => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setContent(null);
    setDirty(false);
    void readAssistantFile({ projectId, name })
      .then((result) => setContent(result.content))
      .catch(() => onError(`Failed to read ${name}.`));
  }, [projectId, name, onError]);

  const save = useCallback(() => {
    if (content === null) return;
    void writeAssistantFile({ projectId, name, content })
      .then(() => setDirty(false))
      .catch(() => onError(`Failed to save ${name}.`));
  }, [projectId, name, content, onError]);

  return (
    <div className="space-y-2 pb-4">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] text-muted-foreground">{name}</span>
        <Button size="xs" variant="outline" disabled={!dirty} onClick={save}>
          {dirty ? "Save" : "Saved"}
        </Button>
      </div>
      <textarea
        value={content ?? "Loading…"}
        disabled={content === null}
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

export function AssistantConfig({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
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
        getAssistant(projectId),
        listProjectsForAccessPicker(),
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
      setError(
        cause instanceof ManagerApiError ? cause.message : "Failed to load assistant settings.",
      );
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSaveDefaultModel = useCallback(() => {
    if (defaultModel.trim().length === 0) return;
    setNotice(null);
    void setAssistantDefaultModel({
      projectId,
      instanceId: defaultInstance,
      model: defaultModel.trim(),
    })
      .then(() => setNotice("Default harness saved — new chats will start on it."))
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Failed to save default harness."),
      );
  }, [projectId, defaultInstance, defaultModel]);

  const handleSaveAccess = useCallback(() => {
    setNotice(null);
    const scopes: ManagerScope[] = canWrite
      ? ["threads:read", "threads:write", "threads:approve"]
      : ["threads:read"];
    void updateAssistantAccess({
      projectId,
      projectAllowlist: allowAll ? "all" : [...selectedProjects],
      scopes,
      autoApprove,
    })
      .then(() => {
        setNotice("Access saved.");
        void refresh();
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Failed to save access."),
      );
  }, [projectId, allowAll, selectedProjects, canWrite, autoApprove, refresh]);

  const handleSaveTelegram = useCallback(() => {
    setNotice(null);
    void saveAssistantTelegram({
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
        setNotice("Telegram connector saved.");
        void refresh();
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Failed to save Telegram connector."),
      );
  }, [
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
    setNotice(null);
    void saveAssistantSlack({
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
        setNotice("Slack connector saved.");
        void refresh();
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Failed to save Slack connector."),
      );
  }, [
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
            <Button size="xs" variant="ghost" className="ml-auto" render={<Link to="/assistant" />}>
              All assistants
            </Button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
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
                <Button size="xs" variant="outline" onClick={handleSaveDefaultModel}>
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
                <Button size="xs" variant="outline" onClick={handleSaveAccess}>
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
                <Button size="xs" variant="outline" onClick={handleSaveTelegram}>
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
                      }${telegram.lastError ? ` · error: ${telegram.lastError}` : ""}`
                    : "This assistant's own bot: paste a token from @BotFather and list allowed chat ids."
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
                      placeholder="uno/claude-sonnet-4-6"
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
                <Button size="xs" variant="outline" onClick={handleSaveSlack}>
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
                      placeholder="uno/claude-sonnet-4-6"
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
                <FileEditor projectId={projectId} name="AGENTS.md" onError={setError} />
                <FileEditor projectId={projectId} name="NOTES.md" onError={setError} />
                <FileEditor projectId={projectId} name="ROUTING.md" onError={setError} />
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
