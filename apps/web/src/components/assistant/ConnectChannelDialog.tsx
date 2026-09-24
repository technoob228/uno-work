/**
 * "Connect Telegram" / "Connect Slack" for Uno (0.0.85), opened from the Uno
 * chat's Connect ▾ menu and from Settings → Assistant.
 *
 * Telegram, in three steps with the status always visible:
 *   1. Your bot. Telegram only lets a person talk to software through a bot,
 *      and Uno does not run a shared one: the person makes their own with
 *      @BotFather (a minute) and pastes its token; it stays on this computer.
 *   2. Link your chat. The app asks the daemon for a one-time code and shows
 *      the bot's link `t.me/<bot>?start=<code>` (button + QR). Pressing Start
 *      in Telegram links that chat and points it at Uno's main conversation
 *      (telegramPairing.ts on the daemon). No chat ids to copy.
 *   3. Done. Where each linked chat's messages go, "Send test message".
 * Advanced things (groups, addressing, per-chat routing) stay on the full
 * page in Settings.
 *
 * Slack reuses the setup guide (create the app from a manifest, paste two
 * tokens); each Slack channel talks to its own conversation with Uno.
 */
import {
  ASSISTANT_PROJECT_ID,
  type EnvironmentId,
  type ManagerAssistantSummary,
} from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckCircle2Icon,
  ExternalLinkIcon,
  Loader2Icon,
  RefreshCwIcon,
  SendIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAssistantChat } from "../../assistant/useAssistantChat";
import { useEnvironmentSupportsAssistantConversations } from "../../environments/assistantChatSupport";
import {
  getAssistant,
  listConnectorBindings,
  saveAssistantTelegram,
  sendTelegramTestMessage,
  startTelegramPairing,
  upsertConnectorBinding,
} from "../../lib/managerApi";
import { cn } from "../../lib/utils";
import { describeTelegramStatus, parseTelegramChatId } from "../helper/telegramPageLogic";
import { openInstallDocs } from "../onboarding/harnessInstallLinks";
import { SlackGuide } from "../setup/steps/ChannelsStep";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { QRCodeSvg } from "../ui/qr-code";
import {
  checkBotToken,
  describeTelegramChatDestination,
  describeTestResults,
  isBotTokenRejected,
  telegramChatDestination,
  telegramStartLink,
  telegramWizardStep,
} from "./connectTelegram.logic";

export type ConnectChannel = "telegram" | "slack";

const errorText = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;

/** The assistant's overview, refreshed while a connection is being made. */
export function useAssistantSummary(environmentId: EnvironmentId, fast: boolean) {
  return useQuery({
    queryKey: ["uno-assistant", "summary", environmentId],
    queryFn: (): Promise<ManagerAssistantSummary> =>
      getAssistant({ environmentId, projectId: ASSISTANT_PROJECT_ID }),
    refetchInterval: fast ? 2_500 : false,
    retry: false,
  });
}

