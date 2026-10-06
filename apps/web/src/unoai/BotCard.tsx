/**
 * The free bot's card in the Uno AI chat (bot_setup → freeBot.ts).
 * One card, four looks — make it in @BotFather and paste the token, starting,
 * live (open it in Telegram), asleep (keep it on). The account's status
 * decides; the transcript's state is only the first guess. Older bot_setup
 * calls in the chat are one quiet line.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BotIcon, CheckIcon, ExternalLinkIcon, LoaderIcon, SendIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { checkoutHref } from "../account/accountOverview";
import { subscriptionQuery } from "../components/myuno/myUnoQueries";
import { Button } from "../components/ui/button";
import { liteStanding } from "../lite/webLite";
import {
  extractBotToken,
  fetchFreeBot,
  freeBotKey,
  freeBotPollMs,
  keepOnLabel,
  liveMetaLine,
  liveTileLine,
  submitFreeBotToken,
  tokenErrorOffersPlan,
  type FreeBotStatus,
} from "./freeBot";
import { accountErrorInfo, unoAiAvailable } from "./unoAiApi";
import type { AiItem, BotState } from "./unoAiModel";

type BotItem = Extract<AiItem, { kind: "bot" }>;

export const BOTFATHER_URL = "https://t.me/BotFather";

/** The free bot's status, polled while a card or the sidebar tile shows it. */
export function useFreeBotStatus(active = true) {
  return useQuery({
    queryKey: freeBotKey,
    queryFn: fetchFreeBot,
    enabled: active && unoAiAvailable(),
    staleTime: 2_000,
    retry: false,
    refetchInterval: (query) => freeBotPollMs(query.state.data?.state),
  });
}

export function BotChatItem({ item, interactive }: { item: BotItem; interactive: boolean }) {
  if (!interactive) {
    return (
      <p
        className="flex items-center gap-2 text-xs text-muted-foreground"
        data-testid="uno-ai-bot-saved"
      >
        <CheckIcon className="size-3.5" />
        {item.update ? "Bot updated" : "Bot settings saved"}
      </p>
    );
  }
  return <BotCard item={item} />;
}

