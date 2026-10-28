/**
 * Variant B (28.10): an assistant of its own on every computer. Each sees
 * only its computer; a task for another computer is passed to that
 * computer's assistant (the person sees it move); the morning summary comes
 * from each one; a sleeping computer's assistant sleeps too.
 *
 * What it changes in the base: the cast (`?cast=unos|team|many|twins|long`),
 * the greeting (apps → Telegram → mode, as cards), the hand-off, the morning
 * scenes, the in-character greeting of a new assistant. The sidebar layout
 * (B1 group / B2 switcher, `?sb=group|switcher`) is read by the real
 * components through `components/assistants/perMachine.ts`.
 */
import { ASSISTANT_PROJECT_ID } from "@t3tools/contracts";

import type { ChatSpec, MachineKey } from "../heavyFixtures";
import { MACHINES } from "../heavyFixtures";
import { type DemoPersona, DEMO_PERSONAS } from "./fixtures";
import {
  type Script,
  type ScriptContext,
  addScene,
  addTrigger,
  assistantLabel,
  connectorsCard,
  machineName,
  play,
  setAssistantLabel,
  setGreeting,
  setStopCheck,
  removeScene,
} from "./engine";
import { isRevoked, setPreset, telegramLinked as daemonTelegramLinked } from "./daemon";
import { WORLD, macOnline } from "./world";

export const VARIANT: { readonly id: string; readonly title: string } = {
  id: "b",
  title: "B · свой ассистент на каждой машине",
};

// ── Who lives where ──────────────────────────────────────────────────────

const persona = (
  machine: MachineKey,
  name: string,
  emoji: string,
  tone: string,
  role: string,
  character: string,
  history: ReadonlyArray<readonly ["user" | "assistant", string]> = [],
): DemoPersona => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const projectId = `assistant-${slug}`;
  const chat: ChatSpec = {
    id: `${machine}-${slug}-main`,
    machine,
    project: projectId,
    title: name,
    minutesAgo: 60 * 5,
    state: "read",
    role: "assistant",
    messages: history.length
      ? history
      : [
          [
            "assistant",
            `Hi, I'm ${name}. I keep an eye on things here on ${machineName(machine)}.`,
          ],
        ],
  };
  return {
    projectId,
    machine,
    name,
    emoji,
    tone,
    roles: [role],
    character,
    duties: [],
    setUp: true,
    chats: [chat],
  };
};

const MIA = (machine: MachineKey) =>
  persona(machine, "Mia", "🦉", "amber", "Secretary", "Brief, warm, careful", [
    ["user", "Move my 11:00 with Dana if it clashes."],
    ["assistant", "Your 11:00 moved to 15:00. I told Dana you're fine with it."],
  ]);

/** The sleeping free-cloud's assistants (this browser saw them last). */
export const ASLEEP_CAST: Record<
  "mac" | "product",
  Array<Pick<DemoPersona, "projectId" | "name" | "emoji" | "tone">>
> = {
  mac: [],
  product: [],
};

function cast() {
  const add = (item: DemoPersona) => DEMO_PERSONAS.push(item);
  switch (WORLD.cast) {
    case "team":
      add(MIA("work"));
      add(persona("mac", "Bolt", "🤖", "sky", "Developer", "Direct, brief, nerdy"));
      break;
    case "many":
      add(MIA("work"));
      add(persona("work", "Leo", "🦊", "orange", "Marketer", "Playful, bold, chatty"));
      add(persona("work", "Nova", "👽", "violet", "Researcher", "Curious, careful"));
      add(persona("work", "Juno", "🐼", "teal", "Support", "Patient, warm, formal"));
      add(persona("mac", "Bolt", "🤖", "sky", "Developer", "Direct, brief, nerdy"));
      add(persona("mac", "Pixel", "🐱", "rose", "Designer", "Playful, curious"));
      add(persona("mac", "Sage", "🧙", "emerald", "Researcher", "Careful, formal"));
      ASLEEP_CAST.product.push(
        { projectId: "assistant-rex", name: "Rex", emoji: "🦖", tone: "orange" },
        { projectId: "assistant-ivy", name: "Ivy", emoji: "🌿", tone: "emerald" },
      );
      break;
    case "twins":
      add(MIA("work"));
      add(
        persona("mac", "Mia", "🐈", "rose", "Secretary", "Brief, playful", [
          ["user", "Tidy my Downloads folder every Friday."],
          ["assistant", "Done for this week: 41 files into Archive/2026-10."],
        ]),
      );
      break;
    case "long":
      add(
        persona(
          "work",
          "Professor Bartholomew Fizzlewick, Keeper of All Invoices",
          "🧙",
          "emerald",
          "Bookkeeper",
          "Formal, careful",
        ),
      );
      break;
    default:
      break;
  }
  // A sleeping MacBook doesn't answer: its assistants come from what this browser saw.
  if (!macOnline(WORLD)) {
    for (const item of DEMO_PERSONAS.filter((p) => p.machine === "mac")) {
      ASLEEP_CAST.mac.push({
        projectId: item.projectId,
        name: item.name,
        emoji: item.emoji,
        tone: item.tone,
      });
    }
  }
}
cast();

