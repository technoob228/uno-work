/**
 * Variant C: a new teammate writes first, in character. Who it is in one
 * line (in its voice: Brief / Chatty / Playful / Formal / Warm…), that it
 * works under Uno, and one concrete first offer for its role from the demo
 * world (Acme's late invoice, the 15:00 call with Dana, the landing and
 * orders-bot projects, the pitch deck on the MacBook) — a quiz card with
 * two first tasks, each a short piece of work and a result.
 *
 * Pure: builds scripts, nothing runs at import. variant.ts calls it from
 * `setGreeting` for everyone but Uno.
 */
import type { Script, ScriptContext, Step } from "../engine";
import { macOnline } from "../world";

/** How it talks, from the words of its character ("Warm · Brief · Careful"). */
export interface Voice {
  readonly brief: boolean;
  readonly chatty: boolean;
  readonly playful: boolean;
  readonly formal: boolean;
  readonly warm: boolean;
  readonly funny: boolean;
}

export function voiceOf(character: string): Voice {
  const words = new Set(
    character
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter(Boolean),
  );
  const brief = words.has("brief") || words.has("short") || words.has("direct");
  return {
    brief,
    chatty: !brief && words.has("chatty"),
    playful: words.has("playful"),
    formal: words.has("formal") && !words.has("playful"),
    warm: words.has("warm") || words.has("patient"),
    funny: words.has("funny"),
  };
}

export type RoleKind = "secretary" | "marketer" | "developer" | "researcher" | "support" | "custom";

export function roleKindOf(role: string | undefined): RoleKind {
  const value = (role ?? "").toLowerCase();
  if (/secretar|assistant to|calendar/.test(value)) return "secretary";
  if (/market|growth|seo|content/.test(value)) return "marketer";
  if (/develop|engineer|coder|programm/.test(value)) return "developer";
  if (/research|analyst/.test(value)) return "researcher";
  if (/support|customer|care/.test(value)) return "support";
  return "custom";
}

const JOKES: Readonly<Record<RoleKind, string>> = {
  secretary: "I guard your calendar like it's the last free table on a Friday.",
  marketer: "Fair warning: I think in headlines.",
  developer: "I write tests. Most of the time.",
  researcher: "I read the footnotes so you don't have to.",
  support: "“Where's my order?” never gets old for me.",
  custom: "New job, fresh coffee.",
};

/** Its first line: who it is and that it works under Uno, in its voice. */
export function introLine(name: string, role: string, voice: Voice, kind: RoleKind): string {
  const roleWord = role.toLowerCase();
  const underUno = "I report to Uno — give me tasks here, or just tell Uno.";
  if (voice.brief) {
    return `${name}, your ${roleWord}. ${underUno}`;
  }
  if (voice.formal) {
    return `Hello, I'm ${name}, your ${roleWord}. I report to Uno: you can give me tasks here, or simply tell Uno and it will pass them on.`;
  }
  const lines = [
    voice.chatty || voice.warm
      ? `Hi! I'm ${name}, your new ${roleWord}. Glad to be on the team.`
      : `Hi, I'm ${name}, your ${roleWord}.`,
    voice.chatty
      ? "I report to Uno — give me tasks here, or just tell Uno and it'll pass them to me. Either way you'll hear back from me."
      : underUno,
  ];
  if (voice.playful || voice.funny) lines.push(JOKES[kind]);
  return lines.join("\n\n");
}

interface Offer {
  /** What it noticed and offers (the quiz card's line). */
  readonly line: string;
  readonly options: readonly [Choice, Choice];
}

interface Choice {
  readonly label: string;
  readonly description: string;
  readonly script: (ctx: ScriptContext) => Script;
}

function acmeReminder(ctx: ScriptContext): Script {
  const gmail = ctx.ops.connectorState("gmail");
  if (gmail !== "on") {
    return [
      {
        say: "Gmail isn't connected, so I can't send it. Connect it in Settings → Connectors (Uno's apps are mine too) and I'll send it right away.",
      },
    ];
  }
  return [
    { work: "Reading the Acme thread in Gmail…" },
    { work: "Drafting “Invoice #1042 — a gentle reminder”…" },
    {
      act: {
        command: "Send an email to billing@acme.example — “Invoice #1042 — a gentle reminder”",
        why: "It goes out from your Gmail, to a client.",
      },
      allowed: [
        {
          say: "Sent to billing@acme.example. I told Uno — it'll mention their answer in your summary.",
        },
      ],
      declined: [{ say: "OK, not sending. The draft is in Gmail → Drafts." }],
    },
  ];
}

