/**
 * Variant D (28.10, Misha's pick in the 27.10 mocks): one Uno per account
 * plus persona channels.
 *
 * - Uno lives on the cloud computer that doesn't sleep (Plus), sees every
 *   computer and connector, hands tasks to the machines. Its chat is
 *   "Everything": one morning summary that says what each persona did.
 * - Personas (Mia · Secretary, Bolt · Developer, …) are channels next to Uno
 *   in the sidebar: a face and a role, not tied to a machine; they share
 *   Uno's memory, connectors and Telegram bot; each has its own mode.
 * - Made in a Grok-style gallery (`PersonaCreator.tsx`), they write first in
 *   their own voice.
 * - Free: the cloud sleeps — the summary comes when Work opens, Telegram
 *   messages wait; the chat says so and offers Plus.
 *
 * Extra address params of this variant: `personas=N` (N personas, the 10+
 * edge), `facegen=fail` (a drawn portrait fails).
 */
import { ASSISTANT_PROJECT_ID } from "@t3tools/contracts";

import type { ChatSpec } from "../heavyFixtures";
import { activeAssistants, setupDone } from "./daemon";
import {
  type Script,
  type ScriptContext,
  acmeDecision,
  addScene,
  addTrigger,
  connectorsCard,
  dropTrigger,
  keepScenes,
  machineName,
  mainChatOf,
  onDemoReady,
  playWith,
  setGreeting,
  telegramCard,
} from "./engine";
import { DEMO_PERSONAS, type DemoPersona } from "./fixtures";
import { WORLD, macOnline } from "./world";

export const VARIANT: { readonly id: string; readonly title: string } = {
  id: "d",
  title: "D · Uno + персонажи-каналы",
};

// ── The personas of the live account ─────────────────────────────────────

function mainChat(
  projectId: string,
  title: string,
  minutesAgo: number,
  messages: ChatSpec["messages"],
): ChatSpec {
  return {
    id: `${projectId}-main`,
    machine: "work",
    project: projectId,
    title,
    minutesAgo,
    state: "read",
    role: "assistant",
    messages,
  };
}

const MIA: DemoPersona = {
  projectId: "assistant-mia",
  machine: "work",
  name: "Mia",
  emoji: "🦉",
  tone: "amber",
  roles: ["Secretary"],
  character: "Warm · Brief · Careful",
  duties: ["Inbox at 9:00 and 17:00", "Drafts replies to clients"],
  setUp: true,
  chats: [
    mainChat("assistant-mia", "Mia", 95, [
      ["assistant", "Your 11:00 with Dana moved to 15:00. I told her that works for you."],
      ["user", "Thanks. Anything from Brightline?"],
      ["assistant", "Not yet. I'll tell you the minute they answer."],
    ]),
  ],
};

const BOLT: DemoPersona = {
  projectId: "assistant-bolt",
  machine: "work",
  name: "Bolt",
  emoji: "🤖",
  tone: "sky",
  roles: ["Developer"],
  character: "Direct · Brief · Nerdy",
  duties: ["Keeps CI green on landing and orders-bot"],
  setUp: true,
  chats: [
    mainChat("assistant-bolt", "Bolt", 60 * 5, [
      ["assistant", "CI on landing was red: a flaky image test. Fixed it, PR #41 is up."],
      ["user", "Merge it after the checks."],
      ["assistant", "Merged. Green."],
    ]),
  ],
};