/** The last-known lists of sleeping computers, for the demo's fresh browser. */
export function lastKnownSeed(): Record<string, unknown> {
  const uno = { projectId: ASSISTANT_PROJECT_ID, name: "Uno", emoji: null, tone: "violet" };
  const seed: Record<string, unknown> = {};
  if (WORLD.account === "live") {
    seed[`box:${MACHINES.product.boxId}`] = [uno, ...ASLEEP_CAST.product];
    if (!macOnline(WORLD)) seed[MACHINES.mac.environmentId] = [uno, ...ASLEEP_CAST.mac];
  }
  return seed;
}

// ── Names: "Uno · MacBook" ───────────────────────────────────────────────

setAssistantLabel((ctx) => `${ctx.persona.name} · ${machineName(ctx.machine)}`);
const full = (machine: MachineKey, name = "Uno") => `${name} · ${machineName(machine)}`;

// ── First run: hello → apps → Telegram (one bot) → the mode → "what's burning" ──

function telegramCardB(ctx: ScriptContext, after: Script): Script {
  if (daemonTelegramLinked(ctx.machine, ctx.persona.projectId)) {
    return [{ say: "We're linked in Telegram already — @uno_team_bot." }, ...after];
  }
  return [
    {
      ask: "Want me in Telegram too? I'll write there only for decisions and the morning summary.",
      question: {
        id: "telegram",
        header: "Telegram",
        question: "One bot for all your assistants",
        detail:
          "@uno_team_bot — press Start and that's it. Each assistant signs its messages (“Uno · MacBook: …”); reply to a message to answer that one.",
        options: [
          { label: "Connect Telegram", description: "Open the bot and press Start" },
          { label: "Not now", description: "Only here in Work" },
        ],
        skippable: true,
      },
      then: (answer, inner) =>
        /connect/i.test(answer)
          ? [
              { work: "Waiting for you to press Start in Telegram…", delay: 600 },
              {
                run: () => inner.ops.setTelegram(inner.machine, inner.persona.projectId, true),
                delay: 2200,
              },
              {
                say: "Linked: @uno_team_bot. Your other assistants will write there too, each under its own name.",
              },
              ...after,
            ]
          : [{ say: "OK — I'm here whenever you open Work." }, ...after],
    },
  ];
}

function modeCard(ctx: ScriptContext, after: Script): Script {
  return [
    {
      ask: "One last thing: how should I work?",
      question: {
        id: "mode",
        header: "How I work",
        question: "How should I work?",
        detail:
          "Change it any time on my page. It's only for me — your other assistants have their own.",
        options: [
          { label: "Does it itself", description: "Acts right away, tells you after" },
          { label: "Asks first", description: "Shows what it's about to do, waits for your Allow" },
        ],
      },
      then: (answer, inner) =>
        /asks/i.test(answer)
          ? [
              { run: () => setPreset(inner.machine, inner.persona.projectId, "helper") },
              {
                say: "Done. Before I send, pay, delete or publish anything, I'll show it with an Allow button — here and in Telegram.",
              },
              ...after,
            ]
          : [
              { run: () => setPreset(inner.machine, inner.persona.projectId, "full") },
              { say: "Done. I'll act and tell you after." },
              ...after,
            ],
    },
  ];
}

