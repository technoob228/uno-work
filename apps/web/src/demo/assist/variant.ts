/**
 * Variant A (28.10): one Uno for the whole account, like Claude Duet.
 *
 * - Uno lives on the cloud computer that doesn't sleep (uno-work on Plus) and
 *   sees every computer and connector of the account; the other computers are
 *   its hands — it hands tasks out itself.
 * - Topics are channels ("Everything" + "New channel"), one memory.
 * - Your own assistants are in Advanced (the Grok-style gallery / builder);
 *   each speaks first, in character.
 * - On Free the cloud computer sleeps: a summary when you open Work, messages
 *   wait; an honest line and the way to Plus.
 *
 * Scripts here; the screens are the real components (sidebar, chat header,
 * Uno's page, Inbox, Settings → Connectors, the gallery).
 */
import { ASSISTANT_PROJECT_ID } from "@t3tools/contracts";

import { DEMO_PERSONAS, type DemoPersona } from "./fixtures";
import {
  type Script,
  type ScriptContext,
  acmeDecision,
  addScene,
  addTrigger,
  connectorsCard,
  machineName,
  otherComputerTask,
  setChannelGreeting,
  setGreeting,
  telegramCard,
} from "./engine";
import { WORLD, macOnline, thirdOnline } from "./world";

export const VARIANT: { readonly id: string; readonly title: string } = {
  id: "a",
  title: "Вариант A · один Uno на аккаунт",
};

const isUno = (ctx: ScriptContext) => ctx.persona.projectId === ASSISTANT_PROJECT_ID;
const free = () => WORLD.tier === "free";

// ── A heavy account (`many=on`): 10 own assistants ───────────────────────

const MANY: ReadonlyArray<readonly [string, string, string]> = [
  ["Mia", "🦉", "Secretary"],
  ["Leo", "🦊", "Marketer"],
  ["Bolt", "🤖", "Developer"],
  ["Nova", "👽", "Researcher"],
  ["Juno", "🐼", "Support"],
  ["Rex", "🐯", "Sales"],
  ["Ivy", "🌿", "Bookkeeper"],
  ["Otto", "🐙", "Ops"],
  ["Sage", "🧠", "Coach"],
  ["Pixel", "👾", "Designer"],
];
if (WORLD.account === "live" && WORLD.many === "on") {
  MANY.forEach(([name, emoji, role], index) => {
    const persona: DemoPersona = {
      projectId: `assistant-${name.toLowerCase()}`,
      machine: "work",
      name,
      emoji,
      tone: ["amber", "orange", "sky", "violet", "teal", "rose", "emerald", "slate"][index % 8]!,
      roles: [role],
      character: "Brief · Warm",
      duties: [],
      setUp: true,
      chats: [],
    };
    DEMO_PERSONAS.push(persona);
  });
}

// ── First run: Uno talks first ───────────────────────────────────────────

/** The mode card: two modes, nothing else (Misha 27.10). */
function modeCard(ctx: ScriptContext, after: Script): Script {
  return [
    {
      ask: "One thing before I start: how should I work?",
      question: {
        id: "mode",
        header: "Mode",
        question: "How should I work?",
        detail: "Change it any time at the top of the chat.",
        options: [
          { label: "Does it itself", description: "Acts right away and tells you after" },
          { label: "Asks first", description: "Shows what it's about to do, waits for your Allow" },
        ],
      },
      then: (answer, inner) => {
        const asks = /ask/i.test(answer);
        return [
          { run: () => inner.ops.setMode(inner.machine, inner.persona.projectId, asks) },
          {
            say: asks
              ? `Done. Before I send, pay, publish or delete anything, I'll show it with an Allow button — here${inner.ops.telegramLinked(inner.machine, inner.persona.projectId) ? " and in Telegram" : ""}.`
              : "Done. I'll act and tell you after. Want a check first sometimes? Switch to Asks first at the top.",
          },
          ...after,
        ];
      },
    },
  ];
}

