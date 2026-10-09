/**
 * Uno AI's Home: "Continue" cards above "What do you want to make?" — the
 * free bot waiting for its token (or live), the site Uno made. Rules in
 * homeContinue.ts; nothing started — nothing here.
 */
import { useQuery } from "@tanstack/react-query";
import { BotIcon, ExternalLinkIcon, GlobeIcon, LoaderIcon, SendIcon } from "lucide-react";
import { useMemo } from "react";

import {
  accountResumeQuery,
  sitesQuery,
  subscriptionQuery,
} from "../components/myuno/myUnoQueries";
import { Button } from "../components/ui/button";
import { liteStanding } from "../lite/webLite";
import { fetchFreeBot, freeBotKey, freeBotPollMs } from "./freeBot";
import { continueCards, type ContinueAction, type ContinueCard } from "./homeContinue";
import { unoAiAvailable } from "./unoAiApi";

export function ContinueCards({ onOpenChat }: { onOpenChat: (chatId: string) => void }) {
  const freeBot = useQuery({
    queryKey: freeBotKey,
    queryFn: fetchFreeBot,
    enabled: unoAiAvailable(),
    staleTime: 10_000,
    retry: false,
    // Only a starting bot changes by itself while Home is open.
    refetchInterval: (query) =>
      query.state.data?.state === "starting" ? freeBotPollMs("starting") : false,
  });
  const resume = useQuery(accountResumeQuery());
  const sites = useQuery(sitesQuery());
  const subscription = useQuery(subscriptionQuery());

  const cards = useMemo(
    () =>
      continueCards({
        now: Date.now(),
        freeBot: freeBot.data,
        resume: resume.data,
        liveSiteSlugs: sites.data ? new Set(sites.data.sites.map((s) => s.slug)) : null,
        hasPlan: !subscription.isPending && liteStanding(subscription.data ?? null) !== "free",
      }),
    [freeBot.data, resume.data, sites.data, subscription.data, subscription.isPending],
  );
  if (cards.length === 0) return null;
  return (
    <div className="flex flex-col gap-2.5" data-testid="uno-ai-continue">
      {cards.map((card) => (
        <Card key={card.key} card={card} onOpenChat={onOpenChat} />
      ))}
    </div>
  );
}

function Card({ card, onOpenChat }: { card: ContinueCard; onOpenChat: (chatId: string) => void }) {
  const Icon =
    card.icon === "starting"
      ? LoaderIcon
      : card.icon === "live"
        ? SendIcon
        : card.icon === "site"
          ? GlobeIcon
          : BotIcon;
  return (
    <div
      className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 sm:flex-row sm:items-center"
      data-testid={`uno-ai-continue-${card.key}`}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
          <Icon className={card.icon === "starting" ? "size-4 animate-spin" : "size-4"} />
        </span>
        <div className="min-w-0">
          <p className="text-base font-semibold text-foreground">{card.title}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">{card.line}</p>
        </div>
      </div>
      {card.primary || card.secondary ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 ps-11 sm:ps-0">
          {card.secondary ? (
            <Act act={card.secondary} variant="ghost" onOpenChat={onOpenChat} />
          ) : null}
          {card.primary ? (
            <Act act={card.primary} variant="default" onOpenChat={onOpenChat} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Act({
  act,
  variant,
  onOpenChat,
}: {
  act: ContinueAction;
  variant: "default" | "ghost";
  onOpenChat: (chatId: string) => void;
}) {
  if ("chat" in act) {
    return (
      <Button
        size="sm"
        variant={variant}
        onClick={() => onOpenChat(act.chat)}
        data-testid="uno-ai-continue-open"
      >
        {act.label}
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      variant={variant}
      render={<a href={act.href} target="_blank" rel="noreferrer" />}
    >
      {act.label}
      <ExternalLinkIcon />
    </Button>
  );
}