const ROLE_LINE: Record<string, string> = {
  secretary:
    "I'll keep your mail and calendar in order. Want me to check today's calendar for clashes?",
  marketer: "I'll watch your posts and tell you what works. Want a look at last week's numbers?",
  developer: "I'll watch your repos and CI here. Want me to check what's red right now?",
  researcher: "Give me a question — I'll come back with sources and a short answer.",
  support:
    "I'll answer your customers and pass you only the tricky ones. Where do they write to you?",
};

/** A new assistant writes first, in its role and character (Grok-like). */
function inCharacter(ctx: ScriptContext): Script {
  const role = (ctx.persona.roles[0] ?? "").trim();
  const character = ctx.persona.character.toLowerCase();
  const playful = /playful|chatty|funny/.test(character);
  const brief = /brief|direct/.test(character);
  const where = machineName(ctx.machine);
  const hello = playful ? `Hey! ${ctx.persona.name} here` : `Hi, I'm ${ctx.persona.name}`;
  const job = role ? `your ${role.toLowerCase()} on ${where}` : `your assistant on ${where}`;
  const line =
    ROLE_LINE[role.toLowerCase()] ?? "Tell me what you'd like off your plate — a line is enough.";
  return [
    {
      say: brief
        ? `${hello} — ${job}. I see only ${where}. ${line}`
        : `${hello} — ${job}${playful ? " 🎉" : "."} I live on ${where} and see only it: its files, chats and apps. ${line}`,
      delay: 900,
    },
  ];
}

setGreeting((ctx) => {
  if (ctx.persona.projectId !== ASSISTANT_PROJECT_ID) return inCharacter(ctx);
  const where = machineName(ctx.machine);
  return [
    {
      say: `Hi, I'm Uno — the assistant of this computer, ${where}. I see its files, chats and apps, and I'm on when you're not. Each computer you add gets its own Uno.`,
      delay: 900,
    },
    ...connectorsCard(ctx, [
      ...telegramCardB(ctx, [
        ...modeCard(ctx, [
          { say: "So — what's burning today? Tell me in a line, or say “morning summary”." },
        ]),
      ]),
    ]),
  ];
});

// ── A task for another computer: passed to its own assistant ─────────────

const DECK_TASK = "Export the pitch deck to PDF and put it in Downloads.";

function openChat(machine: MachineKey, threadId: string) {
  location.hash = `#/${MACHINES[machine].environmentId}/${threadId}`;
}

/** Uno · MacBook works on what it was passed: steps, then the result (or the failure). */
function macWorks(threadId: string): Script {
  const fail = WORLD.macjob === "fail";
  return [
    { work: "Opening pitch-deck (14 slides)…", delay: 1400 },
    { work: "Exporting to PDF… 60%", delay: 1500 },
    ...(fail
      ? [
          {
            inbox: {
              id: `i-mac-fail-${threadId}`,
              kind: "agent.error" as const,
              chat: threadId,
              title: "Uno · MacBook couldn't export the deck",
              body: "Keynote isn't installed. Nothing was changed.",
            },
          },
          {
            fail: "Keynote isn't on this MacBook, so the deck couldn't be exported. Nothing was changed — install Keynote, or ask Uno · uno-work to export it from GitHub.",
            delay: 1500,
          } as const,
        ]
      : [
          { say: "Done: pitch-deck.pdf (2.1 MB) is in ~/Downloads on the MacBook.", delay: 1400 },
          {
            inbox: {
              id: `i-mac-done-${threadId}`,
              kind: "agent.done" as const,
              chat: threadId,
              title: "Uno · MacBook: pitch-deck.pdf is ready",
              body: "In ~/Downloads on the MacBook. Passed to it by Uno · uno-work.",
            },
          },
        ]),
  ];
}

function doHere(ctx: ScriptContext): Script {
  return [
    {
      elsewhere: {
        machine: ctx.machine,
        projectId: "p-work-landing",
        title: "Export the pitch deck to PDF",
        prompt: "Clone pitch-deck from GitHub and export it to PDF.",
        steps: ["Cloning github.com/misha-demo/pitch-deck…", "Exporting 14 slides…"],
        result: "pitch-deck.pdf (2.1 MB) is in Files → Downloads on uno-work.",
      },
    },
  ];
}

