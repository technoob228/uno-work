/**
 * "Uno" — the chat with Uno AI that works without a computer (28.09, Misha:
 * "the AI must be higher; in Uno Work, even without a computer, there is an
 * AI mode; a site the model makes shows up in the right panel").
 *
 * Grok-bot simple: one field, Uno asks one question at a time with tappable
 * answers, shows a plan, builds and publishes the site — it opens on the
 * right. When the goal needs a computer, Uno offers it in the conversation,
 * and once the computer exists the same conversation goes on there.
 * The chat runs on the server (unoAiApi.ts); the history is the console's /ask
 * history — one list.
 */
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUpIcon,
  CheckIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  GlobeIcon,
  InboxIcon,
  KeyRoundIcon,
  ListChecksIcon,
  LoaderIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PlusIcon,
  RotateCwIcon,
  SendIcon,
  SparklesIcon,
} from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { CONSOLE_URL, consoleLinks } from "../account/accountOverview";
import { formatAiMinutes } from "../account/aiHours";
import { isElectron } from "../env";
import { isWebLite } from "../lite/flag";
import { liteLinks, liteStanding } from "../lite/webLite";
import { computerOfferCheckoutHref, computerOfferCopy, workTrialOpenQuery } from "./computerOffer";
import { cn } from "../lib/utils";
import { SidebarShowButton } from "../components/sidebar/SidebarShowButton";
import { subscriptionQuery } from "../components/myuno/myUnoQueries";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import {
  accountErrorInfo,
  fetchAiMeter,
  newAiChatId,
  redeemComputerTrial,
  verifyAiEmail,
  type AiMeter,
  type AiStop,
} from "./unoAiApi";
import { isAssistantChat, rememberHandoff } from "./unoAiHandoff";
import { AnswerCards } from "./AnswerCards";
import { BotChatItem } from "./BotCard";
import { ContinueCards } from "./ContinueCards";
import { looksLikeBotToken } from "./freeBot";
import {
  chatTitle,
  latestBotKey,
  latestSite,
  liveActivity,
  pendingQuestion,
  transcriptItems,
  type AiItem,
} from "./unoAiModel";
import { unoAiKeys, useUnoAiChat } from "./useUnoAiChat";

/** Where AI spending is managed (the console, next to Billing). */
export const AI_USAGE_URL = `${CONSOLE_URL}/ai-usage`;
/** The AI time pack checkout (the console shows the plans when the pack is not on sale). */
const AI_PACK_URL = `${CONSOLE_URL}/billing?ai_pack=1`;

const STARTERS: ReadonlyArray<{ label: string; q: string }> = [
  {
    label: "A site for my business",
    q: "I want a website for my business where customers can book or contact me",
  },
  // The personal assistant (Misha 09.10, named 10.10): Uno on their own
  // computer that does their tasks — not a bot that answers other people. One
  // name, the same as the landing and the console ("Personal assistant"):
  // the builder answers it with "your own computer" (suggest_next computer).
  {
    label: "Personal assistant",
    q: "I want a personal assistant that does my tasks on its own computer: works on my projects, keeps going while my laptop is closed, and pings me only when it needs me.",
  },
  { label: "I have an idea for an app", q: "I have an idea for an app" },
];

export interface UnoAiSearch {
  readonly chat?: string;
  /** A first message to send right away (the console's "What do you want to make?"). */
  readonly q?: string;
}

/**
 * The route view. `renderContinueHere` — the full app passes a button that
 * moves the chat to the Uno on this computer (lite has no computer).
 */