/** More personas for the 10+ edge: name, face, role, character. */
const EXTRA: ReadonlyArray<readonly [string, string, string, string, string]> = [
  ["Leo", "🦊", "orange", "Marketer", "Playful · Bold · Chatty"],
  ["Nova", "👽", "violet", "Researcher", "Curious · Careful"],
  ["Juno", "🐼", "teal", "Support", "Patient · Warm · Formal"],
  ["Ada", "🧠", "rose", "Analyst", "Direct · Nerdy"],
  ["Rex", "🦁", "amber", "Sales", "Bold · Chatty"],
  ["Ivy", "🌿", "emerald", "Designer", "Playful · Careful"],
  ["Otto", "🐙", "violet", "Finance", "Careful · Formal"],
  ["Pip", "🐧", "sky", "Social media", "Playful · Brief"],
  ["Kai", "🛠️", "slate", "Ops", "Direct · Brief"],
  ["Zoe", "🦄", "rose", "Recruiter", "Warm · Chatty"],
  ["Max", "🐻", "orange", "Bookkeeper", "Careful · Brief"],
  ["Lu", "🚀", "sky", "Growth", "Bold · Curious"],
];

function extraPersona(index: number): DemoPersona {
  const [name, emoji, tone, role, character] = EXTRA[index % EXTRA.length]!;
  const slug = `${name.toLowerCase()}${index >= EXTRA.length ? `-${index}` : ""}`;
  return {
    projectId: `assistant-${slug}`,
    machine: "work",
    name,
    emoji,
    tone,
    roles: [role],
    character,
    duties: [],
    setUp: true,
    chats: [],
  };
}

function personaCount(): number {
  if (typeof location === "undefined") return 0;
  const asked = Number(new URLSearchParams(location.search).get("personas") ?? "");
  return Number.isFinite(asked) && asked > 0 ? Math.min(asked, 30) : 0;
}

if (WORLD.account === "live") {
  const wanted = personaCount();
  DEMO_PERSONAS.push(MIA, BOLT);
  for (let index = 0; DEMO_PERSONAS.length < wanted; index += 1) {
    DEMO_PERSONAS.push(extraPersona(index));
  }
}

// ── How a persona talks (its role and character, never a prompt) ────────

const traitsOf = (persona: DemoPersona) =>
  persona.character
    .split("·")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
const roleOf = (persona: DemoPersona) => persona.roles[0] ?? "Assistant";
const isUno = (persona: DemoPersona) => persona.projectId === ASSISTANT_PROJECT_ID;

function opener(persona: DemoPersona): string {
  const traits = traitsOf(persona);
  if (traits.includes("formal"))
    return `Good day. I'm ${persona.name}, your ${roleOf(persona).toLowerCase()}.`;
  if (traits.includes("playful"))
    return `Hey! ${persona.name} here ✨ — your new ${roleOf(persona).toLowerCase()}.`;
  if (traits.includes("direct")) return `${persona.name}. ${roleOf(persona)}.`;
  return `Hi, I'm ${persona.name} — your ${roleOf(persona).toLowerCase()}.`;
}

/** What it offers to do first, by its role. */
function firstOffer(persona: DemoPersona): { line: string; yes: string } {
  const role = roleOf(persona).toLowerCase();
  if (role.includes("account"))
    return {
      line: "Give me the accounts in the safe window and I'll sign in from a chat on your cloud computer — 2FA comes to you.",
      yes: "Look at my accounts",
    };
  if (role.includes("secret") || role.includes("assist") || role.includes("helper"))
    return {
      line: "Uno's notes say Acme is 5 days late with #1042, and Dana is at 15:00. I'll keep your inbox tidy and draft replies.",
      yes: "Start with today's mail",
    };
  if (role.includes("develop") || role.includes("ops"))
    return {
      line: "Shared memory: landing and orders-bot on GitHub, the deck on the MacBook. I watch CI and fix what breaks.",
      yes: "Check CI now",
    };
  if (role.includes("market") || role.includes("social") || role.includes("growth"))
    return {
      line: "I read the landing and last month's posts. Tuesday's post got 3× the clicks — I'd do two more like it.",
      yes: "Draft two posts",
    };
  if (role.includes("research") || role.includes("analy"))
    return {
      line: "Give me a question and a deadline. I come back with sources and one clear answer.",
      yes: "Compare 3 suppliers",
    };
  if (role.includes("support"))
    return {
      line: "I can answer customers from your mail and Telegram, and pass you anything about money.",
      yes: "Answer today's questions",
    };
  return {
    line: "Tell me what you need — I share Uno's memory, so I already know your projects.",
    yes: "Show me what you can do",
  };
}