function unoIntro(ctx: ScriptContext): Script {
  const sleeps = free();
  return [
    {
      say: sleeps
        ? "Hi Misha, I'm Uno. I live on your cloud computer, uno-work, and I can work on any of your computers. On Free it naps when you're away — I catch up the moment you open Work."
        : "Hi Misha, I'm Uno. I live on your cloud computer, uno-work, so I'm up even when your laptop is closed. I can work on any of your computers.",
      delay: 900,
    },
    ...connectorsCard(ctx, [
      ...telegramCard(ctx, [
        ...modeCard(ctx, [
          {
            say: "Now tell me what's on fire, where you're heading, and what you'd like off your plate. A couple of lines is fine.",
          },
        ]),
      ]),
    ]),
  ];
}

const ROLE_OPENER: Record<string, string> = {
  Secretary:
    "I keep your inbox and calendar in order, so you don't have to. Can I look at this week's calendar first?",
  Marketer: "Tuesday's post got 3× the clicks. Want two more like it by Friday?",
  Developer: "Point me at a repo and I'll start with whatever is red in CI.",
  Researcher: "Give me a question and a deadline — I'll come back with sources, not guesses.",
  Support: "Send me your support inbox. I answer what I can and bring you the rest.",
};

/** An own assistant's first words — in character, with its role. */
function personaIntro(ctx: ScriptContext): Script {
  const { persona } = ctx;
  const role = persona.roles[0] ?? "assistant";
  const playful = /playful|funny|chatty/i.test(persona.character);
  const brief = /brief|direct/i.test(persona.character);
  const hello = playful ? `Hey Misha! ${persona.name} here` : `Hi Misha, ${persona.name} here`;
  const opener =
    ROLE_OPENER[role] ??
    `I'm your ${role.toLowerCase()}. Tell me the first thing you want off your plate.`;
  const lines: Script = [
    {
      say: brief ? `${hello}. ${opener}` : `${hello} — your ${role.toLowerCase()}. ${opener}`,
      delay: 700,
    },
  ];
  if (role === "Secretary" && ctx.ops.connectorState("gmail") !== "on") {
    return [...lines, ...connectorsCard(ctx)];
  }
  return lines;
}

setGreeting((ctx) => (isUno(ctx) ? unoIntro(ctx) : personaIntro(ctx)));

setChannelGreeting((_ctx, title) => [
  {
    say: `This is #${title}. Anything about ${title} goes here — I'll keep it out of Everything. Same me, same memory.`,
    delay: 500,
  },
]);

// ── Every day ────────────────────────────────────────────────────────────

