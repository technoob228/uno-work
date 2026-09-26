/**
 * Step 6 — message the computer from Telegram or Slack, through the Uno
 * assistant's connectors (`/api/manager/assistant/*`).
 *
 * Telegram, the way the mockup has it: Uno's own bot (@get_uno_bot) — a QR
 * code and a link; pressing Start in Telegram links the chat to this computer
 * (the console relays that chat's messages to this computer only). No
 * BotFather, no tokens. A bot of your own stays one click away ("Use your own
 * bot instead"), and is what shows when the shared bot isn't available here
 * (not a cloud computer, or an older console).
 *
 * Slack: "Add to Slack" — Uno's Slack app, installed with Slack's own consent
 * screen; the console relays the workspace's events to this computer. Until
 * that app is live, "Connect your own Slack app" (manifest + two tokens).
 *
 * New chats' messages go to the setup's project when there is one.
 */
import {
  ASSISTANT_PROJECT_ID,
  type EnvironmentId,
  type ManagerAssistantSummary,
  type ManagerTelegramConnectorStatus,
  type ProjectId,
} from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CopyIcon, ExternalLinkIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { slackChannelState, telegramChannelState } from "../../../assistant/assistantChat.logic";
import { usePrimaryEnvironmentId } from "../../../environments/primary";
import {
  ensureHelper,
  getAssistant,
  saveAssistantSlack,
  saveAssistantTelegram,
  upsertConnectorBinding,
} from "../../../lib/managerApi";
import {
  connectSharedTelegram,
  getSlackInstall,
  openAuthWindow,
  removeSlackInstall,
  startSlackInstall,
  type SharedTelegramLink,
} from "../../../lib/setupApi";
import { cn } from "../../../lib/utils";
import { TelegramWizard } from "../../assistant/ConnectChannelDialog";
import { openInstallDocs } from "../../onboarding/harnessInstallLinks";
import { Button } from "../../ui/button";
import { QRCodeSvg } from "../../ui/qr-code";
import { toastManager } from "../../ui/toast";
import { SlackBrandMark, TelegramMark } from "../brandMarks";
import { ConnectedBadge, SetupHeading, SetupNote, SetupShell, SoonBadge } from "../SetupShell";
import { SlackGuide } from "../SlackGuide";
import { useSetupNavigation } from "../useSetupNavigation";
import { useSetupProgress } from "../useSetupProgress";

const SUMMARY_KEY = ["uno-setup", "assistant"] as const;

function useAssistantSummary(environmentId: EnvironmentId | null, fast: boolean) {
  return useQuery({
    queryKey: [...SUMMARY_KEY, environmentId],
    queryFn: async (): Promise<ManagerAssistantSummary> => {
      try {
        return await getAssistant({
          environmentId: environmentId!,
          projectId: ASSISTANT_PROJECT_ID,
        });
      } catch {
        return (await ensureHelper({ environmentId: environmentId! })).helper;
      }
    },
    enabled: environmentId !== null,
    refetchInterval: fast ? 2500 : false,
  });
}

/** The connector talks through Uno's shared bot (a relay token, not a BotFather token). */
export function isSharedTelegram(telegram: ManagerTelegramConnectorStatus): boolean {
  return (telegram as { readonly shared?: boolean }).shared === true;
}

export function telegramConnected(telegram: ManagerTelegramConnectorStatus): boolean {
  return telegramChannelState(telegram) === "on" && telegram.allowedChatIds.length > 0;
}

/** Why the shared bot can't be used here, in plain words; null = it can. */
export function sharedTelegramProblem(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/not_cloud_computer/.test(message)) {
    return "Uno’s bot talks to cloud computers. On this one, use a bot of your own:";
  }
  return "Uno’s bot isn’t available right now. Use a bot of your own:";
}

function Preview({ lines, caption }: { lines: [string, string]; caption: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-muted/50 p-3" aria-hidden>
      <div className="max-w-[85%] self-end rounded-2xl rounded-br-md bg-primary/10 px-3 py-2 text-sm">
        {lines[0]}
      </div>
      <div className="max-w-[85%] self-start rounded-2xl rounded-bl-md bg-background px-3 py-2 text-sm shadow-xs">
        {lines[1]}
      </div>
      <div className="text-center text-[11px] text-muted-foreground">{caption}</div>
    </div>
  );
}

function ChannelCard({
  logo,
  name,
  description,
  on,
  testId,
  children,
}: {
  logo: ReactNode;
  name: string;
  description: string;
  on: boolean;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col gap-4 rounded-2xl border p-4 sm:p-5",
        on ? "border-success/40 bg-success/[0.02]" : "border-border",
      )}
      data-testid={testId}
    >
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl border border-border bg-background">
          {logo}
        </span>
        <div>
          <div className="font-medium">{name}</div>
          <div className="text-xs text-muted-foreground">{description}</div>
        </div>
      </div>
      {children}
    </section>
  );
}

