/**
 * "What should your assistant do?" — the quiz with icons, one question at a
 * time, "Decide for me" on every step, then the "Your assistant" card with
 * one-click edits and "Set it up" (Misha 05.10). Same flow and texts as the
 * uno.place chat and the console (fishcode internal/assistantspec).
 */
import {
  BellIcon,
  CalendarIcon,
  CheckIcon,
  ClockIcon,
  CodeIcon,
  CoinsIcon,
  DatabaseIcon,
  FileTextIcon,
  FolderIcon,
  GlobeIcon,
  ImageIcon,
  LayoutGridIcon,
  LoaderCircleIcon,
  LockIcon,
  MailIcon,
  MessageSquareIcon,
  PanelTopIcon,
  PencilIcon,
  SearchIcon,
  SendIcon,
  ServerIcon,
  SparklesIcon,
  StoreIcon,
  TerminalIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  assistantInterview,
  toggleQuizPick,
  withQuizAnswer,
  type QuizState,
  type QuizTurn,
} from "./assistantQuizApi";

const ICONS: Record<string, LucideIcon> = {
  code: CodeIcon,
  chat: MessageSquareIcon,
  globe: GlobeIcon,
  store: StoreIcon,
  image: ImageIcon,
  search: SearchIcon,
  bell: BellIcon,
  calendar: CalendarIcon,
  edit: PencilIcon,
  telegram: SendIcon,
  mail: MailIcon,
  form: FileTextIcon,
  money: CoinsIcon,
  db: DatabaseIcon,
  site: PanelTopIcon,
  users: UsersIcon,
  spark: SparklesIcon,
  agent: SparklesIcon,
  folder: FolderIcon,
  server: ServerIcon,
  term: TerminalIcon,
  lock: LockIcon,
  check: CheckIcon,
  clock: ClockIcon,
  apps: LayoutGridIcon,
};

function Icon({ name, className }: { name: string | undefined; className?: string }) {
  const C = (name && ICONS[name]) || SparklesIcon;
  return <C className={cn("size-4", className)} aria-hidden />;
}