function passToMac(ctx: ScriptContext): Script {
  if (!macOnline(ctx.world)) {
    return [
      {
        say: "Uno · MacBook is asleep — the laptop is closed. The task waits for it in Needs you and starts when the laptop opens.",
      },
      {
        inbox: {
          id: `i-wait-mac-${Date.now()}`,
          kind: "agent.input",
          chat: ctx.threadId,
          title: "Waiting for MacBook: Export the pitch deck",
          body: "Uno · MacBook starts it when the laptop opens.",
        },
      },
    ];
  }
  const threadId = `mac-handoff-${Date.now().toString(36)}`;
  return [
    {
      run: (inner) => {
        inner.ops.createThread("mac", {
          threadId,
          projectId: ASSISTANT_PROJECT_ID,
          title: "Export the pitch deck",
        });
        inner.ops.userSays("mac", threadId, `↪ Passed from ${full(inner.machine)}: ${DECK_TASK}`);
      },
    },
    {
      say: "Passed to Uno · MacBook — it works there now. I can't see the MacBook, so follow it in its chat; the result also lands in Needs you.",
      delay: 700,
    },
    {
      run: () => {
        openChat("mac", threadId);
        void play("mac", threadId, macWorks(threadId));
      },
      delay: 900,
    },
  ];
}

function handoff(ctx: ScriptContext): Script {
  const asleep = !macOnline(ctx.world);
  return [
    {
      ask: asleep
        ? "The deck is on your MacBook, and I only see uno-work. Its own assistant, Uno · MacBook, is asleep — the laptop is closed."
        : "The deck is on your MacBook, and I only see uno-work. The MacBook has its own assistant — Uno · MacBook.",
      question: {
        id: "handoff",
        header: "Another computer",
        question: "Who should do it?",
        options: [
          asleep
            ? { label: "Leave it for Uno · MacBook", description: "Starts when the laptop opens" }
            : {
                label: "Pass it to Uno · MacBook",
                description: "It works there; you follow it in its chat",
              },
          { label: "Do it here instead", description: "I take the deck from GitHub on uno-work" },
        ],
      },
      then: (answer, inner) => (/here/i.test(answer) ? doHere(inner) : passToMac(inner)),
    },
  ];
}

addTrigger({
  id: "b-elsewhere",
  match: /\bmac\b|macbook|deck|other computer|другом|маке/i,
  script: (ctx) =>
    ctx.machine === "mac"
      ? [{ work: "Opening pitch-deck here…" }, ...macWorks(ctx.threadId)]
      : handoff(ctx),
});

// ── The morning: one summary from each assistant ─────────────────────────

function workSummary(ctx: ScriptContext): Script {
  const gmail = ctx.ops.connectorState("gmail");
  const free = ctx.world.tier === "free";
  const lines = [
    gmail === "on" ? "• Mail: Acme hasn't paid invoice #1042 (5 days late)." : null,
    gmail === "on" ? "• Calendar: call with Dana at 15:00." : null,
    gmail === "expired" ? "• Mail: Gmail ended its sign-in — I couldn't read it." : null,
    "• orders-bot: 212 orders exported to Drive at 07:00.",
  ].filter(Boolean);
  return [
    { work: "Reading mail, calendar and uno-work's projects…" },
    {
      say: `${free ? "uno-work was asleep at 08:00 (Free), so here's your summary now. " : "Good morning. "}From uno-work:\n${lines.join("\n")}`,
    },
    {
      inbox: {
        id: `i-sum-work-${Date.now()}`,
        kind: "agent.done",
        chat: ctx.threadId,
        title: "Uno · uno-work: your morning summary",
        body: daemonTelegramLinked(ctx.machine, ctx.persona.projectId)
          ? "Acme is 5 days late · Dana at 15:00 · 212 orders. Also in Telegram."
          : "Acme is 5 days late · Dana at 15:00 · 212 orders.",
      },
    },
  ];
}

