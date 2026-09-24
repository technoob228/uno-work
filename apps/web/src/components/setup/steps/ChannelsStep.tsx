/**
 * Step 6 — message the computer from Telegram or Slack. The same connectors
 * as the Uno chat's Connect menu and its settings page (the assistant's own
 * Telegram bot and Slack app, `/api/manager/assistant/*`), walked through one
 * step at a time: make the bot → paste its token → say hi → check. Messages
 * from the owner's chat go to the setup project when there is one.
 */
import {
  ASSISTANT_PROJECT_ID,
  type EnvironmentId,
  type ManagerAssistantSummary,
  type ProjectId,
} from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { telegramChannelState, slackChannelState } from "../../../assistant/assistantChat.logic";
import { usePrimaryEnvironmentId } from "../../../environments/primary";
import {
  ensureHelper,
  getAssistant,
  saveAssistantSlack,
  saveAssistantTelegram,
  upsertConnectorBinding,
} from "../../../lib/managerApi";
import { cn } from "../../../lib/utils";
import { parseTelegramChatId, splitIdList } from "../../helper/telegramPageLogic";
import { openInstallDocs } from "../../onboarding/harnessInstallLinks";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { QRCodeSvg } from "../../ui/qr-code";
import { SlackBrandMark, TelegramMark } from "../brandMarks";
import { ConnectedBadge, SetupHeading, SetupNote, SetupShell } from "../SetupShell";
import { useSetupNavigation } from "../useSetupNavigation";
import { useSetupProgress } from "../useSetupProgress";

/**
 * Slack's "create from manifest" link, prefilled. Mirrors
 * docs/slack-app-manifest.yaml (Socket Mode bot; keep the two in step).
 */
