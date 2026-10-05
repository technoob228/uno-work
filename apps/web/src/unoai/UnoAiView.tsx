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
  ExternalLinkIcon,
  GlobeIcon,
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
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { CONSOLE_URL, checkoutHref } from "../account/accountOverview";
import { formatAiMinutes } from "../account/aiHours";
import { isElectron } from "../env";
import { isWebLite } from "../lite/flag";
import { liteStanding } from "../lite/webLite";
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
import { rememberHandoff } from "./unoAiHandoff";
import {
  chatLanguage,
  chatTitle,
  latestSite,
  liveActivity,
  pendingQuestion,
  standardAnswers,
  transcriptItems,
  type AiItem,
  type AiQuestion,
} from "./unoAiModel";
import { unoAiKeys, useUnoAiChat } from "./useUnoAiChat";

/** Where AI spending is managed (the console, next to Billing). */
export const AI_USAGE_URL = `${CONSOLE_URL}/ai-usage`;

const STARTERS: ReadonlyArray<{ label: string; q: string }> = [
  {
    label: "A site for my business",
    q: "I want a website for my business where customers can book or contact me",
  },
  { label: "A Telegram bot", q: "I want a Telegram bot" },
  {
    label: "An AI assistant for my work",
    q: "I want an AI assistant that helps me run my business",
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
  continueHere,
}: {
  chatId: string;
  initialMessage: string | undefined;
  onFirstSend: () => void;
  onNewChat: () => void;
  continueHere: ReactNode;
}) {
  const { state, send, resume } = useUnoAiChat(chatId);
  const items = useMemo(() => transcriptItems(state.messages), [state.messages]);
  const question = state.running ? null : pendingQuestion(items);
  const site = latestSite(items, state.sites);
  const [draft, setDraft] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const lastSiteUrl = useRef<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const sentInitial = useRef(false);
  const wide = useWide();

  const submit = async (text: string) => {
    const t = text.trim();
    if (!t || state.running) return;
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
            <EmptyChat onPick={(q) => void submit(q)} draft={draft} setDraft={setDraft} />
          ) : (
            <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pt-6 pb-8">
              {items.map((item) => (
                <ChatItem
                  key={item.key}
                  item={item}
                  chatId={chatId}
                  onView={() => {
                    setPreviewOpen(true);
                    setPreviewKey((k) => k + 1);
                  }}
                  continueHere={continueHere}
                />
              ))}
              {state.running ? <LiveLine live={state.live} /> : null}
              {question ? (
                <QuestionAnswers question={question} onAnswer={(a) => void submit(a)} />
              ) : null}
              {!state.running && state.stop ? (
                <StopCard stop={state.stop} onResume={() => void resume()} />
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
            placeholder={question ? "Or type your own answer…" : "Message Uno…"}
          />
        )}
      </div>

      {site && previewOpen ? (
        <SitePreview
          url={site.url}
          title={site.title ?? site.slug}
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
  draft,
  setDraft,
}: {
  onPick: (q: string) => void;
  draft: string;
  setDraft: (v: string) => void;
}) {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center gap-6 px-4 py-10">
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
}: {
  draft: string;
  setDraft: (v: string) => void;
  busy: boolean;
  onSend: () => void;
  placeholder: string;
  big?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [draft]);
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
        <MeterChip />
      </div>
    </div>
  );
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

function MeterChip() {
  const meter = useQuery({
    queryKey: unoAiKeys.meter,
    queryFn: fetchAiMeter,
    staleTime: 30_000,
    retry: false,
  });
  const line = meterLine(meter.data);
  if (!line) return null;
  return (
    <div className="mt-1.5 flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
      <span data-testid="uno-ai-meter">{line}</span>
      <span aria-hidden>·</span>
      <a
        href={AI_USAGE_URL}
        target="_blank"
        rel="noreferrer"
        className="underline-offset-2 hover:text-foreground hover:underline"
        data-testid="uno-ai-manage"
      >
        Manage in console
      </a>
    </div>
  );
}

// ---- the transcript ----

function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-sm max-w-none text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_li]:ml-4 [&_ol]:list-decimal [&_p+p]:mt-2 [&_ul]:list-disc">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
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
  chatId,
  onView,
  continueHere,
}: {
  item: AiItem;
  chatId: string;
  onView: () => void;
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
      return <Markdown text={item.text} />;
    case "ask":
      return (
        <div className="text-sm font-medium" data-testid="uno-ai-question">
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
          continueHere={continueHere}
        />
      );
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

function QuestionAnswers({
  question,
  onAnswer,
}: {
  question: AiQuestion;
  onAnswer: (answer: string) => void;
}) {
  const std = standardAnswers(chatLanguage(question.question));
  return (
    <div className="flex flex-wrap gap-2" data-testid="uno-ai-answers">
      {question.options.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onAnswer(o)}
          className={cn(
            "rounded-full border px-3 py-1.5 text-sm transition-colors",
            o === question.recommended
              ? "border-primary/50 bg-primary/10 text-foreground hover:bg-primary/15"
              : "border-border hover:border-foreground/30",
          )}
          data-testid="uno-ai-answer"
        >
          {o}
          {o === question.recommended ? (
            <span className="ml-1.5 text-[10px] font-medium tracking-wide text-primary uppercase">
              {std.recommended}
            </span>
          ) : null}
        </button>
      ))}
      <button
        type="button"
        onClick={() => onAnswer(std.youDecide)}
        className="rounded-full border border-dashed border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        {std.youDecide}
      </button>
      <button
        type="button"
        onClick={() => onAnswer(std.justBuild)}
        className="rounded-full border border-dashed border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
        data-testid="uno-ai-just-build"
      >
        {std.justBuild}
      </button>
    </div>
  );
}

// ---- when the turn stopped ----

function StopCard({ stop, onResume }: { stop: AiStop; onResume: () => void }) {
  if (stop.code === "verify") return <VerifyCard onVerified={onResume} />;
  const out = stop.code === "free_empty" || stop.code === "hours_empty";
  return (
    <div
      className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3.5 text-sm"
      data-testid="uno-ai-stop"
    >
      <p>{stop.message}</p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {out ? (
          <Button size="sm" render={<a href={AI_USAGE_URL} target="_blank" rel="noreferrer" />}>
            Get more Uno AI
            <ExternalLinkIcon />
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={onResume}>
            <RotateCwIcon />
            Try again
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
  continueHere,
}: {
  action: "computer" | "connect_agent" | "uno_work";
  reason: string;
  chatId: string;
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
  return <ComputerOffer reason={reason} chatId={chatId} />;
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
function ComputerOffer({ reason, chatId }: { reason: string; chatId: string }) {
  const subscription = useQuery(subscriptionQuery());
  const standing = subscription.isPending ? null : liteStanding(subscription.data ?? null);
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

  return (
    <OfferFrame reason={reason} title="This needs your own computer">
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
          ) : standing === "free" || standing === null ? (
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
            render={<a href={checkoutHref("plus")} target="_blank" rel="noreferrer" />}
          >
            See plans
            <ExternalLinkIcon />
          </Button>
        </>
      )}
      <p className="w-full text-xs text-muted-foreground">
        When it's ready, this conversation continues there — Uno on your computer gets everything
        from here.
        {standing !== "cloud" && !codeOpen ? (
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
}: {
  url: string;
  title: string;
  reloadKey: number;
  overlay: boolean;
  onClose: () => void;
  onReload: () => void;
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