export function ConnectChannelDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly channel: ConnectChannel | null;
  readonly onClose: () => void;
}) {
  const open = props.channel !== null;
  const queryClient = useQueryClient();
  const summary = useAssistantSummary(props.environmentId, open);
  const refresh = useCallback(() => {
    void summary.refetch();
    // The Connect menu and the Uno row read their own copy.
    void queryClient.invalidateQueries({ queryKey: ["uno-assistant", "channels"] });
  }, [queryClient, summary]);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : props.onClose())}>
      <DialogPopup
        className="max-w-lg"
        data-testid={`uno-connect-${props.channel ?? "none"}-dialog`}
      >
        <DialogHeader>
          <DialogTitle>
            {props.channel === "slack" ? "Talk to Uno in Slack" : "Talk to Uno in Telegram"}
          </DialogTitle>
          <DialogDescription>
            {props.channel === "slack"
              ? "Mention Uno in a channel or write to it directly. Each Slack channel gets its own conversation with Uno; all of them share its memory."
              : "Write to your bot like to a colleague. Uno answers there, in the same conversation you see pinned in Uno Work."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 px-4 pb-2 sm:px-6">
          {summary.data ? (
            props.channel === "slack" ? (
              <SlackGuide
                environmentId={props.environmentId}
                summary={summary.data}
                onChanged={refresh}
              />
            ) : (
              <TelegramWizard
                environmentId={props.environmentId}
                summary={summary.data}
                onChanged={refresh}
              />
            )
          ) : summary.isError ? (
            <p className="text-sm text-destructive-foreground">
              {errorText(summary.error, "Couldn't reach Uno on this computer.")}
            </p>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" /> Loading…
            </div>
          )}
        </div>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={props.onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function StepHeading(props: { n: number; title: string; state: "done" | "active" | "todo" }) {
  return (
    <div className={cn("flex items-center gap-2", props.state === "todo" && "opacity-50")}>
      <span
        className={cn(
          "grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold",
          props.state === "done"
            ? "bg-primary text-primary-foreground"
            : "bg-primary/10 text-primary",
        )}
      >
        {props.state === "done" ? <CheckCircle2Icon className="size-3.5" /> : props.n}
      </span>
      <span className="text-sm font-medium">{props.title}</span>
    </div>
  );
}

function TelegramWizard(props: {
  readonly environmentId: EnvironmentId;
  readonly summary: ManagerAssistantSummary;
  readonly onChanged: () => void;
}) {
  const { environmentId, summary, onChanged } = props;
  const telegram = summary.telegram;
  const navigate = useNavigate();
  const supportsPairing = useEnvironmentSupportsAssistantConversations(environmentId);
  const mainChat = useAssistantChat().chat;
  const [linkingAnother, setLinkingAnother] = useState(false);
  const step = telegramWizardStep(telegram, { linkingAnother });
  const status = describeTelegramStatus(telegram);
  const bot = telegram.botUsername;
  const [token, setToken] = useState("");
  const [manualChatId, setManualChatId] = useState("");
  const [showManual, setShowManual] = useState(!supportsPairing);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  // How many chats were linked when "Link another chat" was pressed.
  const [linkedCount, setLinkedCount] = useState(telegram.allowedChatIds.length);

  const bindings = useQuery({
    queryKey: ["uno-assistant", "telegram-bindings", environmentId],
    queryFn: () => listConnectorBindings({ environmentId, projectId: ASSISTANT_PROJECT_ID }),
    enabled: step === "done",
    retry: false,
  });

  // A fresh code whenever the link step shows (codes live 15 minutes).
  const requestCode = useCallback(async () => {
    if (!supportsPairing) return;
    try {
      const pairing = await startTelegramPairing({
        environmentId,
        projectId: ASSISTANT_PROJECT_ID,
      });
      setCode(pairing.code);
    } catch (cause) {
      setError(errorText(cause, "Couldn't make a link."));
    }
  }, [environmentId, supportsPairing]);
  useEffect(() => {
    if (step === "link" && code === null) void requestCode();
  }, [code, requestCode, step]);
  // A newly linked chat ends "link another".
  useEffect(() => {
    if (linkingAnother && telegram.allowedChatIds.length > linkedCount) {
      setLinkingAnother(false);
      setCode(null);
    }
  }, [linkedCount, linkingAnother, telegram.allowedChatIds.length]);

  const save = async (input: { botToken?: string; allowedChatIds?: ReadonlyArray<string> }) => {
    setPending(true);
    setError(null);
    try {
      await saveAssistantTelegram({
        environmentId,
        projectId: ASSISTANT_PROJECT_ID,
        ...(input.botToken ? { botToken: input.botToken } : {}),
        allowedChatIds: input.allowedChatIds ?? telegram.allowedChatIds,
        enabled: true,
        defaultModelSelection: telegram.defaultModelSelection,
        addressing: telegram.addressing,
      });
      onChanged();
      return true;
    } catch (cause) {
      setError(errorText(cause, "Couldn't save Telegram."));
      return false;
    } finally {
      setPending(false);
    }
  };

  const connectToken = async () => {
    const problem = checkBotToken(token);
    if (problem) {
      setError(problem);
      return;
    }
    if (await save({ botToken: token.trim() })) setToken("");
  };

  const addManualChat = async () => {
    const id = parseTelegramChatId(manualChatId);
    if (id === null) {
      setError("The chat id is the number the bot sent back, e.g. 128841517.");
      return;
    }
    if (!(await save({ allowedChatIds: [...new Set([...telegram.allowedChatIds, id])] }))) return;
    setManualChatId("");
    if (mainChat) {
      await upsertConnectorBinding({
        environmentId,
        kind: "telegram",
        chatId: id,
        connectorProjectId: ASSISTANT_PROJECT_ID,
        target: { kind: "thread", threadId: mainChat.id },
      }).catch(() => undefined);
    }
    setLinkingAnother(false);
  };

  const sendToMain = async (chatId: string) => {
    if (!mainChat) return;
    try {
      await upsertConnectorBinding({
        environmentId,
        kind: "telegram",
        chatId,
        connectorProjectId: ASSISTANT_PROJECT_ID,
        target: { kind: "thread", threadId: mainChat.id },
      });
      void bindings.refetch();
    } catch (cause) {
      setError(errorText(cause, "Couldn't change where this chat goes."));
    }
  };

  const sendTest = async () => {
    setPending(true);
    setTestResult(null);
    try {
      const { results } = await sendTelegramTestMessage({
        environmentId,
        projectId: ASSISTANT_PROJECT_ID,
      });
      setTestResult(describeTestResults(results));
    } catch (cause) {
      setTestResult({ ok: false, text: errorText(cause, "Couldn't send the test message.") });
    } finally {
      setPending(false);
    }
  };

  const link = bot && code ? telegramStartLink(bot, code) : null;
  const bindingByChat = useMemo(
    () => new Map((bindings.data?.bindings ?? []).map((binding) => [binding.chatId, binding])),
    [bindings.data],
  );

  return (
    <div className="flex flex-col gap-4" data-testid="uno-telegram-wizard">
      <div
        className={cn(
          "rounded-lg border px-3 py-2 text-xs",
          status.tone === "success" && "border-success/40 bg-success/5 text-foreground",
          status.tone === "warning" && "border-amber-500/40 bg-amber-500/5",
          status.tone === "error" && "border-destructive/40 bg-destructive/5",
          status.tone === "muted" && "border-border text-muted-foreground",
        )}
        data-testid="uno-telegram-status"
      >
        {status.text}
      </div>

      <section className="flex flex-col gap-2">
        <StepHeading
          n={1}
          title={bot ? `Your bot: @${bot}` : "Make your own Telegram bot"}
          state={step === "bot" ? "active" : "done"}
        />
        {step === "bot" ? (
          <div className="flex flex-col gap-2 pl-7 text-sm">
            <p className="text-muted-foreground">
              Uno talks to you through a bot that belongs to you, not a shared one. In Telegram open
              @BotFather, send <code className="rounded bg-muted px-1">/newbot</code> and pick any
              name. It replies with a token.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              onClick={() => openInstallDocs("https://t.me/BotFather")}
            >
              <ExternalLinkIcon className="size-3.5" />
              Open @BotFather
            </Button>
            <div className="flex flex-wrap gap-2">
              <Input
                className="min-w-[220px] flex-1 font-mono"
                placeholder="123456789:AAE…"
                value={token}
                onChange={(event) => {
                  setToken(event.target.value);
                  setError(null);
                }}
                autoComplete="off"
                spellCheck={false}
                aria-label="Bot token"
                data-testid="uno-telegram-token"
              />
              <Button
                size="sm"
                onClick={() => void connectToken()}
                disabled={pending || !token.trim()}
              >
                {pending ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                Connect bot
              </Button>
            </div>
            {isBotTokenRejected(telegram) ? (
              <span
                className="text-xs text-destructive-foreground"
                data-testid="uno-telegram-token-rejected"
              >
                Telegram didn't accept the token you saved. Copy it from @BotFather again and paste
                it here.
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">
                The token stays on this computer.
              </span>
            )}
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <StepHeading
          n={2}
          title="Link your Telegram"
          state={step === "link" ? "active" : step === "done" ? "done" : "todo"}
        />
        {step === "link" ? (
          <div className="flex flex-col gap-2 pl-7 text-sm">
            {supportsPairing ? (
              link ? (
                <div className="flex items-start gap-4">
                  <QRCodeSvg
                    value={link}
                    size={112}
                    className="hidden shrink-0 rounded-lg border border-border bg-white p-1 sm:block"
                    title="Open your bot in Telegram"
                  />
                  <div className="flex min-w-0 flex-col gap-2">
                    <p className="text-muted-foreground">
                      Open the link (or scan it with your phone) and press <b>Start</b> in Telegram.
                      This window updates by itself.
                    </p>
                    <Button
                      size="sm"
                      className="self-start"
                      onClick={() => openInstallDocs(link)}
                      data-testid="uno-telegram-open-link"
                    >
                      <SendIcon className="size-3.5" />
                      Open @{bot} in Telegram
                    </Button>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2Icon className="size-3 animate-spin" />
                      Waiting for Start…
                      <button
                        type="button"
                        className="ml-1 inline-flex items-center gap-1 text-primary hover:underline"
                        onClick={() => void requestCode()}
                      >
                        <RefreshCwIcon className="size-3" /> New link
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2Icon className="size-3.5 animate-spin" />
                  Connecting to your bot…
                </div>
              )
            ) : null}
            {showManual ? (
              <div className="flex flex-col gap-1.5">
                <p className="text-xs text-muted-foreground">
                  Send any message to {bot ? `@${bot}` : "your bot"}: it replies with your chat id.
                  Paste it here.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Input
                    className="min-w-[160px] flex-1 font-mono"
                    placeholder="Chat id, e.g. 128841517"
                    value={manualChatId}
                    inputMode="numeric"
                    onChange={(event) => {
                      setManualChatId(event.target.value);
                      setError(null);
                    }}
                    aria-label="Chat id"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void addManualChat()}
                    disabled={pending || !manualChatId.trim()}
                  >
                    Add chat
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="self-start text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setShowManual(true)}
              >
                Link doesn't open? Add the chat by its id
              </button>
            )}
            {linkingAnother ? (
              <button
                type="button"
                className="self-start text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setLinkingAnother(false)}
              >
                Cancel
              </button>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <StepHeading n={3} title="Check it works" state={step === "done" ? "active" : "todo"} />
        {step === "done" ? (
          <div className="flex flex-col gap-3 pl-7 text-sm">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                Telegram messages go to
              </span>
              <ul className="flex flex-col gap-1" data-testid="uno-telegram-destinations">
                {telegram.allowedChatIds.map((chatId) => {
                  const destination = telegramChatDestination(
                    bindingByChat.get(chatId),
                    mainChat?.id ?? null,
                  );
                  return (
                    <li
                      key={chatId}
                      className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5"
                    >
                      <span className="font-mono text-xs text-muted-foreground">
                        {chatId.startsWith("-") ? "Group" : "Chat"} {chatId}
                      </span>
                      <span className="text-muted-foreground">→</span>
                      <span className="min-w-0 flex-1 truncate">
                        {bindings.isLoading ? "…" : describeTelegramChatDestination(destination)}
                      </span>
                      {destination.kind !== "main" && mainChat && !bindings.isLoading ? (
                        <Button size="xs" variant="outline" onClick={() => void sendToMain(chatId)}>
                          Use main conversation
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={() => void sendTest()}
                disabled={pending}
                data-testid="uno-telegram-test"
              >
                {pending ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <SendIcon className="size-3.5" />
                )}
                Send test message
              </Button>
              {bot ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => openInstallDocs(`https://t.me/${bot}`)}
                >
                  <ExternalLinkIcon className="size-3.5" />
                  Open @{bot}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setCode(null);
                  setLinkedCount(telegram.allowedChatIds.length);
                  setLinkingAnother(true);
                }}
              >
                Link another chat
              </Button>
            </div>
            {testResult ? (
              <p
                className={cn(
                  "text-xs",
                  testResult.ok ? "text-success" : "text-destructive-foreground",
                )}
                data-testid="uno-telegram-test-result"
              >
                {testResult.text}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
      <button
        type="button"
        className="self-start text-xs text-muted-foreground hover:text-foreground"
        onClick={() =>
          void navigate({
            to: "/settings/environment/$environmentId/assistants",
            params: { environmentId },
          })
        }
      >
        Groups, several chats, where each chat goes: advanced settings
      </button>
    </div>
  );
}