const SLACK_MANIFEST = {
  display_information: {
    name: "Uno",
    description: "Your Uno computer, in Slack.",
    background_color: "#101014",
  },
  features: { bot_user: { display_name: "Uno", always_online: true } },
  oauth_config: {
    scopes: {
      bot: [
        "app_mentions:read",
        "chat:write",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "channels:history",
        "groups:history",
        "users:read",
        "files:read",
      ],
    },
  },
  settings: {
    event_subscriptions: {
      bot_events: [
        "app_mention",
        "message.im",
        "message.mpim",
        "message.channels",
        "message.groups",
      ],
    },
    interactivity: { is_enabled: false },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
};
export const SLACK_NEW_APP_URL = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(
  JSON.stringify(SLACK_MANIFEST),
)}`;

function useAssistantSummary(environmentId: EnvironmentId | null) {
  return useQuery({
    queryKey: ["uno-setup", "assistant", environmentId],
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
    // While a bot is connecting, keep checking so "Connected as @…" shows up by itself.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const connecting =
        (data.telegram.configured && data.telegram.health === null && !data.telegram.lastError) ||
        (data.slack.configured && data.slack.botUserName === null && !data.slack.lastError);
      return connecting ? 3000 : false;
    },
  });
}

function GuideStep({
  n,
  title,
  done,
  active,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  active: boolean;
  children?: ReactNode;
}) {
  return (
    <li className={cn("flex gap-3", !active && !done && "opacity-50")}>
      <span
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
          done ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary",
        )}
      >
        {done ? <CheckIcon className="size-3" strokeWidth={3} /> : n}
      </span>
      <div className="min-w-0 flex-1 text-sm">
        <div className="font-medium">{title}</div>
        {active ? <div className="mt-1.5 flex flex-col gap-2">{children}</div> : null}
      </div>
    </li>
  );
}

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function TelegramGuide({
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
  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = telegramChannelState(telegram);
  const hasToken = telegram.configured;
  const hasChat = telegram.allowedChatIds.length > 0;
  const bot = telegram.botUsername;
  const botLink = bot ? `https://t.me/${bot}` : null;

  const save = async (input: { botToken?: string; allowedChatIds?: ReadonlyArray<string> }) => {
    setPending(true);
    setError(null);
    try {
      await saveAssistantTelegram({
        environmentId,
        projectId: summary.projectId,
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
    const value = token.trim();
    if (!/^\d+:[\w-]{20,}$/.test(value)) {
      setError("A bot token looks like 123456789:AAE… — copy the whole line from BotFather.");
      return;
    }
    if (await save({ botToken: value })) setToken("");
  };

  const addChat = async () => {
    const id = parseTelegramChatId(chatId);
    if (id === null) {
      setError("The chat id is the number your bot sent back, e.g. 128841517.");
      return;
    }
    const ok = await save({ allowedChatIds: [...new Set([...telegram.allowedChatIds, id])] });
    if (!ok) return;
    setChatId("");
    if (projectId) {
      await upsertConnectorBinding({
        environmentId,
        kind: "telegram",
        chatId: id,
        connectorProjectId: summary.projectId,
        target: { kind: "project", projectId },
        notifyOnComplete: true,
      }).catch(() => undefined);
    }
  };

  if (hasToken && hasChat && state === "on") {
    return (
      <div className="flex flex-col gap-3">
        <ConnectedBadge>Connected{bot ? ` as @${bot}` : ""}</ConnectedBadge>
        <p className="text-sm text-muted-foreground">
          Write to {bot ? `@${bot}` : "your bot"} like to a colleague.{" "}
          {projectName ? `Messages go to ${projectName}.` : "Uno picks the project."}
        </p>
        {botLink ? (
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            onClick={() => openInstallDocs(botLink)}
          >
            <ExternalLinkIcon className="size-3.5" />
            Open @{bot}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-4">
        <GuideStep n={1} title="Make a bot in Telegram" done={hasToken} active={!hasToken}>
          <p className="text-muted-foreground">
            Open @BotFather, send <code className="rounded bg-muted px-1">/newbot</code> and pick a
            name. It gives you a token.
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
        </GuideStep>
        <GuideStep n={2} title="Paste the token here" done={hasToken} active={!hasToken}>
          <div className="flex flex-wrap gap-2">
            <Input
              className="min-w-[200px] flex-1 font-mono"
              placeholder="123456789:AAE…"
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
                setError(null);
              }}
              autoComplete="off"
              spellCheck={false}
              aria-label="Bot token"
              data-testid="setup-telegram-token"
            />
            <Button
              size="sm"
              onClick={() => void connectToken()}
              disabled={pending || !token.trim()}
            >
              {pending ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              Connect
            </Button>
          </div>
          <span className="text-xs text-muted-foreground">
            The bot is yours. The token stays on this computer.
          </span>
        </GuideStep>
        <GuideStep n={3} title="Say hi to your bot" done={hasChat} active={hasToken && !hasChat}>
          <div className="flex items-start gap-4">
            {botLink ? (
              <QRCodeSvg
                value={botLink}
                size={96}
                className="hidden shrink-0 rounded-lg border border-border bg-white p-1 sm:block"
                title="Open your bot in Telegram"
              />
            ) : null}
            <div className="flex min-w-0 flex-col gap-2">
              <p className="text-muted-foreground">
                Open {bot ? `@${bot}` : "your bot"} and press <b>Start</b>. It replies with a number
                — your chat id. Paste it here, so only you can talk to it.
              </p>
              {botLink ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="self-start"
                  onClick={() => openInstallDocs(botLink)}
                >
                  <ExternalLinkIcon className="size-3.5" />
                  Open @{bot}
                </Button>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Input
              className="min-w-[160px] flex-1 font-mono"
              placeholder="Chat id, e.g. 128841517"
              value={chatId}
              inputMode="numeric"
              onChange={(event) => {
                setChatId(event.target.value);
                setError(null);
              }}
              aria-label="Chat id"
            />
            <Button size="sm" onClick={() => void addChat()} disabled={pending || !chatId.trim()}>
              Add
            </Button>
          </div>
        </GuideStep>
        <GuideStep n={4} title="Check it works" done={false} active={hasToken && hasChat}>
          <p className="text-muted-foreground">
            {state === "problem"
              ? `Telegram says: ${telegram.lastError ?? "the bot can't connect"}. Check the token.`
              : "Connecting to Telegram…"}
          </p>
        </GuideStep>
      </ol>
      {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
    </div>
  );
}

function SlackGuide({
  environmentId,
  summary,
  onChanged,
}: {
  environmentId: EnvironmentId;
  summary: ManagerAssistantSummary;
  onChanged: () => void;
}) {
  const slack = summary.slack;
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [channels, setChannels] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = slackChannelState(slack);

  if (slack.configured && state === "on") {
    return (
      <div className="flex flex-col gap-2">
        <ConnectedBadge>
          Connected{slack.botUserName ? ` as @${slack.botUserName}` : ""}
        </ConnectedBadge>
        <p className="text-sm text-muted-foreground">
          Mention the bot in any channel you invite it to, or write to it directly.
        </p>
      </div>
    );
  }

  const connect = async () => {
    if (!botToken.trim().startsWith("xoxb-") || !appToken.trim().startsWith("xapp-")) {
      setError("Paste both: the Bot token (xoxb-…) and the App token (xapp-…).");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await saveAssistantSlack({
        environmentId,
        projectId: summary.projectId,
        botToken: botToken.trim(),
        appToken: appToken.trim(),
        allowedChannelIds: splitIdList(channels),
        enabled: true,
        defaultModelSelection: slack.defaultModelSelection,
        addressing: slack.addressing,
      });
      setBotToken("");
      setAppToken("");
      onChanged();
    } catch (cause) {
      setError(errorText(cause, "Couldn't save Slack."));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-4">
        <GuideStep n={1} title="Create the Uno app in Slack" done={false} active>
          <p className="text-muted-foreground">
            It opens with everything filled in. Pick your workspace, then Create and Install.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            onClick={() => openInstallDocs(SLACK_NEW_APP_URL)}
          >
            <ExternalLinkIcon className="size-3.5" />
            Create the app
          </Button>
        </GuideStep>
        <GuideStep n={2} title="Copy two tokens" done={false} active>
          <p className="text-muted-foreground">
            OAuth &amp; Permissions → Bot token (xoxb-…). Basic Information → App-Level Tokens →
            Generate, scope <code className="rounded bg-muted px-1">connections:write</code>{" "}
            (xapp-…).
          </p>
          <Input
            className="font-mono"
            placeholder="xoxb-…"
            value={botToken}
            onChange={(event) => setBotToken(event.target.value)}
            aria-label="Slack bot token"
            autoComplete="off"
            spellCheck={false}
          />
          <Input
            className="font-mono"
            placeholder="xapp-…"
            value={appToken}
            onChange={(event) => setAppToken(event.target.value)}
            aria-label="Slack app token"
            autoComplete="off"
            spellCheck={false}
          />
          <Input
            placeholder="Channel ids it may answer in (optional), e.g. C0123ABC"
            value={channels}
            onChange={(event) => setChannels(event.target.value)}
            aria-label="Slack channel ids"
          />
          <Button
            size="sm"
            className="self-start"
            onClick={() => void connect()}
            disabled={pending}
          >
            {pending ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
            Connect
          </Button>
        </GuideStep>
        <GuideStep n={3} title="Invite it to a channel" done={false} active>
          <p className="text-muted-foreground">
            In the channel: <code className="rounded bg-muted px-1">/invite @Uno</code>, then
            mention <b>@Uno</b> with a task.
          </p>
        </GuideStep>
      </ol>
      {slack.configured && state === "problem" ? (
        <p className="text-xs text-destructive-foreground">
          Slack says: {slack.lastError ?? "the app can't connect"}.
        </p>
      ) : null}
      {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
    </div>
  );
}

function ChannelCard({
  logo,
  name,
  description,
  on,
  children,
}: {
  logo: ReactNode;
  name: string;
  description: string;
  on: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-4 rounded-2xl border p-4 sm:p-5",
        on ? "border-primary/40 bg-primary/[0.03]" : "border-border",
      )}
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

export function ChannelsStep() {
  const environmentId = usePrimaryEnvironmentId();
  const progress = useSetupProgress();
  const { completeStep } = useSetupNavigation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const summary = useAssistantSummary(environmentId);
  const refresh = () => {
    void summary.refetch();
    void queryClient.invalidateQueries({ queryKey: ["uno-assistant", "channels"] });
  };
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
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <ChannelCard
            logo={<TelegramMark className="size-5" />}
            name="Telegram"
            description="From your phone, on the go"
            on={
              telegramChannelState(data.telegram) === "on" &&
              data.telegram.allowedChatIds.length > 0
            }
          >
            <TelegramGuide
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
            on={slackChannelState(data.slack) === "on"}
          >
            <SlackGuide environmentId={environmentId} summary={data} onChanged={refresh} />
          </ChannelCard>
        </div>
      )}
      <SetupNote>
        Only the chats you add can talk to it. Change who and where in{" "}
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
          Uno settings
        </button>
        .
      </SetupNote>
    </SetupShell>
  );
}
