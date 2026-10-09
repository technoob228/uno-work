/**
 * Uno AI's Home: what the person already started, above "What do you want to
 * make?" (icp3 09.10, n1/12: she went to @BotFather, came back to Home — and
 * Home offered to start over; the console's Home said "Continue: Bean & Bun
 * bot"). The same data the console reads: the free bot's status
 * (GET /api/v1/free-bot) and the chats it came from (GET /api/v1/account/resume,
 * console lib/overview/resume.ts). At most two cards — the bot, then the site —
 * each with one next step. Pure and unit-tested; the cards are ContinueCards.tsx.
 */
import type { ResumeSite } from "../account/accountOverview";
import { freeBotEmailNote, liveMetaLine, keepOnLabel, type FreeBotStatus } from "./freeBot";

/** A site chat older than this is history, not "something started" (console RESUME_CHAT_DAYS). */
export const CONTINUE_SITE_DAYS = 14;

export type ContinueAction =
  | { readonly label: string; readonly chat: string }
  | { readonly label: string; readonly href: string };

export interface ContinueCard {
  readonly key: "bot" | "site";
  readonly icon: "bot" | "starting" | "live" | "site";
  readonly title: string;
  readonly line: string;
  readonly primary: ContinueAction | null;
  readonly secondary?: ContinueAction;
}

export interface ContinueInput {
  readonly now: number;
  readonly freeBot: FreeBotStatus | null | undefined;
  readonly resume:
    | {
        readonly botChatId: string | null;
        readonly lastChatId: string | null;
        readonly site: ResumeSite | null;
      }
    | null
    | undefined;
  /** Slugs of the account's sites right now — a deleted site is not "continue". */
  readonly liveSiteSlugs: ReadonlySet<string> | null;
  /** A live plan: the free bot's email rule doesn't apply. */
  readonly hasPlan: boolean;
}

/** "Bean & Bun" → "Bean & Bun bot"; "Pizza bot" stays (console botTitle). */
export function botTitle(name: unknown): string {
  const n = typeof name === "string" ? name.trim() : "";
  if (!n) return "your bot";
  return /\bbot\b/i.test(n) ? n : `${n} bot`;
}

function botCard(i: ContinueInput): ContinueCard | null {
  const fb = i.freeBot;
  if (!fb) return null;
  const chatId = i.resume?.botChatId ?? null;
  const toChat = (label: string): ContinueAction | null =>
    chatId ? { label, chat: chatId } : null;
  const username = fb.bot?.username?.replace(/^@+/, "") || null;
  const name = botTitle(fb.spec?.["name"]);
  switch (fb.state) {
    case "draft":
    case "failed": {
      const email = i.hasPlan ? null : freeBotEmailNote(fb.reason);
      const days = !i.hasPlan && fb.enabled && fb.days > 0 ? fb.days : 0;
      const line =
        email ??
        (fb.state === "failed"
          ? "It didn't start. Paste the token from @BotFather again — Uno checks it."
          : `One step left: create the bot in @BotFather and paste its token. It starts answering in a minute${
              days ? ` and runs free for ${days} ${days === 1 ? "day" : "days"}` : ""
            }.`);
      return {
        key: "bot",
        icon: "bot",
        title: `Continue: ${name}`,
        line,
        primary: toChat("Continue"),
      };
    }
    case "starting":
      return {
        key: "bot",
        icon: "starting",
        title: username ? `Starting @${username}…` : `Starting ${name}…`,
        line: "Usually under a minute.",
        primary: toChat("Open the chat"),
      };
    case "live": {
      const href = fb.bot?.owner_url || fb.bot?.url || "";
      const open: ContinueAction | null = /^https:\/\//i.test(href)
        ? { label: "Open in Telegram", href }
        : null;
      const change = toChat("Change it with Uno");
      return {
        key: "bot",
        icon: "live",
        title: username ? `@${username} is live` : `${name} is live`,
        line: liveMetaLine(fb),
        primary: open ?? change,
        ...(open && change ? { secondary: change } : {}),
      };
    }
    case "ended": {
      const checkout = fb.keep_on?.checkout_url;
      return {
        key: "bot",
        icon: "bot",
        title: username ? `@${username} is asleep` : `${name} is asleep`,
        line: "Its free days are over. Keep it on and it answers again in a minute.",
        primary: checkout ? { label: keepOnLabel(fb.keep_on), href: checkout } : null,
      };
    }
    default:
      return null;
  }
}

function siteCard(i: ContinueInput): ContinueCard | null {
  const site = i.resume?.site;
  if (!site || !i.liveSiteSlugs?.has(site.slug)) return null;
  const at = site.updatedAt ? Date.parse(site.updatedAt) : Number.NaN;
  if (!Number.isFinite(at) || i.now - at > CONTINUE_SITE_DAYS * 86_400_000) return null;
  return {
    key: "site",
    icon: "site",
    title: `Continue: ${site.title || site.slug}`,
    line: "Change it with Uno — or add the next thing: bookings, requests in Telegram, a bot that answers customers.",
    primary: { label: "Continue", chat: site.chatId },
    secondary: { label: "View site", href: site.url },
  };
}

/** The bot first (it waits for the person), then the site. Empty — nothing started. */
export function continueCards(i: ContinueInput): ReadonlyArray<ContinueCard> {
  return [botCard(i), siteCard(i)].filter((c): c is ContinueCard => c !== null);
}