/** 08:00 (Plus) — or the moment Work opens (Free): three things, then "what first". */
function morning(ctx: ScriptContext, opts: { readonly wake: boolean }): Script {
  const gmail = ctx.ops.connectorState("gmail");
  const items: string[] = [];
  if (gmail === "on") {
    items.push("**Acme's invoice #1042 is 5 days late.** A friendly reminder is drafted.");
    items.push("**11:00 and 11:30 overlap today.** The dentist and the call with Dana.");
  } else if (gmail === "expired") {
    items.push("**Gmail ended its sign-in** — I can't see today's mail until you reconnect.");
  }
  items.push(
    macOnline(ctx.world)
      ? "**Landing: tests went green overnight** on the MacBook. Launch checklist 4 of 6."
      : "**Your MacBook is asleep.** Its chats wait; everything else runs here on uno-work.",
  );
  if (thirdOnline(ctx.world)) items.push("**Newsletter #14 is drafted** on free-cloud.");
  const list = items.map((item, index) => `${index + 1}. ${item}`).join("\n");
  const head = opts.wake
    ? `Morning, Misha. uno-work was asleep from 19:10 to 09:12 — I caught up while it woke. ${items.length} things:`
    : `Morning, Misha. ${items.length} things today:`;
  const waited = opts.wake
    ? "\n\nOne Telegram message waited for you overnight: “did Acme pay?” — not yet."
    : "";
  const steps: Script = [
    {
      work: opts.wake
        ? "Waking up, reading what came overnight…"
        : "Reading mail, calendar and your computers…",
    },
    {
      say: `${head}\n\n${list}${waited}\n\nNothing else needs you. I'll write again only if something changes.`,
    },
  ];
  const inbox: Script = [
    {
      inbox: {
        id: `i-summary-${Date.now()}`,
        kind: "agent.done",
        chat: ctx.threadId,
        title: opts.wake ? "Uno caught up while you were away" : "Uno: your morning summary",
        body: ctx.ops.telegramLinked(ctx.machine, ctx.persona.projectId)
          ? `${items.length} things · also sent to your Telegram.`
          : `${items.length} things · open Uno to see them.`,
      },
    },
  ];
  if (gmail !== "on") return [...steps, ...inbox, ...connectorsCard(ctx)];
  const whatFirst: Script = [
    {
      ask: "What first?",
      question: {
        id: "morning-first",
        header: "Today",
        question: "What first?",
        options: [
          { label: "Send the Acme reminder", description: "From your Gmail, the draft as is" },
          { label: "Move the dentist to 15:00", description: "In Google Calendar" },
          { label: "Later", description: "I'll ask again at noon" },
        ],
      },
      then: (answer, inner) =>
        /acme/i.test(answer)
          ? acmeDecision(inner)
          : /dentist/i.test(answer)
            ? [
                {
                  act: {
                    command: "Move “Dentist” to 15:00 today in Google Calendar",
                    why: "It changes your calendar.",
                  },
                  allowed: [{ say: "Moved: dentist at 15:00. The call with Dana stays at 11:30." }],
                  declined: [{ say: "Left as is. Both stay at 11:00 and 11:30." }],
                },
              ]
            : [{ say: "OK. I'll ask again at noon." }],
    },
  ];
  // No Telegram yet: offer it once, after the summary (edge: Telegram not connected).
  const offerTelegram = ctx.ops.telegramLinked(ctx.machine, ctx.persona.projectId)
    ? []
    : telegramCard(ctx);
  return [...steps, ...inbox, ...offerTelegram, ...whatFirst];
}

/** Daytime: a decision only you can make (Allow in "Asks first"). */
function decision(ctx: ScriptContext): Script {
  return [
    {
      ask: "**Needs your decision.** Acme replied: they'll pay today if you give 5% off.",
      question: {
        id: "acme-discount",
        header: "Acme",
        question: "5% off if they pay today?",
        options: [
          { label: "Agree to 5%", description: "“Deal — 5% off if it's paid by 18:00 today.”" },
          { label: "No discount", description: "“Thanks, the full amount please.”" },
        ],
      },
      then: (answer) =>
        /agree/i.test(answer)
          ? [
              {
                act: {
                  command:
                    "Send email to billing@acme.example — “Deal: 5% off if paid by 18:00 today”",
                  why: "It goes out from your Gmail, to a client.",
                },
                allowed: [{ say: "Sent. I'll tell you when the money lands." }],
                declined: [{ say: "Not sent. The draft stays in Gmail → Drafts." }],
              },
            ]
          : [
              {
                act: {
                  command: "Send email to billing@acme.example — “Thanks, the full amount please”",
                  why: "It goes out from your Gmail, to a client.",
                },
                allowed: [{ say: "Sent. I'll nudge them again on Friday if nothing comes." }],
                declined: [{ say: "Not sent. The draft stays in Gmail → Drafts." }],
              },
            ],
    },
  ];
}

/** "Can I use that computer?" — the access on Uno's page decides. */
function noHands(ctx: ScriptContext, machine: "mac" | "product"): Script | null {
  if (ctx.ops.handAllowed(ctx.persona.projectId, machine)) return null;
  return [
    {
      say: `I don't have access to your ${machineName(machine)}. Turn it on in my page → Computers, and I'll start right away.`,
    },
  ];
}

