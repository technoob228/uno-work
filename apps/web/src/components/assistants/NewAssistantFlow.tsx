/**
 * New assistant (assistants MVP): one sentence (or a role template) → at most
 * three questions from Uno AI → a "Will do / Won't do" card → Create.
 *
 * Where it lives (decision 02.10 evening, "by default — right here"): on THIS
 * computer, a folder in ~/UnoWork/Assistants next to the others; "Give it its
 * own computer" is the option, highlighted for templates that read other
 * people's emails and sites (see `createAssistant.ts`).
 */
import type { AssistantDraftResult, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronLeftIcon,
  HouseIcon,
  LoaderCircleIcon,
  LockIcon,
  MonitorIcon,
  ShieldCheckIcon,
  XIcon,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { UNO_WORK_URL } from "../../account/unoAccount";
import { isAssistantsDemo } from "../../lib/assistantsDemo";
import { draftAssistant } from "../../lib/managerApi";
import { cn } from "../../lib/utils";
import { openInstallDocs } from "../onboarding/harnessInstallLinks";
import { TelegramMark } from "../setup/brandMarks";
import { AssistantTelegramPanel } from "../setup/steps/ChannelsStep";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { EmojiAvatar, LevelPicker, nextEmoji } from "./AssistantBits";
import {
  ASSISTANT_NAME_MAX,
  ASSISTANT_TEMPLATES,
  CONNECTOR_LABEL,
  CONNECTOR_PROVIDERS,
  buildPlan,
  fallbackDraft,
  wontDo,
  willDo,
  type AssistantAnswer,
  type AssistantPlan,
  type AssistantTemplate,
  type ConnectorLevel,
  type ConnectorProvider,
} from "./assistantTemplates";
import {
  CREATE_STAGES,
  LOCAL_CREATE_STAGES,
  createAssistant,
  createLocalAssistant,
  pendingAssistantSetup,
  type CreateAssistantResult,
  type CreateStage,
  type LocalCreateResult,
  type LocalCreateStage,
} from "./createAssistant";
import { OWN_COMPUTER_CAPTION, suggestsOwnComputer } from "./LocalAssistantPage";
import {
  ASSISTANT_COMPUTERS_KEY,
  LOCAL_ASSISTANTS_KEY,
  makeCreateAssistantDeps,
  makeLocalCreateDeps,
  useAssistantsAvailability,
  type AssistantsAvailability,
} from "./useAssistants";

/** Where the new assistant lives: on this computer (default), or its own. */
export type AssistantHome = "here" | "own";

const PHRASE_MAX = 1000;
const DRAFT_TIMEOUT_MS = 25_000;

type Step =
  | { kind: "describe" }
  | { kind: "thinking" }
  | { kind: "ask"; draft: AssistantDraftResult; index: number; answers: AssistantAnswer[] }
  | { kind: "review" }
  | { kind: "creating"; stage: CreateStage | LocalCreateStage }
  | { kind: "done"; result: CreateAssistantResult }
  | { kind: "done-here"; result: LocalCreateResult }
  | { kind: "failed"; message: string };

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

export function NewAssistantFlow({
  environmentId,
  boxId,
  machineLabel,
  onOpen,
  onOpenHere,
}: {
  /** The computer this page talks to: asks Uno AI, holds the account, and is "here". */
  environmentId: EnvironmentId;
  /** This computer's box (its schedules wake it), null when it has none. */
  boxId: number | null;
  machineLabel: string;
  onOpen: (boxId: number) => void;
  /** An assistant made on this computer. */
  onOpenHere: (projectId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [phrase, setPhrase] = useState("");
  const [template, setTemplate] = useState<AssistantTemplate | null>(null);
  const [step, setStep] = useState<Step>({ kind: "describe" });
  const [plan, setPlan] = useState<AssistantPlan | null>(null);
  const [home, setHome] = useState<AssistantHome>("here");
  const creating = useRef(false);
  const availability = useAssistantsAvailability();

  const pickTemplate = (next: AssistantTemplate) => {
    setTemplate(next);
    setPhrase(next.phrase);
  };

  const finishAsking = (draft: AssistantDraftResult, answers: AssistantAnswer[]) => {
    setPlan(buildPlan({ phrase, template, draft, answers }));
    setStep({ kind: "review" });
  };

  const start = async () => {
    const text = phrase.trim();
    if (!text) return;
    setStep({ kind: "thinking" });
    const draft = await withTimeout(
      draftAssistant({ environmentId, phrase: text, template: template?.id ?? null }),
      DRAFT_TIMEOUT_MS,
    ).catch(() => fallbackDraft(text, template));
    // No questions from AI? The template's own keep the "≤3 questions" promise.
    const withQuestions =
      draft.questions.length > 0
        ? draft
        : { ...draft, questions: fallbackDraft(text, template).questions };
    if (withQuestions.questions.length === 0) finishAsking(withQuestions, []);
    else setStep({ kind: "ask", draft: withQuestions, index: 0, answers: [] });
  };

  const answer = (
    current: Extract<Step, { kind: "ask" }>,
    picked: { label: string; cron?: string | null | undefined } | null,
  ) => {
    const question = current.draft.questions[current.index]!;
    const answers = picked
      ? [
          ...current.answers,
          {
            questionId: question.id,
            question: question.text,
            answer: picked.label,
            cron: picked.cron ?? null,
          },
        ]
      : current.answers;
    if (current.index + 1 >= current.draft.questions.length) finishAsking(current.draft, answers);
    else setStep({ ...current, index: current.index + 1, answers });
  };

  const create = async () => {
    if (!plan || creating.current) return;
    creating.current = true;
    if (home === "here") {
      setStep({ kind: "creating", stage: "assistant" });
      try {
        const result = await createLocalAssistant(
          plan,
          makeLocalCreateDeps(environmentId, boxId, (stage) =>
            setStep({ kind: "creating", stage }),
          ),
        );
        void queryClient.invalidateQueries({ queryKey: LOCAL_ASSISTANTS_KEY });
        setStep({ kind: "done-here", result });
      } catch (cause) {
        setStep({
          kind: "failed",
          message:
            cause instanceof Error && cause.message
              ? cause.message
              : "This computer didn't answer.",
        });
      } finally {
        creating.current = false;
      }
      return;
    }
    setStep({ kind: "creating", stage: "computer" });
    try {
      const result = await createAssistant(
        plan,
        makeCreateAssistantDeps(environmentId, plan, (stage) =>
          setStep({ kind: "creating", stage }),
        ),
      );
      if (!result.assistantReady) pendingAssistantSetup.set(result.boxId, plan);
      void queryClient.invalidateQueries({ queryKey: ASSISTANT_COMPUTERS_KEY });
      setStep({ kind: "done", result });
    } catch (cause) {
      setStep({
        kind: "failed",
        message: cause instanceof Error && cause.message ? cause.message : "Uno didn't answer.",
      });
    } finally {
      creating.current = false;
    }
  };

  if (step.kind === "describe" || step.kind === "thinking") {
    const thinking = step.kind === "thinking";
    return (
      <section className="flex flex-col gap-5 pt-4" data-testid="assistant-new-describe">
        <div className="flex flex-col items-center gap-1.5 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Who is it and what does it do?</h1>
          <p className="text-sm text-muted-foreground">
            One sentence is enough. Uno asks up to three questions, and you check everything before
            it starts.
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-card/40 p-3 shadow-xs focus-within:border-primary/50">
          <Textarea
            autoFocus
            value={phrase}
            maxLength={PHRASE_MAX}
            rows={3}
            disabled={thinking}
            placeholder="For example: answer my customers' emails using the FAQ in Notion, and hand the hard ones to me."
            onChange={(event) => setPhrase(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void start();
              }
            }}
            className="border-0 bg-transparent text-[15px] shadow-none focus-visible:ring-0"
            data-testid="assistant-new-phrase"
          />
          <div className="flex items-center justify-between gap-2 pt-2">
            <span className="text-xs text-muted-foreground">Any language works</span>
            <Button
              onClick={() => void start()}
              disabled={thinking || phrase.trim().length === 0}
              data-testid="assistant-new-next"
            >
              {thinking ? (
                <>
                  <LoaderCircleIcon className="size-4 animate-spin" />
                  Reading…
                </>
              ) : (
                <>
                  Set it up
                  <ArrowRightIcon className="size-4" />
                </>
              )}
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap justify-center gap-2" role="list">
          {ASSISTANT_TEMPLATES.map((option) => (
            <button
              key={option.id}
              type="button"
              role="listitem"
              disabled={thinking}
              onClick={() => pickTemplate(option)}
              data-testid={`assistant-template-${option.id}`}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm transition-colors",
                template?.id === option.id
                  ? "border-primary/50 bg-primary/[0.06] text-primary"
                  : "border-border hover:bg-accent/50",
              )}
            >
              <span aria-hidden>{option.emoji}</span>
              {option.title}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap justify-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <LockIcon className="size-3.5" />
            Nothing runs until you press Create
          </span>
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheckIcon className="size-3.5" />
            It opens only the apps you allow
          </span>
        </div>
      </section>
    );
  }

  if (step.kind === "ask") {
    const question = step.draft.questions[step.index]!;
    return (
      <section className="flex flex-col gap-5 pt-4" data-testid="assistant-new-question">
        <div className="flex items-center gap-3">
          <EmojiAvatar emoji={step.draft.emoji} />
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">
              Question {step.index + 1} of {step.draft.questions.length}
            </p>
            <h1 className="text-xl font-semibold tracking-tight">{question.text}</h1>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          {question.options.map((option, index) => (
            <button
              key={option.label}
              type="button"
              onClick={() => answer(step, option)}
              data-testid={`assistant-question-option-${index}`}
              className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-border/70 px-4 py-3 text-left text-sm transition-colors hover:border-primary/40 hover:bg-primary/[0.04]"
            >
              <span>{option.label}</span>
              {index === 0 ? (
                <span className="text-[11px] text-muted-foreground">Most people pick this</span>
              ) : null}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between">
          <Button variant="ghost" onClick={() => setStep({ kind: "describe" })}>
            <ChevronLeftIcon className="size-4" />
            Back
          </Button>
          <Button variant="ghost" onClick={() => answer(step, null)}>
            Skip
          </Button>
        </div>
      </section>
    );
  }

  if (step.kind === "review" && plan) {
    return (
      <ReviewCard
        plan={plan}
        availability={availability}
        home={home}
        machineLabel={machineLabel}
        onHome={setHome}
        onChange={setPlan}
        onBack={() => setStep({ kind: "describe" })}
        onCreate={() => void create()}
      />
    );
  }

  if (step.kind === "creating" && plan) {
    const stages: ReadonlyArray<{ stage: string; label: string }> =
      home === "here" ? LOCAL_CREATE_STAGES : CREATE_STAGES;
    const current = stages.findIndex((entry) => entry.stage === step.stage);
    return (
      <section className="flex flex-col gap-5 pt-4" data-testid="assistant-new-creating">
        <div className="flex items-center gap-3">
          <EmojiAvatar emoji={plan.emoji} />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Creating {plan.name}</h1>
            <p className="text-sm text-muted-foreground">
              {home === "here"
                ? "A few seconds."
                : `About a minute. You can leave this page: ${plan.name} keeps getting ready.`}
            </p>
          </div>
        </div>
        <ol className="flex flex-col gap-2.5">
          {stages
            .filter((entry) => entry.stage !== "schedule" || plan.schedule)
            .map((entry, index) => (
              <li key={entry.stage} className="flex items-center gap-2.5 text-sm">
                {index < current ? (
                  <CheckIcon className="size-4 text-success" />
                ) : index === current ? (
                  <LoaderCircleIcon className="size-4 animate-spin text-primary" />
                ) : (
                  <span className="size-4 rounded-full border border-border" aria-hidden />
                )}
                <span className={cn(index > current && "text-muted-foreground")}>
                  {entry.label}
                </span>
              </li>
            ))}
        </ol>
      </section>
    );
  }

  if (step.kind === "done" && plan) {
    const { result } = step;
    return (
      <section className="flex flex-col gap-5 pt-4" data-testid="assistant-new-done">
        <div className="flex items-center gap-3">
          <EmojiAvatar emoji={plan.emoji} className="size-12 text-2xl" />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              {result.assistantReady ? `${plan.name} is ready` : `${plan.name}'s computer is made`}
            </h1>
            <p className="text-sm text-muted-foreground">
              {result.assistantReady
                ? "Say hello in the chat, or connect Telegram to reach it from your phone."
                : "It is still starting. Finish the setup from its page in a minute."}
            </p>
          </div>
        </div>
        {result.notes.length > 0 ? (
          <ul className="flex flex-col gap-1.5 rounded-xl bg-warning/8 px-4 py-3 text-sm">
            {result.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
        {result.assistantReady && result.environmentId ? (
          <TelegramNow name={plan.name} environmentId={result.environmentId} />
        ) : null}
        <div className="flex justify-end">
          <Button onClick={() => onOpen(result.boxId)} data-testid="assistant-new-open">
            Open {plan.name}
            <ArrowRightIcon className="size-4" />
          </Button>
        </div>
      </section>
    );
  }

  if (step.kind === "done-here" && plan) {
    const { result } = step;
    return (
      <section className="flex flex-col gap-5 pt-4" data-testid="assistant-new-done-here">
        <div className="flex items-center gap-3">
          <EmojiAvatar emoji={plan.emoji} className="size-12 text-2xl" />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{plan.name} is ready</h1>
            <p className="text-sm text-muted-foreground">
              It lives on {machineLabel}. Say hello in the chat, or connect Telegram to reach it
              from your phone.
            </p>
          </div>
        </div>
        {result.notes.length > 0 ? (
          <ul className="flex flex-col gap-1.5 rounded-xl bg-warning/8 px-4 py-3 text-sm">
            {result.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
        <TelegramNow
          name={plan.name}
          environmentId={environmentId}
          projectId={result.projectId as ProjectId}
        />
        <div className="flex justify-end">
          <Button
            onClick={() => onOpenHere(result.projectId)}
            data-testid="assistant-new-open-here"
          >
            Open {plan.name}
            <ArrowRightIcon className="size-4" />
          </Button>
        </div>
      </section>
    );
  }

  if (step.kind === "failed") {
    return (
      <section className="flex flex-col gap-4 pt-4" data-testid="assistant-new-failed">
        <h1 className="text-xl font-semibold tracking-tight">Couldn't create the assistant</h1>
        <p className="text-sm text-muted-foreground">{step.message}</p>
        <p className="text-sm text-muted-foreground">
          If Uno made a computer before it stopped, you'll see it under Assistants in a minute.
        </p>
        <div className="flex gap-2">
          <Button onClick={() => setStep({ kind: "review" })}>Try again</Button>
          <Button variant="ghost" onClick={() => setStep({ kind: "describe" })}>
            Start over
          </Button>
        </div>
      </section>
    );
  }

  return null;
}

function ReviewCard({
  plan,
  availability,
  home,
  machineLabel,
  onHome,
  onChange,
  onBack,
  onCreate,
}: {
  plan: AssistantPlan;
  availability: AssistantsAvailability;
  home: AssistantHome;
  machineLabel: string;
  onHome: (home: AssistantHome) => void;
  onChange: (plan: AssistantPlan) => void;
  onBack: () => void;
  onCreate: () => void;
}) {
  const setLevel = (provider: ConnectorProvider, level: ConnectorLevel) =>
    onChange({ ...plan, connectors: { ...plan.connectors, [provider]: level } });
  const name = plan.name.trim() || "Uno";
  const canCreate = home === "here" || availability === "on";
  const suggestOwn = suggestsOwnComputer(plan.template);
  return (
    <section className="flex flex-col gap-4 pt-2" data-testid="assistant-new-review">
      <div className="flex items-start gap-3">
        <EmojiAvatar
          emoji={plan.emoji}
          className="size-12 text-2xl"
          title="Change the picture"
          onClick={() => onChange({ ...plan, emoji: nextEmoji(plan.emoji) })}
        />
        <div className="min-w-0 flex-1">
          <Input
            value={plan.name}
            maxLength={ASSISTANT_NAME_MAX}
            onChange={(event) => onChange({ ...plan, name: event.currentTarget.value })}
            className="h-9 max-w-xs text-lg font-semibold"
            aria-label="Name"
            data-testid="assistant-review-name"
          />
          <p className="mt-1 text-sm text-muted-foreground">{plan.job}</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-border/70 px-4 py-3">
          <h2 className="pb-2 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Will do
          </h2>
          <ul className="flex flex-col gap-1.5 text-sm" data-testid="assistant-review-will">
            {willDo(plan).map((line) => (
              <li key={line} className="flex gap-2">
                <CheckIcon className="mt-0.5 size-4 shrink-0 text-success" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-2xl border border-border/70 px-4 py-3">
          <h2 className="pb-2 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Won't do
          </h2>
          <ul className="flex flex-col gap-1.5 text-sm" data-testid="assistant-review-wont">
            {wontDo(plan).map((line) => (
              <li key={line} className="flex gap-2">
                <XIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="rounded-2xl border border-border/70 px-4 py-3">
        <h2 className="pb-1 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Apps {name} can open
        </h2>
        <div className="divide-y divide-border/60">
          {CONNECTOR_PROVIDERS.map((provider) => (
            <div key={provider} className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1 text-sm">{CONNECTOR_LABEL[provider]}</span>
              <LevelPicker
                value={plan.connectors[provider]}
                onChange={(level) => setLevel(provider, level)}
                testId={`assistant-review-level-${provider}`}
              />
            </div>
          ))}
        </div>
        <p className="pt-1 text-xs text-muted-foreground">
          {home === "here"
            ? `Work on this computer checks this on every request: it stops mistakes, not a determined attack. For a wall Uno's servers enforce, give ${name} its own computer.`
            : `Uno checks this on every request, so a tricky email can't talk ${name} past it.`}{" "}
          Connect the apps themselves later, when {name} needs them.
        </p>
      </div>

      <div className="flex flex-col gap-2" role="radiogroup" aria-label="Where it lives">
        <h2 className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Where {name} lives
        </h2>
        <HomeOption
          selected={home === "here"}
          onSelect={() => onHome("here")}
          icon={<HouseIcon className="size-4" />}
          title="On this computer"
          body={`Next to your other assistants on ${machineLabel}. Works while it is on.`}
          testId="assistant-home-here"
        />
        <HomeOption
          selected={home === "own"}
          onSelect={() => onHome("own")}
          icon={<MonitorIcon className="size-4" />}
          title="Give it its own computer"
          body={`${OWN_COMPUTER_CAPTION} It sleeps when idle and wakes for Telegram, its schedule and you.`}
          badge={suggestOwn ? "Suggested for this one" : null}
          testId="assistant-home-own"
        />
      </div>

      {home === "here" ? null : availability === "no-account" ? (
        <div
          className="rounded-xl bg-warning/8 px-4 py-3 text-sm"
          data-testid="assistant-review-no-account"
        >
          To give {name} its own computer, open Uno Work with your Uno account:{" "}
          <button
            type="button"
            className="cursor-pointer font-medium underline underline-offset-2"
            onClick={() => openInstallDocs(UNO_WORK_URL)}
          >
            app.uno4.work
          </button>
          . Or keep it on this computer.
        </div>
      ) : availability === "not-yet" ? (
        <div
          className="rounded-xl bg-warning/8 px-4 py-3 text-sm"
          data-testid="assistant-review-not-yet"
        >
          Assistants with their own computer aren't on your account yet. Keep {name} on this
          computer for now: you can move it later from its page.
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" onClick={onBack}>
          <ChevronLeftIcon className="size-4" />
          Back
        </Button>
        <Button
          onClick={onCreate}
          disabled={!canCreate || plan.name.trim().length === 0}
          data-testid="assistant-review-create"
        >
          Create {name}
          {isAssistantsDemo ? <span className="text-[10px] opacity-70">(demo)</span> : null}
        </Button>
      </div>
    </section>
  );
}

function HomeOption({
  selected,
  onSelect,
  icon,
  title,
  body,
  badge = null,
  testId,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: ReactNode;
  title: string;
  body: string;
  badge?: string | null;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      data-testid={testId}
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-left transition-colors",
        selected
          ? "border-primary/60 bg-primary/[0.04] ring-1 ring-primary/30"
          : "border-border/70 hover:bg-accent/40",
      )}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-background text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
          {title}
          {badge ? (
            <span className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary">
              {badge}
            </span>
          ) : null}
        </span>
        <span className="block text-xs text-muted-foreground">{body}</span>
      </span>
    </button>
  );
}

/**
 * Telegram right after Create (decision 02.10): the assistant's own bot by
 * default — @BotFather steps, the token in a protected field (it goes to the
 * computer, never into a chat), getMe, then Start on the bot's link. Uno's
 * shared bot is the fallback link inside.
 */
function TelegramNow({
  name,
  environmentId,
  projectId,
}: {
  name: string;
  environmentId: EnvironmentId;
  projectId?: ProjectId;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="rounded-2xl border border-border/70 px-4 py-3"
      data-testid="assistant-new-telegram"
    >
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-2 text-left text-sm font-medium"
        onClick={() => setOpen((value) => !value)}
      >
        <TelegramMark className="size-4" />
        <span className="flex-1">Give {name} its own Telegram bot</span>
        <span className="text-xs font-normal text-muted-foreground">
          {open ? "Hide" : "Optional · 1 min"}
        </span>
      </button>
      {open ? (
        <div className="pt-3">
          <AssistantTelegramPanel
            environmentId={environmentId}
            initialMode="own"
            {...(projectId !== undefined ? { projectId } : {})}
          />
        </div>
      ) : null}
    </div>
  );
}