/** Its first words after the gallery: in its voice, its mode said plainly, one next step. */
function personaHello(ctx: ScriptContext): Script {
  const { persona } = ctx;
  const asks = ctx.ops.asksFirst(persona.machine, persona.projectId);
  const offer = firstOffer(persona);
  const brief = traitsOf(persona).includes("brief");
  const mode = asks
    ? "Anything that goes out — mail, payments, deletes — I ask you first."
    : "I do routine things myself and tell you after.";
  const telegram = ctx.ops.telegramLinked(persona.machine, persona.projectId)
    ? " I'll write in your Telegram too, signed “" + persona.name + "”."
    : "";
  return [
    { say: `${opener(persona)} ${offer.line}`, delay: 700 },
    ...(brief ? [] : [{ say: `${mode}${telegram}` }]),
    {
      ask: brief ? `${mode} Go?` : "Where do we start?",
      question: {
        id: `hello-${persona.projectId}`,
        header: persona.name,
        question: "First thing",
        options: [
          { label: offer.yes, description: "Now, in this chat" },
          { label: "Later", description: "I'll be here" },
        ],
        skippable: true,
      },
      then: (answer, inner) =>
        /later/i.test(answer)
          ? [{ say: "OK. Write me here or in Telegram when you need me." }]
          : roleOf(persona).toLowerCase().includes("secret")
            ? miaDecision(inner)
            : roleOf(persona).toLowerCase().includes("develop")
              ? boltTests(inner)
              : [
                  { work: "On it…" },
                  { say: "Done — a first draft is in Files → Drafts. Tell me what to change." },
                ],
    },
  ];
}

// ── Uno's first run: getting to know you, in a chat ──────────────────────

/** The two modes, asked simply (Misha 27.10: exactly two). */
function modeCard(ctx: ScriptContext, after: Script): Script {
  return [
    {
      ask: "Last thing — my permission level. Before I send, publish, share or delete something, should I ask you?",
      question: {
        id: "mode",
        header: "Permission level",
        question: "Before I send, publish, share or delete",
        options: [
          {
            label: "Cautious",
            description: "I ask first and wait for your Allow — here or in Telegram",
          },
          { label: "Full access", description: "I work without asking for permission" },
        ],
      },
      then: (answer, inner) => {
        const asks = /cautious/i.test(answer);
        return [
          {
            run: () =>
              inner.ops.setMode(
                inner.persona.machine,
                inner.persona.projectId,
                asks ? "asks-first" : "itself",
              ),
          },
          {
            say: asks
              ? "Done — Cautious: I'll ask first. You can switch it any time at the top of this chat."
              : "Done — Full access: I'll work and tell you after. You can switch it any time at the top of this chat.",
          },
          ...after,
        ];
      },
    },
  ];
}

const freeNote: Script = [
  {
    say: "One honest thing: on Free your cloud computer sleeps when you're away. I catch up the moment you open Work, and Telegram messages wait until then. Plus keeps me awake.",
  },
];

function helpersOffer(after: Script): Script {
  return [
    {
      ask: "I can also bring in helpers with a role — like Mia, a secretary for your inbox. They share my memory. Want to see them?",
      question: {
        id: "helpers",
        header: "Helpers",
        question: "Meet the helpers",
        options: [
          { label: "Show me", description: "A gallery — pick one or build your own" },
          { label: "Later", description: "Just you and me for now" },
        ],
        skippable: true,
      },
      then: (answer) =>
        /show/i.test(answer)
          ? [
              { say: "Here they are. Pick one — it starts in its role right away." },
              {
                run: () => {
                  location.hash = "#/assistants?view=new";
                },
                delay: 700,
              },
            ]
          : after,
    },
  ];
}