// ── Telegram ───────────────────────────────────────────────────────────

function TelegramCard({
  environmentId,
  summary,
  projectId,
  projectName,
  onChanged,
}: {
  environmentId: EnvironmentId;
  summary: ManagerAssistantSummary;
  projectId: ProjectId | null;
  projectName: string | null;
  onChanged: () => void;
}) {
  const telegram = summary.telegram;
  const connected = telegramConnected(telegram);
  const shared = isSharedTelegram(telegram);
  // Uno's bot is the default unless a bot of the person's own is set up.
  const ownBotConfigured = telegram.configured && !shared;
  const [mode, setMode] = useState<"shared" | "own">(ownBotConfigured ? "own" : "shared");
  const [link, setLink] = useState<SharedTelegramLink | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [copied, setCopied] = useState(false);
  const requested = useRef(false);

  const requestLink = useCallback(async () => {
    setProblem(null);
    try {
      const next = await connectSharedTelegram({ environmentId, projectId: ASSISTANT_PROJECT_ID });
      setLink(next);
      onChanged();
    } catch (cause) {
      setProblem(sharedTelegramProblem(cause));
    }
  }, [environmentId, onChanged]);

  useEffect(() => {
    if (mode !== "shared" || connected || requested.current) return;
    requested.current = true;
    void requestLink();
  }, [connected, mode, requestLink]);

  // A chat that just linked: its messages go to the setup's project.
  const bound = useRef(new Set(telegram.allowedChatIds));
  useEffect(() => {
    const fresh = telegram.allowedChatIds.filter((id) => !bound.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) bound.current.add(id);
    setWaiting(false);
    toastManager.add({ type: "success", title: "Telegram connected" });
    if (!projectId) return;
    for (const chatId of fresh) {
      void upsertConnectorBinding({
        environmentId,
        kind: "telegram",
        chatId,
        connectorProjectId: summary.projectId,
        target: { kind: "project", projectId },
        notifyOnComplete: true,
      }).catch(() => undefined);
    }
  }, [environmentId, projectId, summary.projectId, telegram.allowedChatIds]);

  const disconnect = async () => {
    await saveAssistantTelegram({
      environmentId,
      projectId: summary.projectId,
      allowedChatIds: [],
      enabled: false,
      defaultModelSelection: telegram.defaultModelSelection,
      addressing: telegram.addressing,
    }).catch(() => undefined);
    bound.current = new Set();
    requested.current = false;
    setLink(null);
    onChanged();
  };

  if (connected) {
    return (
      <div className="flex flex-col gap-3">
        <ConnectedBadge>
          Connected{telegram.botUsername ? ` · @${telegram.botUsername}` : ""}
        </ConnectedBadge>
        <Preview
          lines={[
            "What’s left on the landing page?",
            "Two things: the price table and the contact form. Want me to do both?",
          ]}
          caption={`Telegram · goes to ${projectName ?? "Uno"}`}
        />
        <div className="flex flex-wrap gap-2">
          {telegram.botUsername ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => openInstallDocs(`https://t.me/${telegram.botUsername}`)}
            >
              <ExternalLinkIcon className="size-3.5" />
              Open Telegram
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => void disconnect()}>
            Disconnect
          </Button>
        </div>
      </div>
    );
  }

  if (mode === "own" || problem) {
    return (
      <div className="flex flex-col gap-3">
        {problem ? <p className="text-sm text-muted-foreground">{problem}</p> : null}
        <TelegramWizard environmentId={environmentId} summary={summary} onChanged={onChanged} />
        {!problem ? (
          <button
            type="button"
            className="self-start text-xs text-primary hover:underline"
            onClick={() => {
              requested.current = false;
              setMode("shared");
            }}
          >
            Use Uno’s bot instead — no BotFather
          </button>
        ) : null}
      </div>
    );
  }

  const url = link?.link ?? null;
  return (
    <div className="flex flex-col gap-3" data-testid="setup-telegram-shared">
      <div className="flex items-start gap-4">
        {/* On a phone the link opens Telegram right there: no QR to scan. */}
        <div className="hidden size-[124px] shrink-0 items-center justify-center rounded-xl border border-border bg-white p-1.5 sm:flex">
          {url ? (
            <QRCodeSvg value={url} size={110} title="Open Uno’s bot in Telegram" />
          ) : (
            <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          {waiting ? (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2Icon className="size-3.5 animate-spin" />
              Waiting for you to press <b className="text-foreground">Start</b> in Telegram…
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">
              <span className="hidden sm:inline">Scan with your phone, or open the link:</span>
              <span className="sm:hidden">Open the link and press Start:</span>
            </span>
          )}
          {url ? (
            <span
              className="truncate font-mono text-xs text-foreground"
              data-testid="setup-telegram-link"
            >
              {url.replace(/^https:\/\//, "")}
            </span>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {waiting ? (
              <Button size="sm" variant="outline" onClick={onChanged}>
                I pressed Start
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={!url}
                onClick={() => {
                  if (!url) return;
                  openInstallDocs(url);
                  setWaiting(true);
                }}
                data-testid="setup-telegram-open"
              >
                <ExternalLinkIcon className="size-3.5" />
                Open Telegram
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={!url}
              onClick={() => {
                if (!url) return;
                void navigator.clipboard?.writeText(url).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              <CopyIcon className="size-3.5" />
              {copied ? "Copied" : "Copy link"}
            </Button>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {waiting ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            onClick={() => {
              setWaiting(false);
              void requestLink();
            }}
          >
            <RefreshCwIcon className="size-3" /> New link
          </button>
        ) : null}
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setMode("own")}
          data-testid="setup-telegram-own"
        >
          Use your own bot instead
        </button>
      </div>
    </div>
  );
}

/**
 * The assistant's Telegram, on its own (goal-first start and Home): Uno's
 * shared bot link / QR, or "Connected" with "Open Telegram". Messages go to
 * the assistant (Uno), not to a project.
 */
export function AssistantTelegramPanel({
  onConnected,
}: {
  onConnected?: (username: string | null) => void;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const queryClient = useQueryClient();
  const summary = useAssistantSummary(environmentId, true);
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: SUMMARY_KEY });
    void queryClient.invalidateQueries({ queryKey: ["uno-assistant"] });
  }, [queryClient]);
  const data = summary.data;
  const connected = data ? telegramConnected(data.telegram) : false;
  const reported = useRef(false);
  useEffect(() => {
    if (!connected || reported.current || !data) return;
    reported.current = true;
    onConnected?.(data.telegram.botUsername ?? null);
  }, [connected, data, onConnected]);
  if (!environmentId || summary.isPending) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" />
        Getting your Telegram link…
      </div>
    );
  }
  if (!data) {
    return (
      <p className="text-sm text-muted-foreground">
        Your assistant is still starting. Give it a few seconds.
      </p>
    );
  }
  return (
    <TelegramCard
      environmentId={environmentId}
      summary={data}
      projectId={null}
      projectName={null}
      onChanged={refresh}
    />
  );
}

// ── Slack ──────────────────────────────────────────────────────────────

function SlackCard({
  environmentId,
  summary,
  onChanged,
}: {
  environmentId: EnvironmentId;
  summary: ManagerAssistantSummary;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [installing, setInstalling] = useState(false);
  const [ownApp, setOwnApp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const install = useQuery({
    queryKey: ["uno-setup", "slack-install", environmentId],
    queryFn: async () => {
      try {
        return await getSlackInstall({ environmentId, projectId: ASSISTANT_PROJECT_ID });
      } catch {
        return null; // an older daemon: only your own Slack app
      }
    },
    refetchInterval: installing ? 2000 : false,
  });
  const state = install.data;
  const manualOn = summary.slack.configured && slackChannelState(summary.slack) === "on";
  const connected = (state?.installed === true && state.connected) || manualOn;

  useEffect(() => {
    if (installing && state?.installed && state.connected) {
      setInstalling(false);
      toastManager.add({ type: "success", title: "Slack connected" });
      onChanged();
    }
  }, [installing, onChanged, state]);

  const addToSlack = async () => {
    setError(null);
    setInstalling(true);
    try {
      const started = await startSlackInstall({ environmentId, projectId: ASSISTANT_PROJECT_ID });
      if (!started.available || !started.authorizeUrl) {
        setInstalling(false);
        setOwnApp(true);
        return;
      }
      const result = await openAuthWindow(started.authorizeUrl, "uno-slack");
      await queryClient.invalidateQueries({ queryKey: ["uno-setup", "slack-install"] });
      if (!result.ok) window.setTimeout(() => setInstalling(false), 4000);
    } catch (cause) {
      setInstalling(false);
      setError(cause instanceof Error ? cause.message : "Couldn't open Slack.");
    }
  };

  const disconnect = async () => {
    if (state?.installed) {
      await removeSlackInstall({ environmentId, projectId: ASSISTANT_PROJECT_ID }).catch(
        () => undefined,
      );
    } else {
      await saveAssistantSlack({
        environmentId,
        projectId: summary.projectId,
        allowedChannelIds: summary.slack.allowedChannelIds,
        enabled: false,
      }).catch(() => undefined);
    }
    await queryClient.invalidateQueries({ queryKey: ["uno-setup", "slack-install"] });
    onChanged();
  };

  if (connected) {
    const where = state?.installed ? state.teamName : summary.slack.botUserName;
    return (
      <div className="flex flex-col gap-3">
        <ConnectedBadge>
          Connected{where ? ` to ${where}` : ""}
          {!state?.installed && summary.slack.botUserName
            ? ` as @${summary.slack.botUserName}`
            : ""}
        </ConnectedBadge>
        <Preview
          lines={[
            "@Uno summarize today’s notes-from-call.md",
            "Three decisions, two open questions. Posted the summary in the thread.",
          ]}
          caption="Slack · mention @Uno in a channel"
        />
        <Button size="sm" variant="ghost" className="self-start" onClick={() => void disconnect()}>
          Disconnect
        </Button>
      </div>
    );
  }

  const available = state?.available === true;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Add Uno to your workspace, then mention <b className="text-foreground">@Uno</b> in any
        channel you invite it to.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void addToSlack()}
          disabled={!available || installing}
          className="inline-flex h-10 items-center gap-2 self-start rounded-lg border border-border bg-background px-4 text-sm font-semibold text-foreground shadow-xs transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-60"
          data-testid="setup-add-to-slack"
        >
          {installing ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <SlackBrandMark className="size-[18px]" />
          )}
          {installing ? "Waiting for Slack…" : "Add to Slack"}
        </button>
        {install.isFetched && !available ? <SoonBadge /> : null}
      </div>
      {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
      {ownApp || (install.isFetched && !available) ? (
        ownApp ? (
          <div className="rounded-xl border border-border p-3">
            <SlackGuide environmentId={environmentId} summary={summary} onChanged={onChanged} />
          </div>
        ) : (
          <button
            type="button"
            className="self-start text-xs text-primary hover:underline"
            onClick={() => setOwnApp(true)}
          >
            Connect your own Slack app now
          </button>
        )
      ) : null}
    </div>
  );
}

export function ChannelsStep() {
  const environmentId = usePrimaryEnvironmentId();
  const progress = useSetupProgress();
  const { completeStep } = useSetupNavigation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [polling] = useState(true);
  const summary = useAssistantSummary(environmentId, polling);
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: SUMMARY_KEY });
    void queryClient.invalidateQueries({ queryKey: ["uno-assistant"] });
  }, [queryClient]);
  const data = summary.data;
  const project = progress.project;

  return (
    <SetupShell
      step="channels"
      primary={{ label: "Continue", onClick: () => void completeStep("channels") }}
    >
      <SetupHeading
        title="Message your computer from anywhere"
        lead="Write to it like to a colleague. It does the work here and answers in the same chat."
      />
      {!environmentId || summary.isPending ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          Checking Telegram and Slack…
        </div>
      ) : !data ? (
        <p className="text-sm text-muted-foreground">
          Couldn&apos;t reach Uno on this computer. You can connect Telegram and Slack later from
          the Uno chat.
        </p>
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
          <ChannelCard
            logo={<TelegramMark className="size-5" />}
            name="Telegram"
            description="From your phone, on the go"
            on={telegramConnected(data.telegram)}
            testId="setup-channel-telegram"
          >
            <TelegramCard
              environmentId={environmentId}
              summary={data}
              projectId={(project?.id as ProjectId | undefined) ?? null}
              projectName={project?.name ?? null}
              onChanged={refresh}
            />
          </ChannelCard>
          <ChannelCard
            logo={<SlackBrandMark className="size-5" />}
            name="Slack"
            description="With your team, in channels"
            on={data.slack.configured && slackChannelState(data.slack) === "on"}
            testId="setup-channel-slack"
          >
            <SlackCard environmentId={environmentId} summary={data} onChanged={refresh} />
          </ChannelCard>
        </div>
      )}
      <SetupNote>
        Only you can talk to it until you add people.{" "}
        {project ? `Messages go to ${project.name}; change` : "Change"} that in{" "}
        <button
          type="button"
          className="text-primary hover:underline"
          onClick={() => {
            if (environmentId) {
              void navigate({
                to: "/settings/environment/$environmentId/assistants",
                params: { environmentId },
              });
            }
          }}
        >
          Settings → Uno
        </button>
        .
      </SetupNote>
    </SetupShell>
  );
}
