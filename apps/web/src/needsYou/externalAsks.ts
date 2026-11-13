/**
 * What waits for the person outside the chats (Misha 13.11, the Pult redo):
 * a question an agent filed in the team's tracker (with its options) and a
 * result to accept ("before / after" with screenshots, Accept / Not accept).
 * The Needs-you screen lists them with the chats that wait.
 *
 * Today the tracker (the Pult app) keeps them; this store is the window's
 * copy. The demo fills it from fixtures; wiring the app in is the next step
 * (the app posts them through the App API, as Inbox items do).
 */
import { create } from "zustand";

export interface AskImage {
  readonly url: string;
  readonly side: "before" | "after";
  readonly caption: string;
}

export interface AskLink {
  readonly label: string;
  readonly url: string;
  /** The page's own password (uno4.me reports), shown with a Copy button. */
  readonly password?: string;
}

interface AskBase {
  readonly id: string;
  /** Who filed it, in people's words ("Release lead", "Pricing page"). */
  readonly from: string;
  /** The chat that filed it, when it is one of the person's chats. */
  readonly thread?: { readonly environmentId: string; readonly threadId: string };
  readonly createdAt: string;
}

/** A decision with ready answers; the first option is the agent's pick. */
export interface QuestionAsk extends AskBase {
  readonly kind: "question";
  readonly title: string;
  readonly detail?: string;
  readonly options: ReadonlyArray<string>;
}

/** A finished result to accept: before / after, what to check, Accept / Not accept. */
export interface ReviewAsk extends AskBase {
  readonly kind: "review";
  readonly title: string;
  /** One line for the person: what changed for the customer. */
  readonly summary: string;
  readonly before: ReadonlyArray<string>;
  readonly after: ReadonlyArray<string>;
  readonly images: ReadonlyArray<AskImage>;
  readonly checks: ReadonlyArray<string>;
  readonly links: ReadonlyArray<AskLink>;
  /** "Staging", "Demo", "In production": where the result is now. */
  readonly where: string;
  readonly version: number;
}

export type ExternalAsk = QuestionAsk | ReviewAsk;

export type AskAnswer =
  | { readonly kind: "option"; readonly option: string }
  | { readonly kind: "accept" }
  | { readonly kind: "reject"; readonly feedback: string };

interface ExternalAsksState {
  readonly asks: ReadonlyArray<ExternalAsk>;
  /** What the person answered, by ask id (kept so the screen can say "Sent"). */
  readonly answered: Readonly<Record<string, AskAnswer>>;
  readonly setAsks: (asks: ReadonlyArray<ExternalAsk>) => void;
  readonly answer: (id: string, answer: AskAnswer) => void;
}

export const useExternalAsksStore = create<ExternalAsksState>((set) => ({
  asks: [],
  answered: {},
  setAsks: (asks) => set({ asks }),
  answer: (id, answer) => set((state) => ({ answered: { ...state.answered, [id]: answer } })),
}));

/** One line for the toast and the agent: what the person said. */
export function askAnswerLine(ask: ExternalAsk, answer: AskAnswer): string {
  switch (answer.kind) {
    case "option":
      return `“${ask.title}” → ${answer.option}`;
    case "accept":
      return `Accepted v${ask.kind === "review" ? ask.version : 1}: ${ask.title}`;
    case "reject":
      return `Not accepted: ${ask.title} — ${answer.feedback}`;
  }
}