/** A task on the MacBook that fails there; Uno offers another computer. */
function buildFails(ctx: ScriptContext): Script {
  const blocked = noHands(ctx, "mac");
  if (blocked) return blocked;
  if (!macOnline(ctx.world)) {
    return [
      {
        say: "Your MacBook is asleep — I'll build it on uno-work from GitHub instead.",
      },
      ...buildOnCloud(),
    ];
  }
  return [
    {
      elsewhere: {
        machine: "mac",
        projectId: "p-mac-landing",
        title: "Build the landing for launch",
        prompt: "Run the production build of the landing and tell me if it's green.",
        steps: ["npm ci…", "npm run build…"],
        result: "",
        fails: "the build stopped — /public/fonts/Inter.woff2 is missing on the MacBook.",
      },
      onFail: [
        {
          ask: "The font is in GitHub. Try the build on uno-work instead?",
          question: {
            id: "retry-cloud",
            header: "Build",
            question: "Where should I try again?",
            options: [
              { label: "Try on uno-work", description: "Clones from GitHub, builds there" },
              { label: "Leave it", description: "You'll fix it on the Mac" },
            ],
          },
          then: (answer) =>
            /uno-work/i.test(answer)
              ? buildOnCloud()
              : [{ say: "OK, leaving it. The error is in the MacBook chat." }],
        },
      ],
    },
  ];
}

function buildOnCloud(): Script {
  return [
    {
      elsewhere: {
        machine: "work",
        projectId: "p-work-landing",
        title: "Build the landing on uno-work",
        prompt: "Clone landing from GitHub and run the production build.",
        steps: ["Cloning github.com/misha-demo/landing…", "npm run build…"],
        result: "the build is green (42 pages). Preview: landing-misha.uno4.me.",
      },
    },
  ];
}

/** The third computer: the newsletter lives there. */
function newsletterTask(ctx: ScriptContext): Script {
  const blocked = noHands(ctx, "product");
  if (blocked) return blocked;
  if (!thirdOnline(ctx.world)) {
    return [
      {
        say: "free-cloud is asleep. I'll wake it when I start — about 20 seconds. On Plus it stays on.",
      },
    ];
  }
  return [
    {
      elsewhere: {
        machine: "product",
        projectId: "p-free-newsletter",
        title: "Newsletter #15 outline",
        prompt: "Outline newsletter #15 from this week's changelog.",
        steps: ["Reading the changelog…", "Writing the outline…"],
        result: "outline is in newsletter/drafts/15.md — 5 sections.",
      },
    },
  ];
}

/** A long task with an outward step at the end (to switch the mode while it runs). */
function launchChecklist(): Script {
  return [
    { work: "Going through the launch checklist (6 items)…", delay: 900 },
    { work: "1–3: pricing copy, meta tags, favicon — done.", delay: 2600 },
    { work: "4–5: checkout on a phone, the 404 page — done.", delay: 2600 },
    { work: "6: everything is ready to publish.", delay: 2600 },
    {
      act: {
        command: "Publish shop-site to landing-misha.uno4.me",
        why: "It goes live for everyone.",
      },
      allowed: [{ say: "Published: landing-misha.uno4.me. The checklist is 6 of 6." }],
      declined: [{ say: "Not published. Everything is ready when you are." }],
    },
  ];
}

/** An own assistant's long job (to remove it in the middle). */
function personaLongJob(ctx: ScriptContext): Script {
  return [
    { work: `${ctx.persona.name}: reading 12 supplier sites…`, delay: 900 },
    { work: "Comparing prices and delivery times…", delay: 3000 },
    { work: "Checking reviews…", delay: 3000 },
    {
      act: {
        command: "Send the comparison to misha@example.com",
        why: "It goes out by email.",
      },
      allowed: [{ say: "Sent: 3 suppliers compared, the table is in Drive." }],
      declined: [{ say: "Not sent. The table is in Drive → Suppliers." }],
    },
  ];
}

function whatISee(ctx: ScriptContext): Script {
  const rows = [
    "**uno-work** — my home. Always on" + (free() ? " while you use it (Free)" : "") + ".",
    macOnline(ctx.world)
      ? "**MacBook** — online, my hands for the deck and the landing."
      : "**MacBook** — asleep. Its tasks wait until it wakes.",
    thirdOnline(ctx.world)
      ? "**free-cloud** — online, the newsletter lives there."
      : "**free-cloud** — asleep. I wake it when I need it.",
  ];
  return [
    {
      say: `Here's what I see:\n\n${rows.map((row) => `- ${row}`).join("\n")}\n\nOne memory for all of them; your apps are connected once, for the account.`,
    },
  ];
}