function BotCard({ item }: { item: BotItem }) {
  const status = useFreeBotStatus();
  const data = status.data;
  const state: BotState = data?.state ?? item.state;
  const username = data?.bot?.username ?? item.username;

  const updateLine = item.update ? (
    <p
      className="flex items-center gap-2 text-sm text-muted-foreground"
      data-testid="uno-ai-bot-updated"
    >
      <CheckIcon className="size-3.5 shrink-0" />
      Your bot got the new settings — it answers with them in about a minute.
    </p>
  ) : null;

  if (state === "starting") {
    return (
      <>
        {updateLine}
        <Frame testId="uno-ai-bot-starting">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <LoaderIcon className="size-4 animate-spin text-muted-foreground" />
            {username ? `Starting @${username}…` : "Starting your bot…"}
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">Usually under a minute.</p>
        </Frame>
      </>
    );
  }

  if (state === "live") {
    const href = data?.bot?.owner_url || data?.bot?.url || item.url;
    const meta = data ? liveMetaLine(data) : item.freeUntil ? `Free until ${item.freeUntil}` : null;
    return (
      <>
        {updateLine}
        <Frame testId="uno-ai-bot-live" live>
          <p className="flex items-center gap-2 text-sm font-semibold">
            <SendIcon className="size-4 text-emerald-600" />
            {username ? `@${username} is live` : "Your bot is live"}
          </p>
          {meta ? <p className="mt-0.5 text-xs text-muted-foreground">{meta}</p> : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {href ? (
              <Button
                size="sm"
                render={<a href={href} target="_blank" rel="noreferrer" />}
                data-testid="uno-ai-bot-open"
              >
                Open in Telegram
                <ExternalLinkIcon />
              </Button>
            ) : null}
            {data?.on_free_days && data.keep_on ? (
              <KeepOnButton keepOn={data.keep_on} variant="outline" />
            ) : null}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Press Start in Telegram — orders and questions it can't answer will come to you there.
          </p>
        </Frame>
      </>
    );
  }

  if (state === "ended") {
    return (
      <Frame testId="uno-ai-bot-ended">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <BotIcon className="size-4 text-muted-foreground" />
          {username
            ? `@${username} is asleep — its free days are over`
            : "Your bot is asleep — its free days are over"}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {liveMetaLine({ ...(data ?? emptyStatus), on_free_days: false })}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <KeepOnButton keepOn={data?.keep_on} variant="default" />
        </div>
      </Frame>
    );
  }

  return (
    <>
      {updateLine}
      <TokenSetup
        status={data}
        failedError={state === "failed" ? (data?.error ?? null) : null}
        freeDays={item.freeDays}
      />
    </>
  );
}

const emptyStatus: FreeBotStatus = {
  enabled: false,
  days: 0,
  state: "none",
  on_free_days: false,
};

/** none / draft / failed: make it in @BotFather, paste the token. */
function TokenSetup({
  status,
  failedError,
  freeDays,
}: {
  status: FreeBotStatus | undefined;
  failedError: string | null;
  freeDays: number | null;
}) {
  const queryClient = useQueryClient();
  const subscription = useQuery(subscriptionQuery());
  // The token lives only in this field until it's sent — never in the chat, storage or logs.
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ detail: string; offerPlan: boolean } | null>(null);

  const hasPlan = !subscription.isPending && liteStanding(subscription.data ?? null) !== "free";
  const days = status?.days || freeDays || 0;
  const freeLine = (status ? status.enabled : days > 0) && !hasPlan && days > 0;

  const start = async () => {
    const value = extractBotToken(token);
    setToken("");
    if (!value) return;
    setBusy(true);
    setErr(null);
    try {
      const next = await submitFreeBotToken(value);
      queryClient.setQueryData(freeBotKey, next);
      void queryClient.invalidateQueries({ queryKey: freeBotKey });
    } catch (e) {
      const info = accountErrorInfo(e);
      setErr({
        detail: info.detail || "Couldn't start the bot. Try again in a minute.",
        offerPlan: tokenErrorOffersPlan(info.code),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame testId="uno-ai-bot-setup">
      <p className="flex items-center gap-2 text-sm font-semibold">
        <BotIcon className="size-4 text-muted-foreground" />
        Create your bot in Telegram
      </p>
      <ol className="mt-2 space-y-1 text-sm text-muted-foreground">
        <li>
          1. Open{" "}
          <a
            href={BOTFATHER_URL}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-foreground underline underline-offset-2"
            data-testid="uno-ai-bot-botfather"
          >
            @BotFather
          </a>
        </li>
        <li>2. Send /newbot and pick a name</li>
        <li>3. Paste the token here</li>
      </ol>
      {failedError ? <p className="mt-2.5 text-xs text-destructive">{failedError}</p> : null}
      <form
        className="mt-2.5 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          placeholder="123456:ABC…"
          aria-label="Bot token"
          className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 font-mono text-sm sm:max-w-72"
          data-testid="uno-ai-bot-token"
        />
        <Button
          size="sm"
          type="submit"
          disabled={busy || !token.trim()}
          data-testid="uno-ai-bot-start"
        >
          {busy ? <LoaderIcon className="animate-spin" /> : null}
          Start my bot
        </Button>
      </form>
      {err ? (
        <div className="mt-2 flex flex-col items-start gap-2">
          <p className="text-xs text-destructive" role="alert">
            {err.detail}
          </p>
          {err.offerPlan ? <KeepOnButton keepOn={status?.keep_on} variant="outline" /> : null}
        </div>
      ) : null}
      <p className="mt-2 text-xs text-muted-foreground">
        {freeLine ? `Free for ${days} days. ` : ""}Between messages it rests and wakes in a blink.
      </p>
    </Frame>
  );
}

function KeepOnButton({
  keepOn,
  variant,
}: {
  keepOn: FreeBotStatus["keep_on"] | undefined;
  variant: "default" | "outline";
}) {
  return (
    <Button
      size="sm"
      variant={variant}
      render={
        <a href={keepOn?.checkout_url || checkoutHref("plus")} target="_blank" rel="noreferrer" />
      }
      data-testid="uno-ai-bot-keep-on"
    >
      {keepOnLabel(keepOn)}
      <ExternalLinkIcon />
    </Button>
  );
}

function Frame({
  children,
  testId,
  live = false,
}: {
  children: ReactNode;
  testId: string;
  live?: boolean;
}) {
  return (
    <div
      className={
        live
          ? "rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3.5"
          : "rounded-xl border border-border bg-card/60 p-3.5"
      }
      data-testid={testId}
    >
      {children}
    </div>
  );
}

/**
 * Lite sidebar, "Live": the free bot in one line — "@crumb_bot · free until
 * Oct 12 · answered 37" + Keep it on. Hidden until there's a bot. Polls only
 * while a bot exists (every 30 s, 3 s while it starts).
 */
export function LiveBotTile() {
  const status = useQuery({
    queryKey: freeBotKey,
    queryFn: fetchFreeBot,
    enabled: unoAiAvailable(),
    staleTime: 10_000,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.bot ? freeBotPollMs(query.state.data.state) : false,
  });
  const data = status.data;
  const line = data && data.state !== "none" ? liveTileLine(data) : null;
  if (!data || !line) return null;
  const href = data.bot?.owner_url || data.bot?.url;
  const offerPlan = data.keep_on && (data.on_free_days || data.state === "ended");
  return (
    <div
      className="mx-2 mb-1 flex flex-col gap-1 rounded-lg border border-border/60 px-2.5 py-2 text-xs"
      data-testid="lite-live-bot"
    >
      <span className="text-[11px] font-medium text-muted-foreground">Live</span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="flex min-w-0 items-center gap-1.5 hover:underline"
          title={line}
        >
          <SendIcon className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{line}</span>
        </a>
      ) : (
        <span className="flex min-w-0 items-center gap-1.5" title={line}>
          <SendIcon className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{line}</span>
        </span>
      )}
      {offerPlan ? (
        <a
          href={data.keep_on!.checkout_url}
          target="_blank"
          rel="noreferrer"
          className="self-start font-medium text-primary hover:underline"
          data-testid="lite-live-bot-keep-on"
        >
          Keep it on
        </a>
      ) : null}
    </div>
  );
}
