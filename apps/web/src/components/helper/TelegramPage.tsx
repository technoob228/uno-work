/**
 * The "Telegram" page: how the owner sets up their Helper from a phone.
 *
 * Product rule (2026-09-11): one Helper per account, created automatically —
 * the owner never creates or picks an "assistant". Top to bottom: connect a
 * bot, say which chats may write, say what each chat talks to, tune the
 * Helper's brain. Everything technical (Slack, addressing, health details,
 * external tokens, approvals, extra assistants) is folded under "Advanced".
 *
 * Every read and write is bound to the environment named by the caller; while
 * that environment is not confirmed live the page is read-only.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  BrainIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  MessageSquareIcon,
  SendIcon,
  Settings2Icon,
  UsersIcon,
} from "lucide-react";
import type {
  EnvironmentId,
  ManagerAssistantSummary,
  ManagerConnectorBindingTarget,
  ManagerConnectorBindingView,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { isAssistantProjectId } from "@t3tools/contracts";

import {
  ensureHelper,
  listConnectorBindings,
  listProjectsForAccessPicker,
  listThreadsForBindingPicker,
  removeConnectorBinding,
  saveAssistantTelegram,
  setAssistantDefaultModel,
  upsertConnectorBinding,
  type BindingPickerThread,
} from "../../lib/managerApi";
import { useEnvironmentScope } from "../../environments/scope/scopes";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  AddressingRows,
  DEFAULT_ADDRESSING_FORM,
  type AddressingFormState,
} from "./AddressingRows";
import { ConnectorHealthStatus } from "./ConnectorHealthStatus";
import { ExternalTokensRows } from "./ExternalTokensRows";
import { FileEditor } from "./FileEditor";
import { helperCopy } from "./helperCopy";
import { ModelSelectionFields } from "./ModelSelectionFields";
import { ProposalsList, useManagerProposals } from "./ProposalsList";
import { SlackConnectorSection } from "./SlackConnectorSection";
import {
  addChatId,
  addressingConfigFromForm,
  addressingFormFromConfig,
  buildChatRows,
  CHAT_ROUTE_OPTIONS,
  changeRouteKind,
  chatLabelsStorageKey,
  describeTelegramStatus,
  formatChatTitle,
  notifyBindingTarget,
  parseTelegramChatId,
  pickHelper,
  planBindingWrite,
  readChatLabels,
  removeChatId,
  routeFromBinding,
  withChatLabel,
  writeChatLabels,
  type ChatLabels,
  type ChatRoute,
  type ChatRouteKind,
  type ChatRow,
  type TelegramStatusTone,
} from "./telegramPageLogic";

const STATUS_TONE_CLASS: Record<TelegramStatusTone, string> = {
  muted: "text-muted-foreground",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  error: "text-destructive-foreground",
};

const localStorageOrNull = (): Storage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

interface PickerProject {
  readonly id: ProjectId;
  readonly title: string;
}

export function TelegramPage({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const scope = useEnvironmentScope(environmentId);
  const canMutate = scope?.availability.canMutate ?? false;
  const environmentLabel = scope?.label ?? "this environment";

  const [assistants, setAssistants] = useState<ReadonlyArray<ManagerAssistantSummary>>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(null);
  const [projects, setProjects] = useState<ReadonlyArray<PickerProject>>([]);
  const [threads, setThreads] = useState<ReadonlyArray<BindingPickerThread>>([]);
  const [bindings, setBindings] = useState<ReadonlyArray<ManagerConnectorBindingView>>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Connect card.
  const [botToken, setBotToken] = useState("");
  const [howToOpen, setHowToOpen] = useState(false);
  // Allowed chats (working copy; every add/remove saves immediately).
  const [allowedChatIds, setAllowedChatIds] = useState<ReadonlyArray<string>>([]);
  const [newChatId, setNewChatId] = useState("");
  const [newChatLabel, setNewChatLabel] = useState("");
  const [chatLabels, setChatLabels] = useState<ChatLabels>({});
  // Routing drafts: a select that has been changed but whose picker is not
  // filled in yet. Cleared as soon as the daemon confirms the binding.
  const [draftRoutes, setDraftRoutes] = useState<Readonly<Record<string, ChatRoute>>>({});
  // Brain.
  const [instanceId, setInstanceId] = useState("uno");
  const [model, setModel] = useState("");
  // Advanced.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [telegramEnabled, setTelegramEnabled] = useState(true);
  const [addressing, setAddressing] = useState<AddressingFormState>(DEFAULT_ADDRESSING_FORM);

  const helper = useMemo(
    () =>
      (selectedProjectId !== null
        ? assistants.find((assistant) => assistant.projectId === selectedProjectId)
        : undefined) ?? pickHelper(assistants),
    [assistants, selectedProjectId],
  );
  const helperProjectId = helper?.projectId ?? null;
  const telegram = helper?.telegram ?? null;
  const status = describeTelegramStatus(telegram);
  const connected = telegram?.configured ?? false;

  const labelsKey = chatLabelsStorageKey(environmentId);
  useEffect(() => {
    setChatLabels(readChatLabels(localStorageOrNull(), labelsKey));
  }, [labelsKey]);

  const seedFromHelper = useCallback((summary: ManagerAssistantSummary) => {
    setAllowedChatIds(summary.telegram.allowedChatIds);
    setTelegramEnabled(summary.telegram.configured ? summary.telegram.enabled : true);
    if (summary.telegram.defaultModelSelection !== null) {
      setInstanceId(summary.telegram.defaultModelSelection.instanceId);
      setModel(summary.telegram.defaultModelSelection.model);
    }
    setAddressing(addressingFormFromConfig(summary.telegram.addressing));
  }, []);

  const refreshBindings = useCallback(
    async (projectId: ProjectId) => {
      const result = await listConnectorBindings({ environmentId, projectId });
      setBindings(result.bindings);
    },
    [environmentId],
  );

  const refresh = useCallback(async () => {
    try {
      const ensured = await ensureHelper({ environmentId });
      const current =
        (selectedProjectId !== null
          ? ensured.assistants.find((assistant) => assistant.projectId === selectedProjectId)
          : undefined) ?? ensured.helper;
      const [nextProjects, nextThreads, nextBindings] = await Promise.all([
        listProjectsForAccessPicker({ environmentId }),
        listThreadsForBindingPicker({ environmentId }),
        listConnectorBindings({ environmentId, projectId: current.projectId }),
      ]);
      setAssistants(ensured.assistants);
      setProjects(nextProjects.filter((project) => !isAssistantProjectId(project.id)));
      setThreads(nextThreads);
      setBindings(nextBindings.bindings);
      seedFromHelper(current);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load Telegram settings.");
    }
  }, [environmentId, selectedProjectId, seedFromHelper]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * One write path for the Telegram connector. Everything the page edits
   * about it (token, allowed chats, brain, pause, addressing) is one record
   * on the daemon, so every save sends the full current state plus the
   * override the caller is applying.
   */
  const persistTelegram = useCallback(
    async (
      overrides: {
        readonly botToken?: string;
        readonly allowedChatIds?: ReadonlyArray<string>;
        readonly enabled?: boolean;
        readonly model?: { readonly instanceId: string; readonly model: string } | null;
      },
      successNotice: string,
    ) => {
      // The buttons are disabled too; this is the guard that actually holds.
      if (!canMutate || helperProjectId === null) return;
      setSaving(true);
      setNotice(null);
      try {
        const modelSelection =
          overrides.model !== undefined
            ? overrides.model
            : model.trim().length > 0
              ? { instanceId, model: model.trim() }
              : null;
        await saveAssistantTelegram({
          environmentId,
          projectId: helperProjectId,
          ...(overrides.botToken !== undefined && overrides.botToken.length > 0
            ? { botToken: overrides.botToken }
            : {}),
          allowedChatIds: overrides.allowedChatIds ?? allowedChatIds,
          enabled: overrides.enabled ?? telegramEnabled,
          defaultModelSelection: modelSelection,
          addressing: addressingConfigFromForm(addressing),
        });
        setNotice(successNotice);
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Failed to save Telegram settings.");
      } finally {
        setSaving(false);
      }
    },
    [
      canMutate,
      helperProjectId,
      environmentId,
      model,
      instanceId,
      allowedChatIds,
      telegramEnabled,
      addressing,
      refresh,
    ],
  );

  const handleSaveToken = useCallback(() => {
    const token = botToken.trim();
    if (token.length === 0 && !connected) return;
    void persistTelegram(
      { botToken: token, enabled: connected ? telegramEnabled : true },
      helperCopy.connect.savedNotice,
    ).then(() => setBotToken(""));
  }, [botToken, connected, telegramEnabled, persistTelegram]);

  const handleAddChat = useCallback(() => {
    const chatId = parseTelegramChatId(newChatId);
    if (chatId === null) {
      setError("A chat id is a number, e.g. 128841517 or -1001234567890.");
      return;
    }
    const nextLabels = withChatLabel(chatLabels, chatId, newChatLabel);
    writeChatLabels(localStorageOrNull(), labelsKey, nextLabels);
    setChatLabels(nextLabels);
    setNewChatId("");
    setNewChatLabel("");
    void persistTelegram(
      { allowedChatIds: addChatId(allowedChatIds, chatId) },
      `Chat ${chatId} can now write to the bot.`,
    );
  }, [newChatId, newChatLabel, chatLabels, labelsKey, allowedChatIds, persistTelegram]);

  const handleRemoveChat = useCallback(
    (chatId: string) => {
      void persistTelegram(
        { allowedChatIds: removeChatId(allowedChatIds, chatId) },
        `Chat ${chatId} removed.`,
      );
    },
    [allowedChatIds, persistTelegram],
  );

  const handleSaveBrain = useCallback(() => {
    if (helperProjectId === null || !canMutate) return;
    const trimmed = model.trim();
    const selection = trimmed.length > 0 ? { instanceId, model: trimmed } : null;
    const projectDefault =
      selection === null
        ? Promise.resolve()
        : setAssistantDefaultModel({
            environmentId,
            projectId: helperProjectId,
            instanceId: selection.instanceId,
            model: selection.model,
          }).then(() => undefined);
    void projectDefault
      .then(() => persistTelegram({ model: selection }, "Helper's brain saved."))
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Failed to save the Helper's brain."),
      );
  }, [helperProjectId, canMutate, model, instanceId, environmentId, persistTelegram]);

  const handleSaveAdvanced = useCallback(() => {
    void persistTelegram({}, `Telegram settings saved on ${environmentLabel}.`);
  }, [persistTelegram, environmentLabel]);

  // ---- Routing -----------------------------------------------------------

  const projectOfThread = useCallback(
    (threadId: ThreadId): ProjectId | null =>
      threads.find((thread) => thread.id === threadId)?.projectId ?? null,
    [threads],
  );

  const rows = useMemo(() => buildChatRows(allowedChatIds, bindings), [allowedChatIds, bindings]);

  const effectiveRoute = useCallback(
    (row: ChatRow): ChatRoute =>
      draftRoutes[row.chatId] ?? routeFromBinding(row.binding, projectOfThread),
    [draftRoutes, projectOfThread],
  );

  const writeBinding = useCallback(
    async (
      row: ChatRow,
      target: ManagerConnectorBindingTarget,
      notifyOnComplete: boolean,
    ): Promise<void> => {
      if (helperProjectId === null) return;
      await upsertConnectorBinding({
        environmentId,
        kind: "telegram",
        chatId: row.chatId,
        connectorProjectId: helperProjectId,
        target,
        notifyOnComplete,
      });
    },
    [environmentId, helperProjectId],
  );

  const applyRoute = useCallback(
    (row: ChatRow, next: ChatRoute) => {
      if (!canMutate || helperProjectId === null) return;
      setDraftRoutes((current) => ({ ...current, [row.chatId]: next }));
      const plan = planBindingWrite(next, row.binding);
      if (plan.action === "none") return;
      setNotice(null);
      const write =
        plan.action === "remove"
          ? removeConnectorBinding({ environmentId, kind: "telegram", chatId: row.chatId })
          : writeBinding(row, plan.target, row.binding?.notifyOnComplete ?? false);
      void write
        .then(() => refreshBindings(helperProjectId))
        .then(() => {
          setDraftRoutes((current) => {
            const { [row.chatId]: _done, ...rest } = current;
            return rest;
          });
        })
        .catch((cause: unknown) =>
          setError(cause instanceof Error ? cause.message : "Failed to update the chat."),
        );
    },
    [canMutate, helperProjectId, environmentId, writeBinding, refreshBindings],
  );

  const applyNotify = useCallback(
    (row: ChatRow, notifyOnComplete: boolean) => {
      if (!canMutate || helperProjectId === null) return;
      const target = notifyBindingTarget(effectiveRoute(row), row.binding, helperProjectId);
      if (target === null) return;
      setNotice(null);
      void writeBinding(row, target, notifyOnComplete)
        .then(() => refreshBindings(helperProjectId))
        .catch((cause: unknown) =>
          setError(cause instanceof Error ? cause.message : "Failed to update the chat."),
        );
    },
    [canMutate, helperProjectId, effectiveRoute, writeBinding, refreshBindings],
  );

  // ---- Advanced: approvals ----------------------------------------------

  const proposals = useManagerProposals({ environmentId, canMutate, onError: setError });

  const advancedSaveButton = (
    <Button
      size="xs"
      variant="outline"
      disabled={!canMutate || saving}
      onClick={handleSaveAdvanced}
    >
      Save
    </Button>
  );

  return (
    <SettingsPageContainer>
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

      {/* a. Connect Telegram */}
      <SettingsSection
        title={helperCopy.connect.title}
        icon={<SendIcon className="size-3.5" />}
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={!canMutate || saving || (botToken.trim().length === 0 && !connected)}
            onClick={handleSaveToken}
          >
            {saving ? helperCopy.connect.saving : helperCopy.connect.save}
          </Button>
        }
      >
        <SettingsRow
          title={<span className={STATUS_TONE_CLASS[status.tone]}>{status.text}</span>}
          description={connected ? helperCopy.connect.description : helperCopy.pageIntro}
        />
        <SettingsRow
          title={helperCopy.connect.tokenLabel}
          description={
            <span className="flex flex-col gap-1">
              <span>{connected ? helperCopy.connect.tokenKeepHint : ""}</span>
              <Collapsible open={howToOpen} onOpenChange={setHowToOpen}>
                <CollapsibleTrigger className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                  {howToOpen ? (
                    <ChevronDownIcon className="size-3" />
                  ) : (
                    <ChevronRightIcon className="size-3" />
                  )}
                  {helperCopy.connect.howToTitle}
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-xs text-muted-foreground">
                    {helperCopy.connect.howToSteps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                </CollapsiblePanel>
              </Collapsible>
            </span>
          }
          control={
            <Input
              type="password"
              value={botToken}
              onChange={(event) => setBotToken(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") handleSaveToken();
              }}
              placeholder={helperCopy.connect.tokenPlaceholder}
              aria-label={helperCopy.connect.tokenLabel}
              className="w-full sm:w-72"
              size="sm"
            />
          }
        />
      </SettingsSection>

      {connected ? (
        <>
          {/* b. Who can write to the bot */}
          <SettingsSection
            title={helperCopy.allowedChats.title}
            icon={<UsersIcon className="size-3.5" />}
          >
            <SettingsRow
              title={helperCopy.allowedChats.title}
              description={helperCopy.allowedChats.description}
            />
            {allowedChatIds.length === 0 ? (
              <SettingsRow title={helperCopy.allowedChats.empty} description="" />
            ) : (
              allowedChatIds.map((chatId) => (
                <SettingsRow
                  key={chatId}
                  title={formatChatTitle(chatId, chatLabels)}
                  description=""
                  control={
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!canMutate || saving}
                      onClick={() => handleRemoveChat(chatId)}
                    >
                      {helperCopy.allowedChats.remove}
                    </Button>
                  }
                />
              ))
            )}
            <SettingsRow
              title={helperCopy.allowedChats.addChat}
              description={helperCopy.allowedChats.addHint}
            >
              <div className="flex flex-col gap-2 pb-4 sm:flex-row">
                <Input
                  value={newChatId}
                  onChange={(event) => setNewChatId(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") handleAddChat();
                  }}
                  placeholder={helperCopy.allowedChats.chatIdPlaceholder}
                  aria-label="Chat id"
                  size="sm"
                  className="sm:w-64"
                />
                <Input
                  value={newChatLabel}
                  onChange={(event) => setNewChatLabel(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") handleAddChat();
                  }}
                  placeholder={helperCopy.allowedChats.labelPlaceholder}
                  aria-label="Chat label"
                  size="sm"
                  className="sm:w-56"
                />
                <Button
                  size="sm"
                  disabled={!canMutate || saving || newChatId.trim().length === 0}
                  onClick={handleAddChat}
                >
                  {helperCopy.allowedChats.addChat}
                </Button>
              </div>
            </SettingsRow>
          </SettingsSection>

          {/* c. What each chat talks to */}
          <SettingsSection
            title={helperCopy.routing.title}
            icon={<MessageSquareIcon className="size-3.5" />}
          >
            <SettingsRow
              title={helperCopy.routing.description}
              description={helperCopy.routing.alwaysSent}
            />
            {rows.length === 0 ? (
              <SettingsRow title={helperCopy.routing.empty} description="" />
            ) : (
              rows.map((row) => (
                <ChatRouteRow
                  key={row.chatId}
                  row={row}
                  title={formatChatTitle(row.chatId, chatLabels)}
                  route={effectiveRoute(row)}
                  projects={projects}
                  threads={threads}
                  disabled={!canMutate}
                  onRouteChange={(next) => applyRoute(row, next)}
                  onNotifyChange={(next) => applyNotify(row, next)}
                />
              ))
            )}
          </SettingsSection>

          {/* d. Helper's brain */}
          <SettingsSection
            title={helperCopy.brain.title}
            icon={<BrainIcon className="size-3.5" />}
            headerAction={
              <Button
                size="xs"
                variant="outline"
                disabled={!canMutate || saving}
                onClick={handleSaveBrain}
              >
                {helperCopy.brain.saveModel}
              </Button>
            }
          >
            <SettingsRow
              title={helperCopy.brain.modelTitle}
              description={helperCopy.brain.modelDescription}
              control={
                <ModelSelectionFields
                  instanceId={instanceId}
                  model={model}
                  onInstanceChange={setInstanceId}
                  onModelChange={setModel}
                  placeholder="uno/moonshotai/kimi-k2.7-code"
                  disabled={!canMutate}
                  ariaLabel="Helper"
                />
              }
            />
            {helperProjectId !== null ? (
              <SettingsRow
                title={helperCopy.brain.instructionsTitle}
                description={helperCopy.brain.instructionsDescription}
              >
                <FileEditor
                  environmentId={environmentId}
                  projectId={helperProjectId}
                  name="AGENTS.md"
                  readOnly={!canMutate}
                  onError={setError}
                  showName={false}
                />
              </SettingsRow>
            ) : null}
          </SettingsSection>
        </>
      ) : null}

      {/* e. Advanced */}
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <div className="flex items-center justify-between px-1">
          <CollapsibleTrigger className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50 hover:text-foreground">
            {advancedOpen ? (
              <ChevronDownIcon className="size-3.5" />
            ) : (
              <ChevronRightIcon className="size-3.5" />
            )}
            <Settings2Icon className="size-3.5" />
            {helperCopy.advanced.title}
          </CollapsibleTrigger>
          <span className="text-[11px] text-muted-foreground/70">
            {helperCopy.advanced.description}
          </span>
        </div>
        <CollapsiblePanel>
          <div className="flex flex-col gap-8 pt-4">
            {assistants.length > 1 ? (
              <SettingsSection title="Assistants" icon={<Settings2Icon className="size-3.5" />}>
                <SettingsRow
                  title="Which assistant this page edits"
                  description="More than one assistant exists on this environment. The Telegram page edits the selected one; the default is the Helper."
                  control={
                    <Select
                      value={helperProjectId ?? ""}
                      onValueChange={(value) => {
                        setDraftRoutes({});
                        setSelectedProjectId(value ? (value as ProjectId) : null);
                      }}
                    >
                      <SelectTrigger className="w-full sm:w-56" aria-label="Assistant">
                        <SelectValue>{helper?.title ?? "—"}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup align="end" alignItemWithTrigger={false}>
                        {assistants.map((assistant) => (
                          <SelectItem
                            hideIndicator
                            key={assistant.projectId}
                            value={assistant.projectId}
                          >
                            {assistant.title}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  }
                />
              </SettingsSection>
            ) : null}

            <SettingsSection
              title="Telegram connector"
              icon={<SendIcon className="size-3.5" />}
              headerAction={advancedSaveButton}
            >
              <SettingsRow
                title={helperCopy.connect.pauseLabel}
                description={helperCopy.connect.pauseDescription}
                control={
                  <Switch
                    checked={!telegramEnabled}
                    disabled={!canMutate || !connected}
                    onCheckedChange={(paused) => setTelegramEnabled(!paused)}
                    aria-label={helperCopy.connect.pauseLabel}
                  />
                }
              />
              <SettingsRow
                title="Connector health"
                description={
                  telegram?.botUsername
                    ? `Bot @${telegram.botUsername} on ${environmentLabel}.`
                    : `Bot on ${environmentLabel}.`
                }
                status={
                  telegram?.configured ? (
                    <ConnectorHealthStatus
                      health={telegram.health}
                      fallbackError={telegram.lastError}
                    />
                  ) : (
                    <span>Not configured.</span>
                  )
                }
              />
              <AddressingRows
                surface="telegram"
                state={addressing}
                onChange={setAddressing}
                disabled={!canMutate}
              />
              {helperProjectId !== null ? (
                <SettingsRow
                  title="Full assistant settings"
                  description="Access & permissions, notes, routing table and skills of this assistant."
                  control={
                    <Button
                      size="xs"
                      variant="outline"
                      render={
                        <Link
                          to="/assistant/$environmentId/$projectId"
                          params={{ environmentId, projectId: helperProjectId }}
                        />
                      }
                    >
                      Open
                    </Button>
                  }
                />
              ) : null}
            </SettingsSection>

            {helperProjectId !== null ? (
              <SlackConnectorSection
                environmentId={environmentId}
                projectId={helperProjectId}
                slack={helper?.slack ?? null}
                canMutate={canMutate}
                environmentLabel={environmentLabel}
                onSaved={(text) => {
                  setNotice(text);
                  void refresh();
                }}
                onError={setError}
              />
            ) : null}

            <SettingsSection
              title="External brains (MCP tokens)"
              icon={<Settings2Icon className="size-3.5" />}
            >
              <ExternalTokensRows
                environmentId={environmentId}
                canMutate={canMutate}
                onError={setError}
              />
            </SettingsSection>

            <ProposalsList
              proposals={proposals.proposals}
              pending={proposals.pending}
              resolved={proposals.resolved}
              busyProposalId={proposals.busyProposalId}
              onResolve={proposals.resolve}
              emptyText="No pending proposals. The assistant files a proposal here (and in Telegram) whenever it wants to create a thread, send a turn, or answer a permission request."
            />
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </SettingsPageContainer>
  );
}

const routeOptionLabel = (kind: ChatRouteKind): string =>
  CHAT_ROUTE_OPTIONS.find((option) => option.value === kind)?.label ?? kind;

/** One allowed chat: where its messages go, and whether to report finished work. */
function ChatRouteRow({
  row,
  title,
  route,
  projects,
  threads,
  disabled,
  onRouteChange,
  onNotifyChange,
}: {
  row: ChatRow;
  title: string;
  route: ChatRoute;
  projects: ReadonlyArray<PickerProject>;
  threads: ReadonlyArray<BindingPickerThread>;
  disabled: boolean;
  onRouteChange: (next: ChatRoute) => void;
  onNotifyChange: (next: boolean) => void;
}) {
  const projectThreads = useMemo(
    () => threads.filter((thread) => thread.projectId === route.projectId),
    [threads, route.projectId],
  );
  const selectedProject = projects.find((project) => project.id === route.projectId) ?? null;
  const selectedThread = projectThreads.find((thread) => thread.id === route.threadId) ?? null;
  const targetMissing = row.binding !== null && row.binding.targetLabel === null;
  const notifyId = `notify-${row.chatId}`;

  return (
    <SettingsRow
      title={title}
      description={targetMissing ? helperCopy.routing.targetMissing : ""}
      control={
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select
              value={route.kind}
              onValueChange={(value) =>
                onRouteChange(changeRouteKind(route, value as ChatRouteKind))
              }
            >
              <SelectTrigger
                className="w-full sm:w-64"
                aria-label={`Where chat ${row.chatId} talks`}
                disabled={disabled}
              >
                <SelectValue>{routeOptionLabel(route.kind)}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {CHAT_ROUTE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {route.kind !== "helper" ? (
              <Select
                value={route.projectId ?? ""}
                onValueChange={(value) =>
                  onRouteChange({
                    ...route,
                    projectId: value ? (value as ProjectId) : null,
                    threadId: null,
                  })
                }
              >
                <SelectTrigger
                  className="w-full sm:w-48"
                  aria-label={`Project for chat ${row.chatId}`}
                  disabled={disabled || projects.length === 0}
                >
                  <SelectValue>
                    {selectedProject?.title ??
                      (projects.length === 0
                        ? helperCopy.routing.noProjects
                        : helperCopy.routing.pickProject)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {projects.map((project) => (
                    <SelectItem hideIndicator key={project.id} value={project.id}>
                      {project.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
            {route.kind === "thread" && route.projectId !== null ? (
              <Select
                value={route.threadId ?? ""}
                onValueChange={(value) =>
                  onRouteChange({ ...route, threadId: value ? (value as ThreadId) : null })
                }
              >
                <SelectTrigger
                  className="w-full sm:w-48"
                  aria-label={`Chat for chat ${row.chatId}`}
                  disabled={disabled || projectThreads.length === 0}
                >
                  <SelectValue>
                    {selectedThread?.title ??
                      (projectThreads.length === 0
                        ? helperCopy.routing.noThreads
                        : helperCopy.routing.pickThread)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {projectThreads.map((thread) => (
                    <SelectItem hideIndicator key={thread.id} value={thread.id}>
                      {thread.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id={notifyId}
              checked={row.binding?.notifyOnComplete ?? false}
              disabled={disabled}
              onCheckedChange={(checked) => onNotifyChange(checked === true)}
            />
            <Label htmlFor={notifyId} className="text-xs text-muted-foreground">
              {helperCopy.routing.notifyOnComplete}
            </Label>
          </div>
        </div>
      }
    />
  );
}
