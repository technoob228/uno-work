/**
 * "Continue on my computer": a Uno AI chat (no computer) moves to the Uno on
 * the person's computer once it exists.
 *
 * Before the computer is created, the chat id is remembered here (the browser
 * app and the computer's Uno Work share one origin — the account's own
 * <label>.uno4.work, or app.uno4.work — so one localStorage);
 * the computer's Home picks it up on its first load, reads the chat from the
 * account and sends it to the Uno chat there (the pinned one; a new chat on
 * an older daemon) as the first message with the whole context: the goal,
 * the answers, the plan, the live site, what the person wants next. Pure
 * parts are unit-tested.
 */
import type { AiChatMessage, AiSite } from "./unoAiApi";
import { type AiItem, transcriptItems } from "./unoAiModel";

const KEY = "uno.ai.handoff.v1";
/** A hand-off older than this is stale (the computer never came, or it was long ago). */
export const HANDOFF_TTL_MS = 6 * 60 * 60 * 1000;

export interface PendingHandoff {
  readonly chatId: string;
  readonly at: number;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function store(): Store | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function rememberHandoff(chatId: string, now = Date.now(), s: Store | null = store()): void {
  try {
    s?.setItem(KEY, JSON.stringify({ chatId, at: now } satisfies PendingHandoff));
  } catch {
    // private mode: the chat is still there, "Continue on this computer" works by hand
  }
}

/** A fresh hand-off is waiting (not consumed). */
export function peekHandoff(now = Date.now(), s: Store | null = store()): boolean {
  try {
    const raw = s?.getItem(KEY);
    if (!raw) return false;
    const v = JSON.parse(raw) as Partial<PendingHandoff>;
    return typeof v.chatId === "string" && typeof v.at === "number" && now - v.at <= HANDOFF_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * The pending hand-off, left in place: it is cleared only once the message
 * reached the computer (`clearHandoff`). A computer that couldn't take it yet
 * (still starting, an old daemon) gets it on the next load — on 09.10 the
 * hand-off was taken before sending and lost on the first failure.
 */
export function readHandoff(now = Date.now(), s: Store | null = store()): PendingHandoff | null {
  if (!s) return null;
  try {
    const raw = s.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PendingHandoff>;
    if (typeof v.chatId !== "string" || typeof v.at !== "number") return null;
    if (now - v.at > HANDOFF_TTL_MS || v.at > now + 60_000) return null;
    return { chatId: v.chatId, at: v.at };
  } catch {
    return null;
  }
}

/** The hand-off is done: forget it (only the same one — a newer one stays). */
export function clearHandoff(chatId: string, s: Store | null = store()): void {
  try {
    const raw = s?.getItem(KEY);
    if (!raw) return;
    const v = JSON.parse(raw) as Partial<PendingHandoff>;
    if (v.chatId === chatId) s?.removeItem(KEY);
  } catch {
    // nothing to forget
  }
}

/** The first line of a hand-off message — how the chat recognises one. */
export const UNO_AI_HANDOFF_OPENING =
  "Continue my conversation with Uno AI from before this computer existed. Don't ask again what's already settled below.";
const UNO_AI_HANDOFF_SITES_HEADER = "Already live (published by Uno AI on Uno Hosting):";

export function isUnoAiHandoff(text: string): boolean {
  return text.trimStart().startsWith(UNO_AI_HANDOFF_OPENING);
}

export interface UnoAiHandoffSummary {
  readonly goal: string | null;
  readonly sites: ReadonlyArray<{ readonly title: string | null; readonly url: string }>;
}

/**
 * What the chat shows of a hand-off message as a card: the goal and the live
 * sites (each with Open), instead of a wall of text with the address buried
 * in it. Call after `isUnoAiHandoff`.
 */
export function describeUnoAiHandoff(text: string): UnoAiHandoffSummary {
  const lines = text.split("\n");
  const goalLine = lines.find((line) => line.startsWith("My goal: "));
  const sites: Array<{ title: string | null; url: string }> = [];
  const start = lines.indexOf(UNO_AI_HANDOFF_SITES_HEADER);
  if (start !== -1) {
    for (const line of lines.slice(start + 1)) {
      if (!line.startsWith("- ")) break;
      const match = /(https:\/\/[^\s]+)\s*$/.exec(line);
      if (!match?.[1]) continue;
      const url = match[1];
      const before = line.slice(2, line.length - match[0].length).trim();
      const title = before.endsWith(":") ? before.slice(0, -1).trim() || null : null;
      sites.push({ title, url });
    }
  }
  return { goal: goalLine ? goalLine.slice("My goal: ".length).trim() || null : null, sites };
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The person asked for a personal assistant (any language we see; "teammate" was its name on 09.10). */
export function isTeammateGoal(text: string): boolean {
  return /\b(team ?mate|assistant)\b|напарник|ассистент|помощник|asistente|compañero/i.test(text);
}

/**
 * The chat is about a personal assistant: the person's first words, or Uno's
 * reason for the computer, say so. One rule for the hand-off ("You are the
 * personal assistant I asked for") and for the card's pay button (the
 * checkout opens with Uno AI in the order — computerOffer.ts).
 */
export function isAssistantChat(items: ReadonlyArray<AiItem>): boolean {
  const firstUser = items.find((i) => i.kind === "user");
  const suggest = items.findLast((i) => i.kind === "suggest");
  return isTeammateGoal(
    [
      firstUser && firstUser.kind === "user" ? firstUser.text : "",
      suggest && suggest.kind === "suggest" ? (suggest.reason ?? "") : "",
    ].join(" "),
  );
}

/**
 * The first message for the Uno on the computer: everything it needs to go on
 * without asking again. Written to the agent (English), the conversation
 * itself stays in the person's language.
 */
export function handoffPrompt(input: {
  readonly title: string;
  readonly messages: ReadonlyArray<AiChatMessage>;
  readonly sites: ReadonlyArray<AiSite> | null;
}): string {
  const items = transcriptItems(input.messages);
  const lines: string[] = [];
  lines.push(UNO_AI_HANDOFF_OPENING);
  const firstUser = items.find((i) => i.kind === "user");
  if (firstUser && firstUser.kind === "user")
    lines.push("", `My goal: ${clip(firstUser.text, 600)}`);

  const qa: string[] = [];
  items.forEach((item, idx) => {
    if (item.kind !== "ask") return;
    const answer = items.slice(idx + 1).find((x) => x.kind === "user");
    const q = item.questions[0];
    if (q && answer && answer.kind === "user")
      qa.push(`- ${clip(q.question, 200)} → ${clip(answer.text, 200)}`);
  });
  if (qa.length) lines.push("", "What I already answered:", ...qa);

  const plan = items.findLast((i) => i.kind === "plan");
  if (plan && plan.kind === "plan") {
    lines.push(
      "",
      `The plan: ${clip(plan.title, 200)}`,
      ...plan.steps.map((s) => `- ${clip(s, 200)}`),
    );
  }

  const sites = input.sites ?? [];
  if (sites.length) {
    lines.push("", UNO_AI_HANDOFF_SITES_HEADER);
    for (const s of sites) lines.push(`- ${s.title ? `${clip(s.title, 80)}: ` : ""}${s.url}`);
    lines.push(
      "Its current code: `curl -s <url>` (index.html; forms post to /__forms and arrive in my email/Telegram). To change the site, edit it and republish with the Uno CLI/API under the same address.",
    );
  }

  const suggest = items.findLast((i) => i.kind === "suggest");
  if (suggest && suggest.kind === "suggest" && suggest.reason) {
    lines.push("", `Why I need this computer: ${clip(suggest.reason, 300)}`);
  }

  const recent = items
    .filter((i) => i.kind === "user" || i.kind === "text")
    .slice(-6)
    .map((i) =>
      i.kind === "user"
        ? `Me: ${clip(i.text, 400)}`
        : i.kind === "text"
          ? `Uno: ${clip(i.text, 400)}`
          : "",
    );
  if (recent.length) lines.push("", "The last messages:", ...recent);

  // The personal assistant is the Uno on this computer itself, not something
  // to build (ICP v3 r3: the hand-off built an always-on "Dev Teammate" app
  // and asked for a GitHub token before any task).
  lines.push(
    "",
    isAssistantChat(items)
      ? "You are the personal assistant I asked for: I give you tasks here (or in my Telegram once linked), you do them on this computer while my laptop is closed and tell me in my Inbox when it's done or you need me. Don't build an app, a bot or a service for this, and don't ask for tokens or passwords until a task needs them. Now: in 1–2 sentences (in my language) say what you can do for me here as my assistant, then ask for my first task."
      : "Now: tell me in 1–2 sentences what you'll set up on this computer for this goal (in my language), then do it step by step. Ask only what you truly can't decide yourself — one question at a time.",
  );
  return lines.join("\n");
}
