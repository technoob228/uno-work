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
    })
      .then(() => {
        setBotToken("");
        setNotice("Telegram connector saved.");
        void refresh();
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Failed to save Telegram connector."),
      );
  }, [projectId, botToken, chatIds, telegramEnabled, telegramInstance, telegramModel, refresh]);

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
            <Button
              size="xs"
              variant="ghost"
              className="ml-auto"
              render={<Link to="/assistant" />}
            >
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
                  telegram?.configured ? "Leave empty to keep the current token." : "Required for the first setup."
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
