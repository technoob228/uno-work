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
 *
 * This is the full, technical view. The owner-facing setup flow is the
 * Telegram page (`helper/TelegramPage`), which shares the connector health,
 * file editor, Slack and addressing pieces with this one.
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
  EnvironmentId,
  ManagerAssistantSummary,
  ManagerConnectorBindingView,
  ManagerScope,
  ProjectId,
} from "@t3tools/contracts";
import { isAssistantProjectId } from "@t3tools/contracts";

import {
  getAssistant,
  listConnectorBindings,
  listProjectsForAccessPicker,
  removeConnectorBinding,
  saveAssistantTelegram,
  setAssistantDefaultModel,
  updateAssistantAccess,
  upsertConnectorBinding,
} from "../lib/managerApi";
import { EnvironmentScopeBanner } from "../environments/scope/EnvironmentScopeBanner";
import { useEnvironmentScope } from "../environments/scope/scopes";
import {
  AddressingRows,
  DEFAULT_ADDRESSING_FORM,
  type AddressingFormState,
} from "./helper/AddressingRows";
import { ConnectorHealthStatus } from "./helper/ConnectorHealthStatus";
import { FileEditor } from "./helper/FileEditor";
import { ModelSelectionFields } from "./helper/ModelSelectionFields";
import { SlackConnectorSection } from "./helper/SlackConnectorSection";
import {
  addressingConfigFromForm,
  addressingFormFromConfig,
  splitIdList,
} from "./helper/telegramPageLogic";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { SidebarInset, SidebarTrigger } from "./ui/sidebar";
import { Switch } from "./ui/switch";
import { SettingsRow, SettingsSection } from "./settings/settingsLayout";

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
  // Chat → target bindings of this assistant's connectors (ADR 2026-09-11).
  const [bindings, setBindings] = useState<ReadonlyArray<ManagerConnectorBindingView>>([]);
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
  const [addressing, setAddressing] = useState<AddressingFormState>(DEFAULT_ADDRESSING_FORM);

  const refresh = useCallback(async () => {
    try {
      const [nextAssistant, nextProjects, nextBindings] = await Promise.all([
        getAssistant({ environmentId, projectId }),
        listProjectsForAccessPicker({ environmentId }),
        listConnectorBindings({ environmentId, projectId }),
      ]);
      setAssistant(nextAssistant);
      setProjects(nextProjects.filter((project) => !isAssistantProjectId(project.id)));
      setBindings(nextBindings.bindings);
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
      setAddressing(addressingFormFromConfig(nextAssistant.telegram.addressing));
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
      allowedChatIds: splitIdList(chatIds),
      enabled: telegramEnabled,
      defaultModelSelection:
        telegramModel.trim().length > 0
          ? { instanceId: telegramInstance, model: telegramModel.trim() }
          : null,
      addressing: addressingConfigFromForm(addressing),
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
    addressing,
    refresh,
  ]);

  const handleSlackSaved = useCallback(
    (text: string) => {
      setNotice(text);
      void refresh();
    },
    [refresh],
  );

  const handleBindingNotifyToggle = useCallback(
    (binding: ManagerConnectorBindingView, notifyOnComplete: boolean) => {
      if (!canMutate) return;
      setNotice(null);
      void upsertConnectorBinding({
        environmentId,
        kind: binding.kind,
        chatId: binding.chatId,
        connectorProjectId: binding.connectorProjectId,
        target: binding.target,
        notifyOnComplete,
      })
        .then(() => refresh())
        .catch((cause: unknown) =>
          setError(cause instanceof Error ? cause.message : "Failed to update the binding."),
        );
    },
    [canMutate, environmentId, refresh],
  );

  const handleBindingRemove = useCallback(
    (binding: ManagerConnectorBindingView) => {
      if (!canMutate) return;
      setNotice(null);
      void removeConnectorBinding({ environmentId, kind: binding.kind, chatId: binding.chatId })
        .then(() => refresh())
        .catch((cause: unknown) =>
          setError(cause instanceof Error ? cause.message : "Failed to remove the binding."),
        );
    },
    [canMutate, environmentId, refresh],
  );

  const toggleProject = useCallback((id: string) => {
    setSelectedProjects((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const telegram = assistant?.telegram ?? null;

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
                  <ModelSelectionFields
                    instanceId={defaultInstance}
                    model={defaultModel}
                    onInstanceChange={setDefaultInstance}
                    onModelChange={setDefaultModel}
                    placeholder="claude-haiku-4-5"
                    ariaLabel="Default"
                  />
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
                control={
                  <Switch
                    checked={allowAll}
                    onCheckedChange={setAllowAll}
                    aria-label="All projects"
                  />
                }
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
                control={
                  <Switch checked={canWrite} onCheckedChange={setCanWrite} aria-label="Can act" />
                }
              />
              <SettingsRow
                title="Act without confirmation"
                description="Execute actions immediately (audited). Off = every action waits for your approval."
                control={
                  <Switch
                    checked={autoApprove}
                    onCheckedChange={setAutoApprove}
                    aria-label="Auto approve"
                  />
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
                  <Switch
                    checked={telegramEnabled}
                    onCheckedChange={setTelegramEnabled}
                    aria-label="Telegram enabled"
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
                    aria-label="Telegram bot token"
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
                    aria-label="Telegram allowed chat ids"
                    className="w-64 rounded-lg border border-border bg-background px-3 py-1.5 text-xs"
                  />
                }
              />
              <SettingsRow
                title="Default harness for Telegram"
                description="Telegram chats of this assistant always start on this harness/model — pick one that is authorized here."
                control={
                  <ModelSelectionFields
                    instanceId={telegramInstance}
                    model={telegramModel}
                    onInstanceChange={setTelegramInstance}
                    onModelChange={setTelegramModel}
                    placeholder="uno/moonshotai/kimi-k2.7-code"
                    ariaLabel="Telegram default"
                  />
                }
              />
              <AddressingRows surface="telegram" state={addressing} onChange={setAddressing} />
            </SettingsSection>

            <SettingsSection title="Chat bindings" icon={<SendIcon className="size-3.5" />}>
              <SettingsRow
                title="Where each chat's messages go"
                description="A chat without a binding talks to this assistant. From the chat itself: /use <project>, /thread <thread>, /assistant, /where. Errors and approval requests of the bound target are pushed to the chat; completed turns only when the toggle is on."
              />
              {bindings.length === 0 ? (
                <SettingsRow
                  title="No bindings"
                  description="Every allowed chat is bound to the assistant (default)."
                />
              ) : (
                bindings.map((binding) => (
                  <SettingsRow
                    key={`${binding.kind}:${binding.chatId}`}
                    title={
                      <span className="flex items-center gap-2">
                        <span>
                          {binding.kind === "telegram" ? "Telegram" : "Slack"} chat {binding.chatId}
                        </span>
                        <Badge variant="outline">{binding.target.kind}</Badge>
                      </span>
                    }
                    description={
                      binding.targetLabel === null
                        ? `Target no longer exists (${binding.target.kind === "thread" ? binding.target.threadId : binding.target.projectId}).`
                        : `${binding.targetLabel} · ${binding.target.kind === "thread" ? binding.target.threadId : binding.target.projectId}`
                    }
                    control={
                      <span className="flex items-center gap-3">
                        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          Notify on complete
                          <Switch
                            checked={binding.notifyOnComplete}
                            onCheckedChange={(next) => handleBindingNotifyToggle(binding, next)}
                            aria-label={`Notify ${binding.chatId} on completed turns`}
                          />
                        </span>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={!canMutate}
                          onClick={() => handleBindingRemove(binding)}
                        >
                          Remove
                        </Button>
                      </span>
                    }
                  />
                ))
              )}
            </SettingsSection>

            <SlackConnectorSection
              environmentId={environmentId}
              projectId={projectId}
              slack={assistant?.slack ?? null}
              canMutate={canMutate}
              environmentLabel={environmentLabel}
              onSaved={handleSlackSaved}
              onError={setError}
            />

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