function offerFor(kind: RoleKind, role: string): Offer {
  switch (kind) {
    case "secretary":
      return {
        line: "First thing I see: Acme's invoice #1042 is 5 days late, and you have a call with Dana at 15:00. Where do I start?",
        options: [
          {
            label: "Remind Acme",
            description: "A polite reminder about invoice #1042",
            script: acmeReminder,
          },
          {
            label: "Prep the 15:00 call",
            description: "A short brief on Dana before the call",
            script: () => [
              { work: "Reading your last emails with Dana…" },
              {
                say: "Brief for 15:00 with Dana:\n\n- She asked for the October numbers — slide 7 has them: $190 MRR, 12 paying.\n- Open question: the pilot start date.\n\nI'll remind you at 14:50.",
              },
            ],
          },
        ],
      };
    case "marketer":
      return {
        line: "I looked at the landing: it says what Uno is, not who it's for. Want three headlines to test, or this week's post?",
        options: [
          {
            label: "Write 3 headlines",
            description: "For the landing's hero",
            script: () => [
              { work: "Reading github.com/misha-demo/landing…" },
              {
                say: "Three to test:\n\n1. A computer for your AI agents. Always on.\n2. Your agents work while you sleep.\n3. One place for your agents, apps and files.\n\nWant me to open a PR with the first one as an A/B test?",
              },
            ],
          },
          {
            label: "Draft this week's post",
            description: "For your blog and X",
            script: () => [
              { work: "Looking at what worked last week…" },
              {
                say: "Draft is in Drive → Posts: “212 orders, zero spreadsheets” — how the orders-bot exports every morning. 140 words, one picture.",
              },
            ],
          },
        ],
      };
    case "developer":
      return {
        line: "orders-bot exports 212 orders every morning, and nothing tests that export. Add a test, or look at the landing build first?",
        options: [
          {
            label: "Test the export",
            description: "orders-bot, on uno-work",
            script: () => [
              { work: "Running orders-bot tests on uno-work…" },
              { work: "Writing 4 cases for the daily export…" },
              {
                say: "Added tests for the daily export: 4 cases, all green. Branch test/export, PR is up on github.com/misha-demo/orders-bot.",
              },
            ],
          },
          {
            label: "Check the landing build",
            description: "It failed on the MacBook overnight",
            script: () => [
              { work: "Building the landing on uno-work…" },
              {
                say: "Build is green. It broke on a missing /public/hero.webp — Uno already put it back. I added a check so a missing image fails the PR, not the deploy.",
              },
            ],
          },
        ],
      };
    case "researcher":
      return {
        line: "Your pitch deck is on the MacBook — slide 7 says $190 MRR. Want me to find 3 companies like yours and their numbers, or investors who back them?",
        options: [
          {
            label: "Compare 3 competitors",
            description: "Prices, users, what they raised",
            script: (ctx) => [
              { work: "Reading 14 sources…" },
              { work: "Checking prices and funding rounds…" },
              {
                say: `Three closest:\n\n- **Boxly** — sandboxes by the second, from 29 dollars a month.\n- **Shellhouse** — dev environments, free tier, sleeps after 30 min.\n- **Agentyard** — GPU-first, pay per second.\n\nNone keeps a computer on for your agents. Table is in Drive → Research${macOnline(ctx.world) ? "; I can add it to the deck on the MacBook" : ""}.`,
              },
            ],
          },
          {
            label: "Find investors",
            description: "Who backs dev tools at seed",
            script: () => [
              { work: "Looking at seed rounds in dev tools this year…" },
              {
                say: "12 funds that led seed rounds in agent infra this year. Top 3 with warm paths are first. List is in Drive → Research → Investors.",
              },
            ],
          },
        ],
      };
    case "support":
      return {
        line: "orders-bot had 212 orders yesterday, and customer mail is piling up in Gmail. Answer today's mail, or write a FAQ from past answers?",
        options: [
          {
            label: "Answer today's mail",
            description: "From your Gmail",
            script: () => [
              { work: "Reading 9 customer emails…" },
              {
                say: "Answered 6. Two ask about delivery dates — drafts are in Gmail. One wants a refund — that one's yours, it's in Needs you.",
              },
            ],
          },
          {
            label: "Write a FAQ",
            description: "From the last month of answers",
            script: () => [
              { work: "Reading a month of answers…" },
              {
                say: "FAQ with 8 questions is in Drive → Support. The top one: “When does my order ship?” — 31% of all mail.",
              },
            ],
          },
        ],
      };
    case "custom":
      return {
        line: `What's the first thing a ${role.toLowerCase()} should take off your plate? Or I can start with Acme's invoice #1042 — it's 5 days late.`,
        options: [
          {
            label: "Chase the Acme invoice",
            description: "#1042, 5 days late",
            script: acmeReminder,
          },
          {
            label: "I'll tell you",
            description: "Write it here",
            script: () => [{ say: "Listening — tell me in a line and I'll start." }],
          },
        ],
      };
  }
}

/** What a new teammate says first: hello in character, then its first task as a quiz card. */
export function teammateGreeting(ctx: ScriptContext): Script {
  const { persona } = ctx;
  const role = persona.roles[0]?.trim() || "assistant";
  const kind = roleKindOf(role);
  const voice = voiceOf(persona.character);
  const offer = offerFor(kind, role);
  const ask: Step = {
    ask: voice.brief ? offer.line.replace(/^First thing I see: /, "") : offer.line,
    question: {
      id: `first-task-${persona.projectId}`,
      header: "First task",
      question: "What should I start with?",
      options: offer.options.map(({ label, description }) => ({ label, description })),
    },
    then: (answer, inner) => {
      const picked =
        offer.options.find(
          (option) => option.label.toLowerCase() === answer.trim().toLowerCase(),
        ) ?? offer.options[0];
      return picked.script(inner);
    },
  };
  return [{ say: introLine(persona.name, role, voice, kind), delay: 900 }, ask];
}
