/**
 * "Continue on my computer": a Uno AI chat (no computer) moves to the Uno on
 * the person's computer once it exists.
 *
 * Before the computer is created, the chat id is remembered here (the browser
 * app and the computer's Uno Work share app.uno4.work, so one localStorage);
 * the computer's Home picks it up on its first load, reads the chat from the
 * account and starts a chat with Uno there whose first message carries the
 * whole context: the goal, the answers, the plan, the live site, what the
 * person wants next. Pure parts are unit-tested.
 */
import type { AiChatMessage, AiSite } from "./unoAiApi";
import { transcriptItems } from "./unoAiModel";

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

/** The pending hand-off, removed as it is read (it runs once). */
export function takeHandoff(now = Date.now(), s: Store | null = store()): PendingHandoff | null {
  if (!s) return null;
  let raw: string | null = null;
  try {
    raw = s.getItem(KEY);
    if (raw !== null) s.removeItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PendingHandoff>;
    if (typeof v.chatId !== "string" || typeof v.at !== "number") return null;
    if (now - v.at > HANDOFF_TTL_MS || v.at > now + 60_000) return null;
    return { chatId: v.chatId, at: v.at };
  } catch {
    return null;
  }
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
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
  lines.push(
    "Continue my conversation with Uno AI from before this computer existed. Don't ask again what's already settled below.",
  );
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
    lines.push("", "Already live (published by Uno AI on Uno Hosting):");
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

  lines.push(
    "",
    "Now: tell me in 1–2 sentences what you'll set up on this computer for this goal (in my language), then do it step by step. Ask only what you truly can't decide yourself — one question at a time.",
  );
  return lines.join("\n");
}
