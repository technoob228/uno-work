/**
 * "What should your assistant do?" (Misha 05.10): the quiz and the short
 * interview, the same flow as the uno.place chat and the console's /start.
 * The server makes every question, tile and default (fishcode
 * internal/assistantspec, POST /api/v1/ai/assistant-interview); Work only
 * shows them and sends the whole interview state back with each answer.
 *
 * The end is a "Your assistant" card and a machine-readable spec with
 * `hermes` — the same fields as AssistantPlan (assistantTemplates.ts), so the
 * assistants flow can create it as is (`planFromHermes`), and a
 * `setup_message` for the Uno chat on this computer ("set yourself up from
 * these answers") — that one works without the assistants flag.
 */
import { accountRequest } from "../../account/unoAccount";
import {
  CONNECTOR_PROVIDERS,
  isConnectorLevel,
  type AssistantPlan,
  type ConnectorLevel,
  type ConnectorPermissions,
  type ConnectorProvider,
} from "./assistantTemplates";
import type { AssistantTemplateId } from "@t3tools/contracts";

export interface QuizAnswer {
  readonly picks?: ReadonlyArray<string>;
  readonly text?: string;
  readonly skip?: boolean;
  readonly for?: string;
}

export interface QuizState {
  readonly v?: number;
  readonly lang?: string;
  readonly answers?: Readonly<Record<string, QuizAnswer>>;
  readonly decide?: boolean;
  readonly edit?: string;
  readonly seed?: ReadonlyArray<string>;
}

export interface QuizChoice {
  readonly id: string;
  readonly icon?: string;
  readonly title: string;
  readonly text?: string;
  readonly badge?: string;
  readonly soon?: boolean;
  readonly recommended?: boolean;
  readonly input?: boolean;
  readonly exit?: string;
}

export interface QuizStep {
  readonly id: string;
  readonly n: number;
  readonly of: number;
  readonly progress: string;
  readonly question: string;
  readonly hint?: string;
  readonly multi: boolean;
  readonly max?: number;
  readonly choices: ReadonlyArray<QuizChoice>;
  readonly selected?: ReadonlyArray<string>;
  readonly text_only?: boolean;
  readonly own: string;
  readonly for?: string;
  readonly labels: {
    readonly next: string;
    readonly decide: string;
    readonly skip: string;
    readonly own: string;
    readonly send: string;
  };
}

export interface QuizCard {
  readonly title: string;
  readonly brief: string;
  readonly rows: ReadonlyArray<{
    readonly step: string;
    readonly icon: string;
    readonly label: string;
    readonly value: string;
    readonly note?: string;
  }>;
  readonly edit: string;
  readonly setup: string;
  readonly setup_hint: string;
  readonly note?: string;
}

/** `hermes` of the spec: AssistantPlan's fields and a few more. */
export interface QuizHermes {
  readonly name?: string;
  readonly emoji?: string;
  readonly template?: string;
  readonly phrase?: string;
  readonly job?: string;
  readonly connectors?: Readonly<Record<string, string>>;
  readonly schedule?: {
    readonly label: string;
    readonly cron: string;
    readonly prompt?: string;
  } | null;
  readonly answers?: ReadonlyArray<{
    readonly questionId: string;
    readonly question: string;
    readonly answer: string;
    readonly cron: string | null;
  }> | null;
  readonly never?: ReadonlyArray<string> | null;
  readonly runtime_mode?: string;
  readonly channel?: string;
  readonly instructions?: string;
  readonly setup_message?: string;
}

export interface QuizTurn {
  readonly state: QuizState;
  readonly step?: QuizStep;
  readonly card?: QuizCard;
  readonly hermes?: QuizHermes;
  readonly exit?: string;
  readonly as?: string;
  readonly next?: string;
}

/**
 * The console path "Set it up" opens from the light Work (no computer here):
 * the backend's `next`. Usually the plan step (/start?…&as=…); an account
 * whose plan already has cloud Uno Work gets /work?do=assistant&as=… — straight
 * into Work, no plan step (fishcode train 06.10-E). Anything else falls back to
 * the console's assistant start.
 */
export function quizConsoleNext(next: string | undefined): string {
  if (next && /^\/start\?[A-Za-z0-9_=&%.-]*$/.test(next)) return next;
  if (next && /^\/work\?do=assistant&as=[A-Za-z0-9_-]{8,1200}$/.test(next)) return next;
  return "/start?goal=assistant";
}

export async function assistantInterview(
  state: QuizState,
  sample = "",
  lang = "",
): Promise<QuizTurn> {
  return (await accountRequest("POST", "/api/v1/ai/assistant-interview", {
    state,
    sample,
    lang,
  })) as QuizTurn;
}

/** The state with one more answer (the follow-up's topic rides along). */
export function withQuizAnswer(state: QuizState, step: QuizStep, answer: QuizAnswer): QuizState {
  return {
    ...state,
    answers: { ...state.answers, [step.id]: step.for ? { ...answer, for: step.for } : answer },
    edit: "",
  };
}

/** Toggle a tile in a multi-select step, never past `max`. */
export function toggleQuizPick(
  picked: ReadonlyArray<string>,
  id: string,
  max: number,
): ReadonlyArray<string> {
  if (picked.includes(id)) return picked.filter((x) => x !== id);
  if (picked.length >= max) return picked;
  return [...picked, id];
}

const TEMPLATES: ReadonlyArray<AssistantTemplateId> = [
  "personal",
  "marketing",
  "security",
  "support",
];

/**
 * The spec's `hermes` → an AssistantPlan for createLocalAssistant / the
 * review card (NewAssistantFlow): answers go to USER.md, never to SOUL.md's
 * rules, and the interview's "How I work" block to SOUL.md (howIWork).
 */
export function planFromHermes(h: QuizHermes): AssistantPlan {
  const connectors = {} as Record<ConnectorProvider, ConnectorLevel>;
  for (const provider of CONNECTOR_PROVIDERS) {
    const level = h.connectors?.[provider];
    connectors[provider] = isConnectorLevel(level) ? level : "none";
  }
  const template = TEMPLATES.find((t) => t === h.template) ?? null;
  const phrase = (h.phrase ?? "").trim();
  return {
    name: (h.name ?? "").trim().slice(0, 40) || "Uno",
    emoji: h.emoji || "✨",
    template,
    phrase,
    job: (h.job ?? "").trim() || phrase,
    connectors: connectors as ConnectorPermissions,
    schedule: h.schedule?.cron ? { label: h.schedule.label, cron: h.schedule.cron } : null,
    answers: (h.answers ?? []).map((a) => ({
      questionId: a.questionId,
      question: a.question,
      answer: a.answer,
      cron: a.cron ?? null,
    })),
    never: h.never && h.never.length > 0 ? [...h.never] : ["Pay for anything"],
    ...(h.instructions?.trim() ? { howIWork: h.instructions.trim() } : {}),
  };
}

/**
 * The plan from the quiz on its way to the assistants flow (Home → "Set it up"
 * → /assistants?view=new opens straight on the review card). In memory, once.
 */
let pendingPlan: AssistantPlan | null = null;
export const quizPlanHandoff = {
  set(plan: AssistantPlan) {
    pendingPlan = plan;
  },
  take(): AssistantPlan | null {
    const out = pendingPlan;
    pendingPlan = null;
    return out;
  },
};