function aboutYou(answer: string): string {
  if (/business/i.test(answer))
    return "Got it — a small business. Then mail, invoices and clients come first.";
  if (/software|build/i.test(answer))
    return "Got it — you build software. Then CI, PRs and your computers come first.";
  if (/content|make/i.test(answer))
    return "Got it — content. Then drafts, posts and deadlines come first.";
  return `Got it: “${answer.slice(0, 80)}”. I'll keep that in mind.`;
}

function firstRun(ctx: ScriptContext): Script {
  const free = ctx.world.tier === "free";
  const closing: Script = [
    { say: "So — what's burning today? Tell me in a line, or say “morning summary”." },
  ];
  return [
    {
      say: "Hi, I'm Uno. I live on your cloud computer, so I keep working when your laptop is closed. Two minutes and I'm useful.",
      delay: 900,
    },
    {
      ask: "First: what do you mostly do?",
      question: {
        id: "about-you",
        header: "About you",
        question: "What do you mostly do?",
        options: [
          { label: "I run a small business", description: "Clients, invoices, mail" },
          { label: "I build software", description: "Code, CI, deploys" },
          { label: "I make content", description: "Posts, drafts, deadlines" },
        ],
        input: { placeholder: "Or in your own words" },
        skippable: true,
      },
      then: (answer, inner) => [
        { say: aboutYou(answer) },
        ...connectorsCard(inner, [
          ...telegramCard(inner, [
            ...modeCard(inner, [...(free ? freeNote : []), ...helpersOffer(closing), ...closing]),
          ]),
        ]),
      ],
    },
  ];
}

setGreeting((ctx) => {
  if (!isUno(ctx.persona)) return personaHello(ctx);
  // A new account set up on its screen (AI, mode, apps) — straight to work.
  if (ctx.world.account === "new" && setupDone(ctx.machine, ASSISTANT_PROJECT_ID)) {
    return [
      {
        say: "Hi, I'm Uno. I live on your cloud computer and hand the work to chats on your computers. So — what's burning today?",
        delay: 600,
      },
    ];
  }
  if (ctx.world.account === "new") return firstRun(ctx);
  return [
    { say: "Hi again. Say “morning summary”, or tell me what to do — on any of your computers." },
  ];
});

// ── Everyday: one summary, decisions, tasks on the machines ──────────────

const PERSONA_LINE: ReadonlyArray<readonly [RegExp, string]> = [
  [/secret/i, "answered 3 emails; Brightline's 5% discount waits for your decision"],
  [/develop/i, "CI on landing is green; PR #42 waits for your review"],
  [/market|social|growth/i, "drafted 2 posts for Thursday"],
  [/research|analy/i, "compared 3 suppliers — the cheapest has bad reviews"],
  [/support/i, "answered 6 customers; one refund is yours to decide"],
];

function personaLine(persona: DemoPersona): string {
  const role = roleOf(persona);
  const what = PERSONA_LINE.find(([match]) => match.test(role))?.[1] ?? "nothing new";
  return `- ${persona.emoji ?? ""} **${persona.name} · ${role}:** ${what}`;
}