// Triggers: the one added last is checked first — specific ones go last.
addTrigger({
  id: "a-mac-access",
  match: /\bmac\b|macbook|deck/i,
  persona: ASSISTANT_PROJECT_ID,
  script: (ctx) => noHands(ctx, "mac") ?? otherComputerTask(ctx),
});
addTrigger({
  id: "a-morning",
  match: /morning|summary|today/i,
  script: (ctx) => morning(ctx, { wake: false }),
});
addTrigger({
  id: "a-persona-job",
  match: /compare|suppliers|research/i,
  script: (ctx) => (isUno(ctx) ? [{ say: "On it." }] : personaLongJob(ctx)),
});
addTrigger({ id: "a-decision", match: /discount|decision/i, script: decision });
addTrigger({
  id: "a-computers",
  match: /computers|what do you see/i,
  persona: ASSISTANT_PROJECT_ID,
  script: whatISee,
});
addTrigger({
  id: "a-checklist",
  match: /checklist|publish/i,
  persona: ASSISTANT_PROJECT_ID,
  script: launchChecklist,
});
addTrigger({
  id: "a-newsletter",
  match: /newsletter/i,
  persona: ASSISTANT_PROJECT_ID,
  script: newsletterTask,
});
addTrigger({
  id: "a-build",
  match: /\bbuild\b/i,
  persona: ASSISTANT_PROJECT_ID,
  script: buildFails,
});
addTrigger({
  id: "a-onboarding-answer",
  persona: ASSISTANT_PROJECT_ID,
  match: /on fire|plate|friday|hate chasing/i,
  script: () => [
    { say: "Got it: launch on Friday, and invoices off your plate. I'll start with the invoices." },
    { work: "Reading Gmail for unpaid invoices…" },
    {
      say: "Two are unpaid: Acme #1042 (5 days late) and Brightline #12 (9 days). Reminders are drafted — say “send the Acme reminder” and it goes.",
    },
  ],
});

addScene({
  id: "morning",
  title: "Утренняя сводка 08:00 (Plus)",
  hint: "Uno пишет первым: 3 пункта и «что первым?» карточкой. Если Telegram не связан — после сводки предлагает его карточкой.",
  run: ({ play, target, ops, world }) =>
    void play(morning({ ...target, ops, world }, { wake: false })),
});
addScene({
  id: "free-wake",
  title: "Free: открыл Work утром",
  hint: "Облако спало ночью: Uno догоняет при открытии — сводка, ждавшее сообщение из Telegram, честная плашка и путь в Plus.",
  run: ({ play, target, ops, world }) =>
    void play(morning({ ...target, ops, world }, { wake: true })),
});
addScene({
  id: "decision",
  title: "Днём: нужно твоё решение",
  hint: "Acme просит скидку 5%. Карточка выбора; в «Спрашивает» — ещё Allow перед письмом (в чате, Inbox и Telegram).",
  run: ({ play, target, ops, world }) => void play(decision({ ...target, ops, world })),
});
addScene({
  id: "build-fails",
  title: "Задача на Mac упала",
  hint: "Uno запускает сборку на MacBook, там ошибка: красная строка в чате Mac и в Inbox, Uno предлагает повторить на uno-work.",
  run: ({ play, target, ops, world }) => {
    ops.userSays(target.machine, target.threadId, "Build the landing on my Mac for Friday");
    void play(buildFails({ ...target, ops, world }));
  },
});
addScene({
  id: "computers",
  title: "Что видит Uno (3 компьютера)",
  hint: "Uno перечисляет компьютеры аккаунта: дом (uno-work) и руки (MacBook, free-cloud) — кто онлайн, кто спит.",
  run: ({ play, target, ops, world }) => {
    ops.userSays(target.machine, target.threadId, "What computers do you see?");
    void play(whatISee({ ...target, ops, world }));
  },
});
