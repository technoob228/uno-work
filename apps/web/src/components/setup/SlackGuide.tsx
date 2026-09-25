/**
 * Connecting your own Slack app (Socket Mode): create it from the prefilled
 * manifest, paste its two tokens, invite it to a channel. The fallback while
 * Uno's own Slack app ("Add to Slack") isn't available, and the path for
 * people who want a bot that is entirely theirs.
 */
import type { EnvironmentId, ManagerAssistantSummary } from "@t3tools/contracts";
import { CheckIcon, ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { slackChannelState } from "../../assistant/assistantChat.logic";
import { saveAssistantSlack } from "../../lib/managerApi";
import { cn } from "../../lib/utils";
import { splitIdList } from "../helper/telegramPageLogic";
import { openInstallDocs } from "../onboarding/harnessInstallLinks";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ConnectedBadge } from "./SetupShell";

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

export function GuideStep({
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

export function SlackGuide({
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