export function AssistantQuiz({
  sample = "",
  onSetUp,
  onOwnAgent,
}: {
  /** The person's own words, if any (they pre-select tiles). */
  sample?: string;
  /** "Set it up" on the card. */
  onSetUp: (turn: QuizTurn) => void;
  /** "I use my own agent" inside the quiz. */
  onOwnAgent: () => void;
}) {
  const [turn, setTurn] = useState<QuizTurn | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<ReadonlyArray<string>>([]);
  const [words, setWords] = useState("");
  const [ownOpen, setOwnOpen] = useState(false);
  const started = useRef(false);
  const lang = typeof navigator !== "undefined" ? navigator.language : "en";

  const go = async (state: QuizState) => {
    setLoading(true);
    setError(null);
    try {
      const next = await assistantInterview(state, sample, lang);
      if (next.exit === "agent") {
        onOwnAgent();
        return;
      }
      setTurn(next);
      setPicked(next.step?.multi ? [...(next.step.selected ?? [])] : []);
      setWords("");
      setOwnOpen(Boolean(next.step?.text_only));
    } catch {
      setError("Uno didn't answer this time. Try again in a moment.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void go({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const step = turn?.step ?? null;
  const card = turn?.card ?? null;
  const max = step?.max ?? 1;

  const answer = (a: { picks?: ReadonlyArray<string>; text?: string; skip?: boolean }) => {
    if (!turn || !step || loading) return;
    void go(withQuizAnswer(turn.state, step, a));
  };
  const choose = (id: string, input?: boolean, exit?: string) => {
    if (!step || loading) return;
    if (exit === "agent") {
      onOwnAgent();
      return;
    }
    if (step.multi) {
      const next = toggleQuizPick(picked, id, max);
      setPicked(next);
      if (input && next.includes(id)) setOwnOpen(true);
      return;
    }
    if (input) {
      setPicked([id]);
      setOwnOpen(true);
      return;
    }
    answer({ picks: [id] });
  };
  const submit = () => {
    const text = words.trim().slice(0, 160);
    if (picked.length === 0 && !text) return;
    answer({ picks: picked, text });
  };

  if (error && !turn) {
    return (
      <div className="flex flex-col items-start gap-3" data-testid="assistant-quiz-error">
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button size="sm" onClick={() => void go({})}>
          Try again
        </Button>
      </div>
    );
  }
  if (!turn) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircleIcon className="size-4 animate-spin" /> One moment…
      </div>
    );
  }

  if (step) {
    const big = step.id === "do";
    return (
      <section className="flex flex-col gap-4" data-testid="assistant-quiz" data-step={step.id}>
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{step.question}</h1>
          {step.hint ? <p className="text-sm text-muted-foreground">{step.hint}</p> : null}
        </div>
        {step.choices.length > 0 ? (
          <div
            role="group"
            aria-label={step.question}
            className={cn("grid gap-2", big ? "grid-cols-2 sm:grid-cols-3" : "sm:grid-cols-2")}
          >
            {step.choices.map((c) => {
              const on = picked.includes(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  disabled={loading}
                  aria-pressed={step.multi ? on : undefined}
                  onClick={() => choose(c.id, c.input, c.exit)}
                  data-choice={c.id}
                  className={cn(
                    "flex min-w-0 items-start gap-3 rounded-xl border border-border bg-card px-3 py-3 text-left transition-colors hover:border-primary/50",
                    on && "border-primary bg-primary/5 ring-1 ring-primary",
                    step.multi && !on && picked.length >= max && "opacity-70",
                  )}
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                    <Icon name={c.icon} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-sm font-medium leading-snug">
                      {c.title}
                      {c.badge ? (
                        <span
                          className={cn(
                            "ml-2 rounded-full px-1.5 py-0.5 align-[1px] text-[11px] font-semibold",
                            c.soon
                              ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                              : "bg-primary/10 text-primary",
                          )}
                        >
                          {c.badge}
                        </span>
                      ) : null}
                    </span>
                    {c.text ? (
                      <span
                        className={cn("text-xs text-muted-foreground", big && "hidden sm:block")}
                      >
                        {c.text}
                      </span>
                    ) : null}
                  </span>
                  {step.multi ? (
                    <span
                      className={cn(
                        "grid size-5 shrink-0 place-items-center rounded-md border border-border text-transparent",
                        on && "border-primary bg-primary text-primary-foreground",
                      )}
                    >
                      <CheckIcon className="size-3.5" />
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}
        {ownOpen ? (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <Input
              autoFocus
              maxLength={160}
              value={words}
              placeholder={step.own}
              aria-label={step.labels.own}
              onChange={(event) => setWords(event.currentTarget.value)}
            />
            {step.multi ? null : (
              <Button type="submit" disabled={loading || !words.trim()}>
                {step.labels.send}
              </Button>
            )}
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setOwnOpen(true)}
            className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <PencilIcon className="size-3.5" />
            {step.labels.own}
          </button>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {step.multi || step.text_only ? (
            <Button
              disabled={loading || (picked.length === 0 && !words.trim())}
              onClick={submit}
              data-testid="assistant-quiz-next"
            >
              {loading ? <LoaderCircleIcon className="size-4 animate-spin" /> : null}
              {step.labels.next}
              {step.multi && picked.length > 0 ? ` (${picked.length})` : ""}
            </Button>
          ) : null}
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => void go({ ...turn.state, decide: true, edit: "" })}
            data-testid="assistant-quiz-decide"
          >
            <SparklesIcon className="size-4" />
            {step.labels.decide}
          </Button>
          {step.id !== "do" ? (
            <button
              type="button"
              disabled={loading}
              onClick={() => answer({ skip: true })}
              className="px-1 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              {step.labels.skip}
            </button>
          ) : null}
          {step.progress ? (
            <span className="ml-auto text-xs text-muted-foreground">{step.progress}</span>
          ) : null}
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </section>
    );
  }

  if (!card) return null;
  return (
    <section
      className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-5"
      data-testid="assistant-quiz-card"
    >
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <SparklesIcon className="size-5 text-primary" />
        {card.title}
      </h2>
      {card.brief ? <p className="text-[15px] leading-relaxed">{card.brief}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => onSetUp(turn)} data-testid="assistant-quiz-setup">
          {card.setup}
        </Button>
        {card.setup_hint ? (
          <span className="text-sm text-muted-foreground">{card.setup_hint}</span>
        ) : null}
      </div>
      <dl className="grid border-t border-border sm:grid-cols-2 sm:gap-x-6">
        {card.rows.map((r) => (
          <div key={r.label} className="flex items-start gap-3 border-b border-border py-2.5">
            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <Icon name={r.icon} className="size-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <dt className="text-xs font-medium text-muted-foreground">{r.label}</dt>
              <dd className="break-words text-sm">
                {r.value}
                {r.note ? (
                  <span className="block text-xs text-muted-foreground">{r.note}</span>
                ) : null}
              </dd>
            </div>
            <button
              type="button"
              disabled={loading}
              aria-label={`${card.edit}: ${r.label}`}
              onClick={() => void go({ ...turn.state, edit: r.step })}
              className="text-xs font-semibold text-primary hover:underline"
            >
              {card.edit}
            </button>
          </div>
        ))}
      </dl>
      {card.note ? <p className="text-xs text-muted-foreground">{card.note}</p> : null}
    </section>
  );
}