/** The one summary of the account: Uno's lines, then a line per persona. */
export function dSummary(ctx: ScriptContext, proactive: boolean, opening?: string): Script {
  const gmail = ctx.ops.connectorState("gmail");
  const lines: string[] = [];
  if (gmail === "on") {
    lines.push("- **Mail:** Acme hasn't paid invoice #1042 (5 days late).");
    lines.push("- **Calendar:** call with Dana at 15:00.");
  } else if (gmail === "expired") {
    lines.push("- **Mail:** I couldn't read it — Gmail ended its sign-in.");
  }
  lines.push(
    macOnline(ctx.world)
      ? "- **MacBook:** the landing build is green again."
      : "- **MacBook** is asleep — its chats wait; everything else runs on the cloud.",
  );
  lines.push("- **orders-bot:** 212 orders exported to Drive at 07:00.");
  const personas = activeAssistants("work").filter((persona) => !isUno(persona));
  const team = personas.slice(0, 6).map(personaLine);
  if (personas.length > 6) team.push(`- …and ${personas.length - 6} more: nothing that needs you.`);
  const body = `${opening ?? (proactive ? "Good morning. " : "")}Here's today:\n\n${lines.join("\n")}${
    team.length > 0 ? `\n\n**Your helpers:**\n\n${team.join("\n")}` : ""
  }`;
  const script: Script = [
    {
      work:
        gmail === "on"
          ? "Reading mail, calendar, your computers and helpers…"
          : "Looking at your computers and helpers…",
    },
    { say: body },
  ];
  if (gmail !== "on") return [...script, ...connectorsCard(ctx)];
  if (!proactive) return script;
  return [
    ...script,
    {
      inbox: {
        id: `i-summary-${Date.now()}`,
        kind: "agent.done",
        chat: ctx.threadId,
        title: "Uno: your morning summary",
        body:
          (personas.length > 0
            ? `With ${personas
                .slice(0, 3)
                .map((p) => p.name)
                .join(", ")}. `
            : "") +
          (ctx.ops.telegramLinked(ctx.machine, ctx.persona.projectId)
            ? "Also sent to your Telegram."
            : "Connect Telegram to get it on your phone."),
      },
    },
  ];
}

/** Mia needs a decision (Brightline wants 5% off), then asks before the mail goes out. */
function miaDecision(ctx: ScriptContext): Script {
  if (ctx.ops.connectorState("gmail") === "expired") {
    return [{ say: "I can't read your mail: Gmail ended its sign-in." }, ...connectorsCard(ctx)];
  }
  const tellUno = (text: string): Script => [
    {
      run: (inner) => {
        const uno = inner.ops.mainChatOf("work", ASSISTANT_PROJECT_ID);
        inner.ops.say("work", uno, text);
      },
    },
  ];
  return [
    { work: "Reading today's mail…" },
    ...tellUno(
      `${ctx.persona.name} needs your decision: Brightline asks for 5% off. It's in her chat and in Needs you.`,
    ),
    {
      inbox: {
        id: `i-decide-${ctx.threadId}-${Date.now()}`,
        kind: "agent.input",
        chat: ctx.threadId,
        title: `${ctx.persona.name} needs your decision: Brightline's discount`,
        body: "They'll pay today if you give 5% off.",
      },
    },
    {
      ask: "**Needs your decision.** Brightline replied: they'll pay today if you give 5% off.\n\nMy draft: “Deal — 5% off if it's paid by 18:00 today.”",
      question: {
        id: "brightline",
        header: "Decision",
        question: "Brightline: 5% off for paying today?",
        options: [
          { label: "Agree to 5%", description: "Send the draft" },
          { label: "No discount", description: "Politely keep the price" },
        ],
      },
      then: (answer) => {
        const agree = /agree/i.test(answer);
        return [
          {
            act: {
              command: agree
                ? "Send an email to billing@brightline.example — “Deal — 5% off if paid by 18:00”"
                : "Send an email to billing@brightline.example — “We keep the price as agreed”",
              why: `${ctx.persona.name} sends it from your Gmail, to a client.`,
            },
            allowed: [
              {
                say: agree
                  ? "Sent. I'll tell you when the money lands."
                  : "Sent — kindly, no discount. I'll watch for their answer.",
              },
            ],
            declined: [{ say: "OK, not sending. The draft stays in Gmail → Drafts." }],
          },
        ];
      },
    },
  ];
}

/** A longer task (3 steps, then a mail goes out): to change the mode or remove it in the middle. */
function longReplies(ctx: ScriptContext): Script {
  return [
    { work: "Reading 14 client threads…", delay: 2400 },
    { work: "Drafting 3 replies…", delay: 2400 },
    { work: "Checking names, numbers and tone…", delay: 2400 },
    {
      act: {
        command: "Send 3 replies — Acme, Brightline, Dana",
        why: `${ctx.persona.name} sends them from your Gmail, to clients.`,
      },
      allowed: [{ say: "Sent all 3. Copies are in Gmail → Sent." }],
      declined: [{ say: "Not sending. The 3 drafts are in Gmail → Drafts." }],
      delay: 1200,
    },
  ];
}