function macSummary(threadId: string): Script {
  return [
    { work: "Looking at the MacBook's projects…" },
    {
      say: "Good morning. From this MacBook:\n• landing: the build is green again.\n• pitch-deck: slide 7 still says September.",
    },
    {
      inbox: {
        id: `i-sum-mac-${threadId}`,
        kind: "agent.done",
        chat: threadId,
        title: "Uno · MacBook: your morning summary",
        body: "landing build green · slide 7 still says September.",
      },
    },
  ];
}

// B's own morning and hand-off replace the base's (one Uno that sees every computer).
removeScene("morning");
removeScene("elsewhere");

addScene({
  id: "b-morning",
  title: "B · Утренняя сводка от каждого",
  hint: "Сводка приходит от каждого ассистента отдельно: uno-work в свой чат, MacBook в свой (или «спит — придёт, когда откроешь ноутбук»), free-cloud проспал (Free). В Needs you — по карточке с подписью машины.",
  run: ({ ops, target, play: playHere, world }) => {
    void playHere(workSummary({ ...target, ops, world }));
    if (macOnline(world)) {
      const macThread = mainChat("mac");
      if (macThread) void play("mac", macThread, macSummary(macThread));
    } else {
      ops.addInbox({
        id: `i-sum-mac-asleep-${Date.now()}`,
        machine: "work",
        kind: "app",
        title: "Uno · MacBook is asleep — no summary yet",
        body: "It sends its summary when the laptop opens.",
      });
    }
    if (world.account === "live") {
      ops.addInbox({
        id: `i-sum-free-${Date.now()}`,
        machine: "work",
        kind: "app",
        title: "Uno · free-cloud slept through 08:00",
        body: "free-cloud is on Free and sleeps when nobody uses it. Plus keeps it on.",
      });
    }
  },
});

addScene({
  id: "b-handoff",
  title: "B · Задача на MacBook через соседа",
  hint: "Просишь Uno · uno-work про колоду на Маке — он видит только свою машину и предлагает передать Uno · MacBook. «Pass it» открывает чат на Маке, там шаги; итог — в его чате и в Needs you. При macjob=fail — честная ошибка там же.",
  run: ({ ops, target, play: playHere, world }) => {
    ops.userSays(target.machine, target.threadId, "Export the deck on my Mac");
    void playHere(handoff({ ...target, ops, world }));
  },
});

/** The demo's main chat of an assistant (made on first use). */
let mainChat: (machine: MachineKey, projectId?: string) => string | null = () => null;
export function setMainChatLookup(fn: (machine: MachineKey, projectId?: string) => string) {
  mainChat = fn;
}

// A removed assistant stops where it is (its turn ends with a clear line).
setStopCheck((ctx) =>
  isRevoked(ctx.machine, ctx.persona.projectId)
    ? `Stopped: ${assistantLabel(ctx)} was removed. Nothing more was done.`
    : null,
);

// ── Long tasks (to change the mode or remove an assistant while it works) ──

addTrigger({
  id: "b-research",
  match: /compare|research|suppliers|сравни/i,
  script: () => [
    { work: "Reading 12 supplier sites…", delay: 1500 },
    { work: "Checking reviews on 3 marketplaces…", delay: 3000 },
    { work: "Comparing prices and delivery times…", delay: 3000 },
    { work: "Writing it up…", delay: 3000 },
    {
      say: "Three suppliers compared. The cheapest one has bad reviews — Brightline is the safe pick.",
      delay: 2000,
    },
  ],
});

addTrigger({
  id: "b-invoices",
  match: /invoices|счета/i,
  script: () => [
    { work: "Collecting October's unpaid invoices from Gmail…", delay: 1500 },
    {
      work: "3 found: Acme #1042, Brightline #1051, Northwind #1055. Drafting reminders…",
      delay: 3500,
    },
    { work: "Drafts ready.", delay: 3500 },
    {
      act: {
        command: "Send 3 reminders — Acme, Brightline, Northwind",
        why: "They go out from your Gmail, to clients.",
      },
      allowed: [{ say: "Sent 3 reminders. I'll tell you when someone pays." }],
      declined: [{ say: "Not sending. The 3 drafts stay in Gmail → Drafts." }],
      delay: 3000,
    },
  ],
});