export function UnoAiView({
  search,
  renderContinueHere,
}: {
  search: UnoAiSearch;
  renderContinueHere?: (chatId: string) => ReactNode;
}) {
  const navigate = useNavigate();
  // A new chat gets its id here; the URL learns it with the first message.
  const [fresh, setFresh] = useState(() => newAiChatId());
  const chatId = search.chat ?? fresh;

  const openChat = (id: string | null) => {
    if (id === null) setFresh(newAiChatId());
    void navigate({ to: "/ai", search: id ? { chat: id } : {}, replace: false });
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <UnoAiChat
        key={chatId}
        chatId={chatId}
        initialMessage={search.chat ? undefined : search.q}
        onFirstSend={() => {
          if (!search.chat) void navigate({ to: "/ai", search: { chat: chatId }, replace: true });
        }}
        onNewChat={() => openChat(null)}
        onOpenChat={(id) => openChat(id)}
        continueHere={renderContinueHere ? renderContinueHere(chatId) : null}
      />
    </SidebarInset>
  );
}

function UnoAiChat({
  chatId,
  initialMessage,
  onFirstSend,
  onNewChat,
  onOpenChat,
  continueHere,
}: {
  chatId: string;
  initialMessage: string | undefined;
  onFirstSend: () => void;
  onNewChat: () => void;
  /** Home's "Continue" opens a chat the person already started. */
  onOpenChat: (chatId: string) => void;
  continueHere: ReactNode;
}) {
  const { state, send, resume } = useUnoAiChat(chatId);
  const items = useMemo(() => transcriptItems(state.messages), [state.messages]);
  // A chat about a personal assistant: its pay button opens the checkout with Uno AI in the order.
  const assistantChat = useMemo(() => isAssistantChat(items), [items]);
  const question = state.running ? null : pendingQuestion(items);
  const site = latestSite(items, state.sites);
  const botKey = latestBotKey(items);
  const [draft, setDraft] = useState("");
  const [tokenHint, setTokenHint] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const lastSiteUrl = useRef<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sentInitial = useRef(false);
  const wide = useWide();

  const submit = async (text: string) => {
    const t = text.trim();
    if (!t || state.running) return;
    // A bot token never goes to the chat (Uno and the history would keep it).
    if (looksLikeBotToken(t)) {
      setDraft("");
      setTokenHint(true);
      return;
    }
    setTokenHint(false);
    setDraft("");
    if (state.messages.length === 0) onFirstSend();
    const failed = await send(t);
    if (failed) setDraft(failed);
  };

  // The console's first message (…/enter?q=): send it once, right away.
  useEffect(() => {
    if (!initialMessage || sentInitial.current) return;
    sentInitial.current = true;
    void submit(initialMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessage]);

  // A newly published site opens on the right (wide screens) — on a phone the
  // site card in the chat has "View".
  useEffect(() => {
    if (!site) return;
    if (lastSiteUrl.current === null) {
      lastSiteUrl.current = site.url;
      if (wide && state.loaded && !state.running) setPreviewOpen(true);
      return;
    }
    if (lastSiteUrl.current !== site.url || state.running === false) {
      if (lastSiteUrl.current !== site.url && wide) setPreviewOpen(true);
      lastSiteUrl.current = site.url;
      setPreviewKey((k) => k + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site?.url, state.messages.length]);

  // Keep the newest message in view.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [state.messages.length, state.live?.text, state.stop, question]);

  const empty = state.loaded && state.messages.length === 0 && !state.running;

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2 sm:px-5">
          <SidebarShowButton />
          <SparklesIcon className="size-4 text-muted-foreground" />
          <span className="min-w-0 truncate text-sm font-medium" data-testid="uno-ai-title">
            {empty || !state.title ? "Uno" : chatTitle(state.title)}
          </span>
          <div className="ml-auto flex items-center gap-1">
            {continueHere}
            {site ? (
              <Button
                size="xs"
                variant={previewOpen ? "secondary" : "ghost"}
                onClick={() => setPreviewOpen((v) => !v)}
                data-testid="uno-ai-preview-toggle"
              >
                {previewOpen ? <PanelRightCloseIcon /> : <PanelRightOpenIcon />}
                <span className="hidden sm:inline">Site</span>
              </Button>
            ) : null}
            <Button size="xs" variant="ghost" onClick={onNewChat} data-testid="uno-ai-new-chat">
              <PlusIcon />
              <span className="hidden sm:inline">New chat</span>
            </Button>
          </div>
        </header>

        <div ref={logRef} className="min-h-0 flex-1 overflow-y-auto" data-testid="uno-ai-log">
          {!state.loaded ? (
            <div className="flex h-full items-center justify-center">
              <LoaderIcon className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : empty ? (
            <EmptyChat
              onPick={(q) => void submit(q)}
              onOpenChat={onOpenChat}
              draft={draft}
              setDraft={setDraft}
            />
          ) : (
            <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pt-6 pb-8">
              {items.map((item) => (
                <ChatItem
                  key={item.key}
                  item={item}
                  interactiveBot={item.key === botKey}
                  chatId={chatId}
                  assistantChat={assistantChat}
                  onView={() => {
                    setPreviewOpen(true);
                    setPreviewKey((k) => k + 1);
                  }}
                  onOpenSite={(href) => {
                    if (!site || !isSameSite(href, site.url)) return false;
                    setPreviewOpen(true);
                    setPreviewKey((k) => k + 1);
                    return true;
                  }}
                  continueHere={continueHere}
                />
              ))}
              {state.running ? <LiveLine live={state.live} /> : null}
              {question ? (
                <AnswerCards
                  question={question}
                  onAnswer={(a) => void submit(a)}
                  onOwnWords={() => inputRef.current?.focus()}
                />
              ) : null}
              {!state.running && state.stop ? (
                <StopCard stop={state.stop} onResume={() => void resume()} />
              ) : null}
              {tokenHint ? (
                <p
                  className="text-sm text-muted-foreground"
                  role="alert"
                  data-testid="uno-ai-token-hint"
                >
                  {botKey
                    ? "That looks like your bot's token — paste it on the bot card above. It wasn't sent to the chat."
                    : "That looks like a bot token — it wasn't sent to the chat."}
                </p>
              ) : null}
              {state.sendError ? (
                <p className="text-sm text-destructive" role="alert">
                  {state.sendError}
                </p>
              ) : null}
            </div>
          )}
        </div>

        {empty ? null : (
          <Composer
            draft={draft}
            setDraft={setDraft}
            busy={state.running}
            onSend={() => void submit(draft)}
            placeholder={question ? "Reply to Uno…" : "Message Uno…"}
            inputRef={inputRef}
            manage={consoleManageLink(site, botKey !== null)}
          />
        )}
      </div>

      {site && previewOpen ? (
        <SitePreview
          url={site.url}
          title={site.title ?? site.slug}
          slug={site.slug}
          reloadKey={previewKey}
          overlay={!wide}
          onClose={() => setPreviewOpen(false)}
          onReload={() => setPreviewKey((k) => k + 1)}
        />
      ) : null}
    </div>
  );
}

function useWide(): boolean {
  const query = "(min-width: 1024px)";
  const [wide, setWide] = useState(() =>
    typeof window === "undefined" ? true : window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

// ---- empty chat: one field ----

function EmptyChat({
  onPick,
  onOpenChat,
  draft,
  setDraft,
}: {
  onPick: (q: string) => void;
  onOpenChat: (chatId: string) => void;
  draft: string;
  setDraft: (v: string) => void;
}) {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center gap-6 px-4 py-10">
      {/* What they already started comes first (icp3 09.10, n1/12). */}
      <ContinueCards onOpenChat={onOpenChat} />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          What do you want to make?
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Uno asks a few quick questions, then builds it and puts it online. No computer needed.
        </p>
      </div>
      <Composer
        draft={draft}
        setDraft={setDraft}
        busy={false}
        onSend={() => onPick(draft)}
        placeholder="A site for my yoga studio with online booking…"
        big
      />
      <div className="flex flex-wrap gap-2">
        {STARTERS.map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => onPick(s.q)}
            className="rounded-full border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            data-testid="uno-ai-starter"
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---- composer + AI meter ----

function Composer({
  draft,
  setDraft,
  busy,
  onSend,
  placeholder,
  big = false,
  manage,
  inputRef,
}: {
  draft: string;
  setDraft: (v: string) => void;
  busy: boolean;
  onSend: () => void;
  placeholder: string;
  big?: boolean;
  /** Where "Manage in console" leads from this chat (default: Uno AI). */
  manage?: ConsoleManageLink;
  /** The message box, for "Or answer in your own words". */
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? ownRef;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [draft, ref]);
  return (
    <div className={cn(big ? "" : "border-t border-border bg-background px-3 pt-2 pb-3 sm:px-5")}>
      <div className={cn("mx-auto w-full", big ? "" : "max-w-2xl")}>
        <form
          className="flex items-end gap-2 rounded-2xl border border-border bg-card px-3 py-2 shadow-xs focus-within:border-foreground/30"
          onSubmit={(e) => {
            e.preventDefault();
            onSend();
          }}
        >
          <textarea
            ref={ref}
            value={draft}
            rows={big ? 2 : 1}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                onSend();
              }
            }}
            placeholder={placeholder}
            aria-label="Message Uno"
            data-testid="uno-ai-input"
            className="max-h-56 min-h-9 flex-1 resize-none bg-transparent py-1.5 text-base outline-none placeholder:text-muted-foreground sm:text-sm"
          />
          <Button
            type="submit"
            size="icon-sm"
            disabled={busy || !draft.trim()}
            aria-label="Send"
            data-testid="uno-ai-send"
          >
            {busy ? <LoaderIcon className="animate-spin" /> : <ArrowUpIcon />}
          </Button>
        </form>
        <MeterChip manage={manage} />
      </div>
    </div>
  );
}

export interface ConsoleManageLink {
  readonly href: string;
  readonly label: string;
}

/**
 * "Manage in console" from a chat goes where this chat's things live
 * (flows v2 C6, [entry-landing-site/22] [onboard-bot/16]): the site's page
 * when the chat made a site, Home (the bot's card) for a bot, else Uno AI.
 * Always a new tab (the console and Work open each other in new tabs).
 */
export function consoleManageLink(
  site: { readonly slug: string } | null,
  hasBot: boolean,
): ConsoleManageLink {
  if (site?.slug) return { href: consoleLinks.site(site.slug), label: "Manage site in console" };
  if (hasBot) return { href: `${CONSOLE_URL}/`, label: "Manage in console" };
  return { href: AI_USAGE_URL, label: "Manage in console" };
}

/** "Free Uno AI · 52 min left" → Manage in console. Spending itself lives in the console. */
export function meterLine(m: AiMeter | undefined): string | null {
  if (!m) return null;
  const premium =
    m.premium && m.premium.monthly_usd > 0 && m.premium.left_usd >= 0.01
      ? ` · Premium $${m.premium.left_usd.toFixed(m.premium.left_usd < 10 ? 2 : 0)} left`
      : "";
  if (m.mode === "hours" && m.hours) {
    return `${m.hours.unlimited ? "Uno AI · unlimited" : `Uno AI · ${formatAiMinutes(m.hours.minutes_left)} left`}${premium}`;
  }
  if (m.mode === "free" && m.free) {
    return `Free Uno AI · ${formatAiMinutes(m.free.minutes_left)} left${premium}`;
  }
  if (m.balance_usd >= 0.01) return `Balance · $${m.balance_usd.toFixed(2)}${premium}`;
  return premium ? premium.slice(3) : null;
}

function MeterChip({ manage }: { manage?: ConsoleManageLink | undefined }) {
  const meter = useQuery({
    queryKey: unoAiKeys.meter,
    queryFn: fetchAiMeter,
    staleTime: 30_000,
    retry: false,
  });
  const line = meterLine(meter.data);
  // In a chat the way to its things stays even without a meter line.
  if (!line && !manage) return null;
  return (
    // Wraps on a phone: a long meter line plus the link used to run past the edge at 390.
    <div className="mt-1.5 flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-center text-[11px] text-muted-foreground">
      {line ? (
        <>
          <span data-testid="uno-ai-meter">{line}</span>
          <span aria-hidden>·</span>
        </>
      ) : null}
      <a
        href={manage?.href ?? AI_USAGE_URL}
        target="_blank"
        rel="noreferrer"
        className="underline-offset-2 hover:text-foreground hover:underline"
        data-testid="uno-ai-manage"
      >
        {manage?.label ?? "Manage in console"}
      </a>
    </div>
  );
}

// ---- the transcript ----

/** Same host, any path: a link to this chat's site. */
export function isSameSite(href: string | undefined, siteUrl: string | undefined): boolean {
  if (!href || !siteUrl) return false;
  try {
    return new URL(href).host.toLowerCase() === new URL(siteUrl).host.toLowerCase();
  } catch {
    return false;
  }
}

function Markdown({ text, onOpenSite }: { text: string; onOpenSite?: (href: string) => boolean }) {
  return (
    <div className="prose-sm max-w-none text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_li]:ml-4 [&_ol]:list-decimal [&_p+p]:mt-2 [&_ul]:list-disc">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // The chat's own site opens on the right at once (rule 07.10);
          // the console and the rest of the web — a new tab.
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                if (
                  !href ||
                  !onOpenSite ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey ||
                  event.button !== 0
                ) {
                  return;
                }
                if (onOpenSite(href)) event.preventDefault();
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function ChatItem({
  item,
  interactiveBot,
  chatId,
  assistantChat,
  onView,
  onOpenSite,
  continueHere,
}: {
  item: AiItem;
  interactiveBot: boolean;
  chatId: string;
  /** The chat is about a personal assistant (isAssistantChat). */
  assistantChat: boolean;
  onView: () => void;
  /** A link in the text points at this chat's site: open it on the right; false = not ours. */
  onOpenSite: (href: string) => boolean;
  continueHere: ReactNode;
}) {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl bg-muted px-3.5 py-2 text-sm whitespace-pre-wrap">
            {item.text}
          </div>
        </div>
      );
    case "text":
      return <Markdown text={item.text} onOpenSite={onOpenSite} />;
    case "ask":
      return (
        <div className="text-sm font-semibold" data-testid="uno-ai-question">
          {item.questions.map((q) => (
            <p key={q.question}>{q.question}</p>
          ))}
        </div>
      );
    case "plan":
      return (
        <div className="rounded-xl border border-border bg-card/60 p-3.5" data-testid="uno-ai-plan">
          <div className="mb-1.5 flex items-center gap-2 text-sm font-semibold">
            <ListChecksIcon className="size-4 text-muted-foreground" />
            {item.title}
          </div>
          <ol className="ml-5 list-decimal space-y-0.5 text-sm text-muted-foreground">
            {item.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </div>
      );
    case "building":
      return (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <CheckIcon className="size-3.5" />
          Wrote the site
          {item.chars > 0 ? ` · ${Math.round(item.chars / 100) / 10}k characters` : ""}
        </p>
      );
    case "site":
      return (
        <div
          className="flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3"
          data-testid="uno-ai-site"
        >
          <GlobeIcon className="size-5 shrink-0 text-emerald-600" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{item.title ?? "Your site"} is live</div>
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="block truncate text-xs text-muted-foreground hover:underline"
            >
              {item.url.replace(/^https:\/\//, "").replace(/\/$/, "")}
            </a>
          </div>
          {item.slug ? (
            <Button
              size="xs"
              variant="ghost"
              data-testid="uno-ai-site-entries"
              title="Form entries from this site, in the console"
              render={
                <a href={consoleLinks.siteEntries(item.slug)} target="_blank" rel="noreferrer" />
              }
            >
              <InboxIcon />
              Entries
            </Button>
          ) : null}
          <Button size="xs" variant="outline" onClick={onView}>
            View
          </Button>
        </div>
      );
    case "password":
      return (
        <div className="flex items-center gap-2 rounded-xl border border-border p-3 text-sm">
          <KeyRoundIcon className="size-4 text-muted-foreground" />
          {item.password ? (
            <span>
              Password set:{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 select-all">{item.password}</code>
            </span>
          ) : (
            <span>Password removed</span>
          )}
        </div>
      );
    case "telegram":
      return (
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 self-start rounded-xl border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-sm font-medium hover:bg-sky-500/10"
        >
          <SendIcon className="size-4 text-sky-600" />
          Get requests in Telegram — tap, then Start
        </a>
      );
    case "suggest":
      return (
        <SuggestCard
          action={item.action}
          reason={item.reason}
          chatId={chatId}
          assistant={assistantChat}
          continueHere={continueHere}
        />
      );
    case "bot":
      return <BotChatItem item={item} interactive={interactiveBot} />;
  }
}

function LiveLine({ live }: { live: { text: string; tool: string; chars: number } | null }) {
  const activity = live ? liveActivity(live.tool, live.chars) : null;
  return (
    <div className="flex flex-col gap-2" data-testid="uno-ai-live">
      {live?.text ? <Markdown text={live.text} /> : null}
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-flex gap-1">
          <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground/70" />
          <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground/70 [animation-delay:150ms]" />
          <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground/70 [animation-delay:300ms]" />
        </span>
        {activity ?? (live?.text ? "" : "Uno is thinking…")}
      </p>
    </div>
  );
}

// ---- when the turn stopped ----

/** "Continue" when Uno stopped mid-way and resumes from there; "Try again" for a hiccup. */
export function stopResumeLabel(code: string): "Continue" | "Try again" {
  return code === "steps" ? "Continue" : "Try again";
}

/** The server's words; for "steps" they name the button, so they follow its label. */
export function stopMessage(stop: Pick<AiStop, "code" | "message">): string {
  return stop.code === "steps"
    ? stop.message.replace(/\bTap Try again\b/, "Tap Continue")
    : stop.message;
}

function StopCard({ stop, onResume }: { stop: AiStop; onResume: () => void }) {
  if (stop.code === "verify") return <VerifyCard onVerified={onResume} />;
  const out = stop.code === "free_empty" || stop.code === "hours_empty";
  // The plan's AI time is used up: straight to the pack checkout (flows v2,
  // "any payment → the checkout"), not to the Uno AI page to figure it out.
  const pack = stop.code === "hours_empty";
  return (
    <div
      className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3.5 text-sm"
      data-testid="uno-ai-stop"
    >
      <p>{stopMessage(stop)}</p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {out ? (
          <Button
            size="sm"
            data-testid={pack ? "uno-ai-stop-pack" : undefined}
            render={<a href={pack ? AI_PACK_URL : AI_USAGE_URL} target="_blank" rel="noreferrer" />}
          >
            {pack ? "Add AI time" : "Get more Uno AI"}
            <ExternalLinkIcon />
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={onResume} data-testid="uno-ai-stop-resume">
            {/* "steps": Uno ran out of steps mid-way — it picks up where it stopped,
                so the button says what happens (flows v2, builder). */}
            {stop.code === "steps" ? <ArrowRightIcon /> : <RotateCwIcon />}
            {stopResumeLabel(stop.code)}
          </Button>
        )}
      </div>
    </div>
  );
}

function VerifyCard({ onVerified }: { onVerified: () => void }) {
  const [step, setStep] = useState<"start" | "code">("start");
  const [email, setEmail] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const sendCode = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await verifyAiEmail();
      if (r.verified) return onVerified();
      setEmail(r.email ?? null);
      setStep("code");
    } catch (e) {
      const info = accountErrorInfo(e);
      setErr(
        info.code === "RATE_LIMIT"
          ? "Too many codes — wait a bit and try again."
          : info.detail || "Could not send the code.",
      );
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (code.trim().length < 4) return setErr("Enter the code from the email.");
    setBusy(true);
    setErr(null);
    try {
      await verifyAiEmail(code.trim());
      onVerified();
    } catch (e) {
      const info = accountErrorInfo(e);
      setErr(
        info.code === "INVALID_CODE"
          ? "That code didn't work. Check the email and try again."
          : info.detail || "Could not confirm.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="rounded-xl border border-border bg-card/60 p-3.5 text-sm"
      data-testid="uno-ai-verify"
    >
      <p className="font-medium">Confirm your email to keep going</p>
      <p className="mt-0.5 text-muted-foreground">
        It keeps free Uno AI for real people. One code, one minute — then Uno goes on.
      </p>
      {step === "start" ? (
        <Button size="sm" className="mt-2.5" onClick={() => void sendCode()} disabled={busy}>
          {busy ? <LoaderIcon className="animate-spin" /> : null}
          Send me a code
        </Button>
      ) : (
        <form
          className="mt-2.5 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void confirm();
          }}
        >
          <span className="w-full text-xs text-muted-foreground">
            Sent to {email ?? "your email"}.
          </span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6-digit code"
            className="h-8 w-36 rounded-md border border-border bg-background px-2 text-sm"
            data-testid="uno-ai-verify-code"
          />
          <Button size="sm" type="submit" disabled={busy}>
            Confirm
          </Button>
        </form>
      )}
      {err ? <p className="mt-2 text-xs text-destructive">{err}</p> : null}
    </div>
  );
}

// ---- "this needs a computer" ----

function SuggestCard({
  action,
  reason,
  chatId,
  assistant,
  continueHere,
}: {
  action: "computer" | "connect_agent" | "uno_work";
  reason: string;
  chatId: string;
  assistant: boolean;
  continueHere: ReactNode;
}) {
  if (action === "connect_agent") {
    return (
      <OfferFrame reason={reason} title="Connect the AI you already use">
        <Button
          size="sm"
          render={<a href={`${CONSOLE_URL}/start?path=agent`} target="_blank" rel="noreferrer" />}
        >
          Connect Claude Code, Cursor or Codex
          <ExternalLinkIcon />
        </Button>
      </OfferFrame>
    );
  }
  // The full app already runs on a computer: go on here.
  if (!isWebLite) {
    return (
      <OfferFrame reason={reason} title="Continue on your computer">
        {continueHere ?? (
          <p className="text-xs text-muted-foreground">
            Open Uno Work on your computer to continue.
          </p>
        )}
      </OfferFrame>
    );
  }
  return <ComputerOffer reason={reason} chatId={chatId} assistant={assistant} />;
}

function OfferFrame({
  reason,
  title,
  children,
}: {
  reason: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      className="rounded-xl border border-primary/30 bg-primary/5 p-3.5"
      data-testid="uno-ai-offer"
    >
      <p className="text-sm font-semibold">{title}</p>
      {reason ? <p className="mt-0.5 text-sm text-muted-foreground">{reason}</p> : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/** Lite: create the computer (plan allows), or start the free trial (no code) / pick a plan. */
function ComputerOffer({
  reason,
  chatId,
  assistant,
}: {
  reason: string;
  chatId: string;
  assistant: boolean;
}) {
  const subscription = useQuery(subscriptionQuery());
  const standing = subscription.isPending ? null : liteStanding(subscription.data ?? null);
  // Like the console: the trial button only when there is a free place.
  const trialOpen = useQuery(workTrialOpenQuery()).data === true;
  const [codeOpen, setCodeOpen] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const create = () => {
    rememberHandoff(chatId);
    window.location.assign("/?computer=create");
  };
  // The free trial needs no code (WORK_TRIAL=all, 02.10); a code still works
  // for the promo trials, one quiet link away.
  const redeem = async (withCode: string) => {
    setBusy(true);
    setErr(null);
    try {
      await redeemComputerTrial(withCode);
      create();
    } catch (e) {
      const info = accountErrorInfo(e);
      if (!withCode && info.code === "CODE_REQUIRED") setCodeOpen(true);
      setErr(info.detail || (withCode ? "That code didn't work." : "Couldn't start the trial."));
      setBusy(false);
    }
  };

  const copy = computerOfferCopy(standing, trialOpen);

  return (
    <OfferFrame reason={reason} title={copy.title}>
      {standing === "cloud" ? (
        <Button size="sm" onClick={create} data-testid="uno-ai-create-computer">
          Create my computer
        </Button>
      ) : (
        <>
          {codeOpen ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (code.trim()) void redeem(code.trim());
              }}
            >
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Trial code"
                className="h-8 w-40 rounded-md border border-border bg-background px-2 text-sm"
                data-testid="uno-ai-trial-code"
                autoFocus
              />
              <Button size="sm" type="submit" disabled={busy || !code.trim()}>
                {busy ? <LoaderIcon className="animate-spin" /> : null}
                Start free trial
              </Button>
            </form>
          ) : copy.trial && (standing === "free" || standing === null) ? (
            <Button
              size="sm"
              onClick={() => void redeem("")}
              disabled={busy}
              data-testid="uno-ai-start-trial"
            >
              {busy ? <LoaderIcon className="animate-spin" /> : null}
              Start free — 3 days
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            // Paying happens in the console (a new tab). "Open Uno Work" there
            // creates the computer too, so the conversation is remembered now —
            // the note below promises it continues on the computer.
            onClick={() => rememberHandoff(chatId)}
            render={
              <a href={computerOfferCheckoutHref(assistant)} target="_blank" rel="noreferrer" />
            }
          >
            {copy.upgradeLabel}
            <ExternalLinkIcon />
          </Button>
          {copy.ownAgent ? (
            <Button
              size="sm"
              variant="ghost"
              data-testid="uno-ai-own-agent"
              render={<a href={liteLinks.connectAi} target="_blank" rel="noreferrer" />}
            >
              Use my own agent
              <ExternalLinkIcon />
            </Button>
          ) : null}
        </>
      )}
      <p className="w-full text-xs text-muted-foreground">
        {copy.note ??
          "When it's ready, this conversation continues there — Uno on your computer gets everything from here."}
        {copy.trial && !codeOpen ? (
          <>
            {" "}
            <button
              type="button"
              onClick={() => setCodeOpen(true)}
              className="cursor-pointer underline underline-offset-2 hover:text-foreground"
              data-testid="uno-ai-have-code"
            >
              I have a trial code
            </button>
          </>
        ) : null}
      </p>
      {err ? <p className="w-full text-xs text-destructive">{err}</p> : null}
    </OfferFrame>
  );
}

// ---- the site on the right ----

function SitePreview({
  url,
  title,
  reloadKey,
  overlay,
  onClose,
  onReload,
  slug,
}: {
  url: string;
  title: string;
  reloadKey: number;
  overlay: boolean;
  onClose: () => void;
  onReload: () => void;
  /** The site's slug: "Entries" opens its form entries in the console. */
  slug: string;
}) {
  return (
    <aside
      className={cn(
        "flex min-h-0 flex-col border-l border-border bg-background",
        overlay ? "fixed inset-0 z-50" : "w-[46%] max-w-[900px] min-w-[380px]",
      )}
      data-testid="uno-ai-preview"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <GlobeIcon className="size-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        {slug ? (
          <Button
            size="xs"
            variant="ghost"
            data-testid="uno-ai-preview-entries"
            title="Form entries from this site, in the console"
            render={<a href={consoleLinks.siteEntries(slug)} target="_blank" rel="noreferrer" />}
          >
            <InboxIcon />
            Entries
          </Button>
        ) : null}
        <Button size="icon-xs" variant="ghost" onClick={onReload} aria-label="Reload">
          <RotateCwIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Open in a new tab"
          render={<a href={url} target="_blank" rel="noreferrer" />}
        >
          <ExternalLinkIcon />
        </Button>
        <Button size="icon-xs" variant="ghost" onClick={onClose} aria-label="Close">
          <PanelRightCloseIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 bg-white">
        {isElectron ? (
          <webview
            key={`${url}#${reloadKey}`}
            src={url}
            partition="persist:uno-apps"
            className="h-full w-full"
            style={{ display: "flex" }}
          />
        ) : (
          <iframe
            key={`${url}#${reloadKey}`}
            src={url}
            title={title}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals"
            referrerPolicy="strict-origin-when-cross-origin"
            className="h-full w-full border-0"
          />
        )}
      </div>
    </aside>
  );
}