/** Bolt runs the landing tests on the MacBook (asks where, if it sleeps). */
function boltTests(ctx: ScriptContext, fails = false): Script {
  if (!macOnline(ctx.world)) {
    return [
      {
        ask: "Your MacBook is asleep, and the tests need the landing there. Run them on the cloud from GitHub, or wait for the Mac?",
        question: {
          id: "bolt-mac-asleep",
          header: "MacBook",
          question: "Where should I run them?",
          options: [
            { label: "Run on the cloud", description: "Takes landing from GitHub" },
            { label: "Wait for the MacBook", description: "Starts when it wakes" },
          ],
        },
        then: (answer) =>
          /cloud/i.test(answer)
            ? [
                {
                  elsewhere: {
                    machine: "work",
                    projectId: "p-work-landing",
                    title: "Run the landing tests",
                    prompt: "Pull landing from GitHub and run the tests.",
                    steps: ["Pulling github.com/misha-demo/landing…", "npm test — 48 tests…"],
                    result: "48 of 48 tests pass on the cloud computer.",
                  },
                },
              ]
            : [
                {
                  say: "OK — it waits. When the MacBook wakes, I start and tell you here and in Telegram.",
                },
                {
                  inbox: {
                    id: `i-wait-mac-${Date.now()}`,
                    kind: "agent.input",
                    chat: ctx.threadId,
                    title: `${ctx.persona.name} waits for your MacBook: Run the landing tests`,
                    body: "Starts when the MacBook wakes.",
                  },
                },
              ],
      },
    ];
  }
  return [
    {
      elsewhere: {
        machine: "mac",
        projectId: "p-mac-landing",
        title: fails ? "Run the checkout tests" : "Run the landing tests",
        prompt: fails
          ? "Run the checkout tests before the deploy."
          : "Run the landing tests and tell me what fails.",
        steps: fails
          ? ["npm test -- checkout…", "48 tests, 2 failing…"]
          : ["npm install…", "npm test — 48 tests…", "All green, checking the build…"],
        result: "48 of 48 tests pass, the build is green.",
        ...(fails
          ? {
              fails:
                "npm test: 2 of 48 tests fail in checkout.spec.ts (price rounding). Nothing was deployed.",
            }
          : {}),
      },
      afterFail: [
        {
          inbox: {
            id: `i-fix-${Date.now()}`,
            kind: "agent.input",
            chat: ctx.threadId,
            title: `${ctx.persona.name} asks: fix the checkout tests on the MacBook?`,
            body: "2 of 48 fail (price rounding). Nothing was deployed.",
          },
        },
        {
          ask: `It failed on ${machineName("mac")}: 2 checkout tests fail (price rounding). Nothing was deployed. Fix them there?`,
          question: {
            id: "bolt-fix",
            header: "Failed on MacBook",
            question: "2 tests fail in checkout.spec.ts",
            options: [
              {
                label: "Fix them on the MacBook",
                description: "I'll change the rounding and run again",
              },
              { label: "I'll look myself", description: "The chat on the MacBook has the log" },
            ],
          },
          then: (answer) =>
            /fix/i.test(answer)
              ? [
                  {
                    elsewhere: {
                      machine: "mac",
                      projectId: "p-mac-landing",
                      title: "Fix checkout rounding",
                      prompt: "Fix the price rounding in checkout and run the tests.",
                      steps: ["Rounding to cents in checkout/total.ts…", "npm test — 48 tests…"],
                      result: "Fixed: 48 of 48 pass. Not deployed — say “deploy” when you want it.",
                    },
                  },
                ]
              : [{ say: "OK. The log is in the chat on the MacBook — “Run the checkout tests”." }],
        },
      ],
    },
  ];
}

// The base's "morning" answers with the base summary: D's has the helpers in it.
dropTrigger("morning");
addTrigger({
  id: "d-morning",
  match: /morning|summary|what's up|today|сводк|утр/i,
  script: (ctx) =>
    isUno(ctx.persona)
      ? dSummary(ctx, false)
      : [{ say: "The morning summary is Uno's — one for all of us. Open Uno to see it." }],
});
addTrigger({
  id: "d-mia-mail",
  match: /mail|inbox|brightline|reply|start with|discount/i,
  script: (ctx) => (isUno(ctx.persona) ? acmeDecision(ctx) : miaDecision(ctx)),
});
addTrigger({
  id: "d-long",
  match: /all clients|long task|reply to everyone|answer everyone/i,
  script: longReplies,
});
addTrigger({
  id: "d-bolt-fails",
  match: /checkout|deploy/i,
  script: (ctx) => boltTests(ctx, true),
});
addTrigger({
  id: "d-bolt-tests",
  match: /\btests?\b|\bci\b|check ci/i,
  script: (ctx) => boltTests(ctx),
});

// ── A new assistant's first message (the setup's "What should it do?") ────
// The page sends it as the person; the assistant hands the work to a chat on
// its computer and tells the result — like the real ones are asked to.

function firstJob(ctx: ScriptContext, text: string): Script {
  const where = machineName(ctx.machine);
  // Any of the three parts may be on; the demo answers for the first it sees.
  if (/work in my accounts/i.test(text) && /browser_command \{"login"/.test(text)) {
    const sites = [...text.matchAll(/browser_command \{"login": "([^"]+)"\}/g)].map(
      (match) => match[1] ?? "",
    );
    const site = sites[0] ?? "the site";
    return [
      {
        work: `On it — a chat on ${where} signs in to ${sites.join(", ") || site}. The password stays in its vault; I never see it.`,
      },
      {
        elsewhere: {
          machine: ctx.machine,
          projectId: ctx.persona.projectId,
          title: `Sign in to ${site}`,
          prompt: `Sign in with browser_command {"login": "${site}"} and do the task.`,
          steps: [
            `browser_command {"login": "${site}"} — the computer typed the saved password`,
            `Signed in to ${site}. Doing the task…`,
          ],
          result: `Signed in to ${site} and did it: 2 posts drafted, 5 new comments answered.`,
        },
      },
      { say: `Done on ${site}: 2 posts drafted, 5 comments answered. Say when you want more.` },
    ];
  }
  if (/lead development/i.test(text)) {
    const what = /lead development of (.+?)\./i.exec(text)?.[1] ?? "your projects";
    return [
      { work: `Starting a chat on ${where} for ${what}.` },
      {
        elsewhere: {
          machine: ctx.machine,
          projectId: ctx.machine === "work" ? "p-work-landing" : ctx.persona.projectId,
          title: `Where ${what} stands`,
          prompt: `Look at ${what}: branches, open PRs, tests.`,
          steps: ["git status · 2 open PRs…", "npm test — 48 tests…"],
          result: "main is green (48/48), 2 PRs wait for review.",
        },
      },
      {
        say: `${what}: main is green, 2 PRs wait for your review. Want me to start on the first one?`,
      },
    ];
  }
  const tools = /help me with tasks using (.+?)\.\n/i.exec(text)?.[1] ?? null;
  return [
    {
      say: tools
        ? `Got it — I'll use ${tools}. Ask me anything: I start a chat on ${where} for the real work and tell you the result here.`
        : `Got it. Tell me the first thing — I start a chat on ${where} for it and tell you the result here.`,
    },
  ];
}

addTrigger({
  id: "d-first-job",
  match: /Your job:/,
  script: firstJob,
});

// ── Scenes for the panel (what happens without typing) ───────────────────

keepScenes(["telegram-message", "reminder-closed", "error"]);
const MIA_TARGET = { machine: "work" as const, projectId: MIA.projectId };
const BOLT_TARGET = { machine: "work" as const, projectId: BOLT.projectId };

addScene({
  id: "d-morning",
  title: "Утренняя сводка — одна на всех (08:00)",
  hint: "Uno пишет первым в «Everything»: почта, календарь, компьютеры и строка от каждого персонажа (Mia, Bolt…).",
  run: ({ play, target, ops, world }) => void play(dSummary({ ...target, ops, world }, true)),
});
addScene({
  id: "d-mia-decision",
  title: "Mia: нужно твоё решение",
  hint: "Mia в своём канале просит решить скидку Brightline; это же видно в Uno (Everything) и в Needs you. Дальше — Allow, если у Mia «Спрашивает».",
  target: MIA_TARGET,
  run: ({ play, target, ops, world }) => void play(miaDecision({ ...target, ops, world })),
});
addScene({
  id: "d-bolt-mac",
  title: "Bolt: задача на MacBook",
  hint: "Bolt запускает тесты в чате на MacBook; шаги видны там, итог — в его канале и в Needs you с подписью машины.",
  target: BOLT_TARGET,
  run: ({ ops, target, play, world }) => {
    ops.userSays(target.machine, target.threadId, "Run the landing tests on my Mac");
    void play(boltTests({ ...target, ops, world }));
  },
});
addScene({
  id: "d-bolt-fails",
  title: "Bolt: задача на MacBook упала",
  hint: "Тесты на MacBook падают: в чате на Mac — ошибка, в Inbox — «Failed on MacBook», Bolt предлагает починить там же.",
  target: BOLT_TARGET,
  run: ({ ops, target, play, world }) => {
    ops.userSays(target.machine, target.threadId, "Run the checkout tests before the deploy");
    void play(boltTests({ ...target, ops, world }, true));
  },
});
addScene({
  id: "d-mia-long",
  title: "Mia: длинная задача",
  hint: "Mia отвечает 14 клиентам (3 шага, потом отправка). Посреди можно сменить режим вверху чата или убрать Mia на её странице.",
  target: MIA_TARGET,
  run: ({ ops, target, play, world }) => {
    ops.userSays(target.machine, target.threadId, "Reply to all clients from this week");
    void play(longReplies({ ...target, ops, world }));
  },
});

// ── When the page opens ──────────────────────────────────────────────────

/** The address as opened (before the app's own redirect to Home). */
const OPENED_HASH = typeof location === "undefined" ? "" : location.hash;

onDemoReady(({ openChat }) => {
  const fresh = OPENED_HASH === "" || OPENED_HASH === "#" || OPENED_HASH === "#/";
  if (WORLD.account === "new") {
    // Uno talks first (Duet): a new account opens on its chat, the greeting starts there.
    if (fresh) setTimeout(() => openChat("work", mainChatOfUno()), 900);
    return;
  }
  if (WORLD.tier === "free") {
    // Free: the cloud slept while you were away. What waited comes in now.
    setTimeout(() => {
      const threadId = mainChatOfUno();
      if (fresh) openChat("work", threadId);
      catchUp(threadId);
    }, 900);
  }
});

const mainChatOfUno = () => mainChatOf("work", ASSISTANT_PROJECT_ID) ?? "";

function catchUp(threadId: string) {
  void playWith("work", threadId, (ctx) => [
    {
      run: (inner) =>
        inner.ops.userSays(
          inner.machine,
          inner.threadId,
          "📱 Telegram · 07:42 (waited — your cloud was asleep): did Acme pay?",
        ),
    },
    {
      inbox: {
        id: "i-free-waited",
        kind: "agent.done",
        chat: threadId,
        title: "1 Telegram message waited while your cloud slept",
        body: "Uno answered it when you opened Work. Plus keeps Uno awake.",
      },
    },
    ...dSummary(
      ctx,
      false,
      "Back — your cloud computer was asleep (Free), so your Telegram message waited. Acme hasn't paid yet.\n\n**While you were away.** ",
    ),
  ]);
}
