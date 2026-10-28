/**
 * Variant C (28.10) — the hybrid: one Uno on the account (it lives on the
 * cloud computer that doesn't sleep — one summary, one voice), Uno works on
 * every computer without a setup there (what it does on which computer is
 * seen in the sidebar, the computer switcher and the Inbox), and your own
 * assistants live under Uno: Uno hands them tasks, their reports and their
 * asks come through Uno (one Telegram — Uno's).
 *
 * This file: the team (Mia and Bolt; 12 with `team=many`), Uno's first-run
 * talk (apps → Telegram → the mode), and the variant's scripts and scenes.
 * The UI is in the real components (search `VARIANT_C`).
 */
import { ASSISTANT_PROJECT_ID } from "@t3tools/contracts";

import type { MachineKey } from "../heavyFixtures";
import { liveTeam, onAssistantRevoked } from "./daemon";
import {
  type Script,
  type ScriptContext,
  addScene,
  addTrigger,
  connectorsCard,
  play,
  setGreeting,
  telegramCard,
} from "./engine";
import { DEMO_PERSONAS, type DemoPersona } from "./fixtures";
import { teammateGreeting } from "./variantC/greetings";
import { WORLD, macOnline } from "./world";

export const VARIANT: { readonly id: string; readonly title: string } = {
  id: "c",
  title: "C · Гибрид: главный Uno + свои под ним",
};

const UNO = ASSISTANT_PROJECT_ID;
const isUno = (persona: DemoPersona) => persona.projectId === UNO;

// ── The team under Uno ───────────────────────────────────────────────────

function teammate(
  slug: string,
  name: string,
  emoji: string,
  tone: string,
  role: string,
  character: string,
  preset: "full" | "helper",
  chats: DemoPersona["chats"] = [],
): DemoPersona {
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
    chats,
    preset,
  };
}

const MIA = teammate(
  "mia",
  "Mia",
  "🦉",
  "amber",
  "Secretary",
  "Warm · Brief · Careful",
  // Different from Uno's on purpose: Mia asks before anything goes out.
  "helper",
  [
    {
      id: "mia-main",
      machine: "work",
      project: "assistant-mia",
      title: "Mia",
      minutesAgo: 95,
      state: "read",
      role: "assistant",
      messages: [
        ["user", "Uno: Dana asked to move the 11:00 call. Handle it."],
        ["assistant", "Moved it to 15:00 — Dana confirmed. Told Uno; it's in your summary."],
      ],
    },
  ],
);

const BOLT = teammate("bolt", "Bolt", "🤖", "sky", "Developer", "Direct · Brief · Nerdy", "full", [
  {
    id: "bolt-main",
    machine: "work",
    project: "assistant-bolt",
    title: "Bolt",
    minutesAgo: 60 * 5,
    state: "read",
    role: "assistant",
    messages: [
      ["user", "Uno: CI on orders-bot is red. Have a look."],
      ["assistant", "A flaky date test. Pinned the timezone, CI is green, PR #41 is up."],
    ],
  },
]);

const MORE: ReadonlyArray<DemoPersona> = [
  teammate("leo", "Leo", "🦊", "orange", "Marketer", "Playful · Bold · Chatty", "full"),
  teammate("nova", "Nova", "👽", "teal", "Researcher", "Curious · Careful", "full"),
  teammate("juno", "Juno", "🐼", "slate", "Support", "Patient · Warm · Formal", "helper"),
  teammate("rex", "Rex", "🦖", "emerald", "Sales", "Bold · Direct", "helper"),
  teammate("pip", "Pip", "🐧", "sky", "Bookkeeper", "Careful · Formal", "helper"),
  teammate("iris", "Iris", "🦋", "rose", "Designer", "Playful · Curious", "full"),
  teammate("otto", "Otto", "🐙", "violet", "Ops", "Direct · Careful", "full"),
  teammate("kai", "Kai", "🐬", "teal", "Recruiter", "Warm · Chatty", "helper"),
  teammate("lumi", "Lumi", "✨", "amber", "Writer", "Playful · Chatty", "full"),
  teammate("sage", "Sage", "🌿", "emerald", "Coach", "Warm · Patient", "full"),
];

if (WORLD.account === "live" && WORLD.team !== "none") {
  DEMO_PERSONAS.push(MIA, BOLT);
  if (WORLD.team === "many") DEMO_PERSONAS.push(...MORE);
}

// ── First run: Uno introduces itself in a chat ───────────────────────────

/** The mode, simply: two choices (Misha 27.10 — exactly two). */
export function modeCard(ctx: ScriptContext, after: Script = []): Script {
  return [
    {
      ask: "Last thing. When I'm about to send, pay or delete something — do it, or ask you first?",
      question: {
        id: "mode",
        header: "Mode",
        question: "How should I work?",
        options: [
          { label: "Does it itself", description: "Acts, then tells you what it did" },
          {
            label: "Asks first",
            description: "Waits for your OK before it sends, pays or deletes",
          },
        ],
      },
      then: (answer, inner) => {
        const asks = /ask/i.test(answer);
        return [
          {
            run: () =>
              inner.ops.setPreset(inner.machine, inner.persona.projectId, asks ? "helper" : "full"),
          },
          {
            say: asks
              ? "Done — I'll ask first. Change it any time at the top of this chat."
              : "Done — I'll act and tell you after. Change it any time at the top of this chat.",
          },
          ...after,
        ];
      },
    },
  ];
}

function unoGreeting(ctx: ScriptContext): Script {
  const free = ctx.world.tier === "free";
  return [
    {
      say: "Hi, I'm Uno. I live on uno-work, your cloud computer, and I can use your other computers too — nothing to set up on them.",
      delay: 900,
    },
    ...connectorsCard(ctx, [
      ...telegramCard(ctx, [
        ...modeCard(ctx, [
          ...(free
            ? [
                {
                  say: "One honest note: on Free, uno-work sleeps when you leave. I can't write first or answer Telegram until you open Work — then I catch up. Plus keeps me awake.",
                },
              ]
            : []),
          { say: "So — what's on fire today? One line is enough." },
        ]),
      ]),
    ]),
  ];
}

setGreeting((ctx) => (isUno(ctx.persona) ? unoGreeting(ctx) : teammateGreeting(ctx)));

// ── Uno hands a task to a teammate; the report comes back through Uno ────

interface Running {
  readonly machine: MachineKey;
  readonly childId: string;
  readonly title: string;
  readonly result: string;
}
/** What each teammate is doing for Uno now (removed mid-task → Uno takes it over). */
const runningFor = new Map<string, Running>();
let unoChat: { machine: MachineKey; threadId: string; ops: ScriptContext["ops"] } | null = null;

interface TeamJob {
  readonly title: string;
  readonly prompt: string;
  readonly steps: ReadonlyArray<string>;
  readonly act: { readonly command: string; readonly why: string } | null;
  readonly result: string;
}

function jobFor(persona: DemoPersona, slow: boolean): TeamJob {
  const role = persona.roles[0] ?? "";
  if (slow) {
    return {
      title: "Compare 3 packaging suppliers",
      prompt: "Compare the 3 packaging suppliers from Drive and pick one.",
      steps: [
        "Reading the 3 quotes in Drive…",
        "Checking reviews for PackRight…",
        "Checking reviews for BoxCo…",
        "Checking reviews for Cartonly…",
        "Comparing prices for 500 and 2,000 boxes…",
      ],
      act: null,
      result:
        "BoxCo: 8% dearer than PackRight, but PackRight has 14 late-delivery reviews. Table in Drive / Suppliers.",
    };
  }
  if (/secret/i.test(role)) {
    return {
      title: "Reply to Acme about invoice #1042",
      prompt: "Acme is 5 days late on #1042. Send the gentle reminder from Drafts.",
      steps: ["Opening Gmail → Drafts…", "Checking the amount: $1,200, due Oct 22…"],
      act: {
        command: "Send an email to billing@acme.example — “Invoice #1042 — a gentle reminder”",
        why: "It goes out from your Gmail, to a client.",
      },
      result: "Sent the reminder to Acme. I'll flag it if they don't answer by Friday.",
    };
  }
  if (/develop/i.test(role)) {
    return {
      title: "Fix the failing test on landing",
      prompt: "CI on landing is red. Fix it and push.",
      steps: [
        "Cloning github.com/misha-demo/landing…",
        "Running tests: 1 of 42 fails…",
        "Fixed: a stale snapshot.",
      ],
      act: {
        command: "Push to github.com/misha-demo/landing (main)",
        why: "It changes your live repository.",
      },
      result: "CI is green again — pushed the fix to main.",
    };
  }
  return {
    title: `A task for ${persona.name}`,
    prompt: "Look into it and report back.",
    steps: ["On it…", "Almost done…"],
    act: null,
    result: "Done — notes are in its folder.",
  };
}

function nameIn(text: string): { machine: MachineKey; persona: DemoPersona } | null {
  return (
    liveTeam().find(
      ({ persona }) => !isUno(persona) && new RegExp(`\\b${persona.name}\\b`, "i").test(text),
    ) ?? null
  );
}

/** Uno gives `persona` the job: a chat in its folder, its own mode, the result back to Uno. */
function delegate(
  ctx: ScriptContext,
  target: { machine: MachineKey; persona: DemoPersona },
  slow = false,
): Script {
  const job = jobFor(target.persona, slow);
  const name = target.persona.name;
  return [
    { work: `Giving it to ${name}…`, delay: 600 },
    {
      run: (inner) => {
        unoChat = { machine: inner.machine, threadId: inner.threadId, ops: inner.ops };
        const childId = `${target.persona.projectId}-task-${Date.now().toString(36)}`;
        inner.ops.createThread(target.machine, {
          threadId: childId,
          projectId: target.persona.projectId,
          title: job.title,
          assistantRole: "spawned",
          spawnedBy: inner.threadId,
        });
        inner.ops.userSays(target.machine, childId, `Uno: ${job.prompt}`);
        runningFor.set(target.persona.projectId, {
          machine: target.machine,
          childId,
          title: job.title,
          result: job.result,
        });
        const report = (result: string): Script => [
          {
            run: (teammateCtx) => {
              runningFor.delete(teammateCtx.persona.projectId);
              teammateCtx.ops.addInbox({
                id: `i-team-${childId}`,
                machine: inner.machine,
                kind: "agent.done",
                chat: inner.threadId,
                title: `${name} via Uno: ${job.title}`,
                body: result,
              });
              void play(inner.machine, inner.threadId, [
                { say: `${name} finished “${job.title}”: ${result}`, delay: 700 },
              ]);
            },
          },
        ];
        const steps: Script = [
          ...job.steps.map((line) => ({ work: line, delay: slow ? 6000 : 1300 })),
          ...(job.act
            ? [
                {
                  act: job.act,
                  allowed: [{ say: job.result }, ...report(job.result)],
                  declined: [
                    { say: "OK, not doing it. It stays as a draft." },
                    ...report("You said no — nothing went out. It stays as a draft."),
                  ],
                },
              ]
            : [{ say: job.result }, ...report(job.result)]),
        ];
        void play(target.machine, childId, steps);
      },
    },
    {
      say: `${name} has it: “${job.title}”. ${name} reports back here${
        target.persona.preset === "helper" ? " and asks you before anything goes out" : ""
      }.`,
    },
  ];
}

addTrigger({
  id: "c-delegate",
  persona: UNO,
  // "Ask Mia to…", "give it to Bolt" — a teammate's name in the words.
  match: (text) => nameIn(text) !== null,
  script: (ctx, text) => delegate(ctx, nameIn(text)!, /supplier|compare/i.test(text)),
});

// Removed mid-task: the teammate stops, Uno takes the task over and finishes it.
onAssistantRevoked((_machine, persona) => {
  const running = runningFor.get(persona.projectId);
  runningFor.delete(persona.projectId);
  if (!running || !unoChat) return;
  const chat = unoChat;
  // Its chat ends there, saying so (not a forever-running turn).
  chat.ops.say(
    running.machine,
    running.childId,
    `Stopped: ${persona.name} was removed from the team. Uno took this over.`,
  );
  void play(chat.machine, chat.threadId, [
    {
      work: `${persona.name} is off the team. ${persona.name} was on “${running.title}” — I'm taking it over.`,
      delay: 500,
    },
    { work: "Picking up where it stopped…", delay: 1800 },
    { say: `Finished “${running.title}” myself: ${running.result}` },
  ]);
});

// ── Uno on another computer: the job fails there ────────────────────────

function failsOnMac(ctx: ScriptContext): Script {
  if (!macOnline(ctx.world)) {
    return [
      { say: "Your MacBook is asleep, so I can't build there. I'll run it on uno-work instead." },
      ...buildOnWork(),
    ];
  }
  const childId = `mac-build-${Date.now().toString(36)}`;
  return [
    { work: "Starting “Build the landing” on MacBook…", delay: 700 },
    {
      run: (inner) => {
        inner.ops.createThread("mac", {
          threadId: childId,
          projectId: "p-mac-landing",
          title: "Build the landing",
          assistantRole: "spawned",
          spawnedBy: inner.threadId,
        });
        inner.ops.userSays("mac", childId, "Uno: Build the landing and publish the preview.");
        inner.ops.working("mac", childId, "npm run build…");
      },
    },
    { work: "Building on MacBook…", delay: 2400 },
    {
      run: (inner) => {
        inner.ops.fail(
          "mac",
          childId,
          "npm run build: ENOSPC — no space left on device (1.2 GB free).",
        );
        inner.ops.addInbox({
          id: `i-mac-fail-${Date.now()}`,
          machine: "mac",
          kind: "agent.error",
          chat: childId,
          title: "Failed on MacBook: Build the landing",
          body: "npm run build: no space left on device (1.2 GB free). Nothing was published.",
        });
      },
    },
    {
      ask: "It failed on MacBook: `npm run build` ran out of disk (1.2 GB free). Nothing was published. Run it on uno-work instead?",
      question: {
        id: "mac-failed",
        header: "MacBook",
        question: "Where now?",
        options: [
          { label: "Run on uno-work", description: "From GitHub, same code" },
          { label: "Leave it", description: "I'll clear space on the Mac" },
        ],
      },
      then: (answer) =>
        /uno-work/i.test(answer)
          ? buildOnWork()
          : [{ say: "OK. Free ~3 GB on the Mac and tell me — I'll run it again there." }],
    },
  ];
}

function buildOnWork(): Script {
  return [
    {
      elsewhere: {
        machine: "work",
        projectId: "p-work-landing",
        title: "Build the landing",
        prompt: "Build the landing from GitHub and publish the preview.",
        steps: ["Pulling github.com/misha-demo/landing…", "npm run build… done in 41 s"],
        result: "Built on uno-work. Preview: landing-misha.uno4.me.",
      },
    },
  ];
}

addTrigger({
  id: "c-build-mac",
  persona: UNO,
  match: /build.*(mac|landing)|landing.*build/i,
  script: failsOnMac,
});

// ── A long task (the "change the mode mid-task" edge) ────────────────────

function investorUpdate(): Script {
  return [
    { work: "Collecting October numbers from Drive…", delay: 2600 },
    { work: "Writing the investor update (MRR $190, 12 paying)…", delay: 3200 },
    { work: "Draft ready. Next: sending it to 4 investors.", delay: 3200 },
    {
      act: {
        command: "Send “October update” to 4 investors",
        why: "It goes out from your Gmail, to 4 people outside the company.",
      },
      allowed: [{ say: "Sent the October update to 4 investors. Copy in Gmail → Sent." }],
      declined: [{ say: "Not sent. The draft is in Gmail → Drafts." }],
    },
  ];
}

addTrigger({
  id: "c-investor-update",
  persona: UNO,
  match: /investor|update to/i,
  script: () => investorUpdate(),
});

// ── Scenes ───────────────────────────────────────────────────────────────

/** Uno's morning summary in C: one summary, what happened on each computer and what the team did. */
function cMorning(ctx: ScriptContext): Script {
  const team = liveTeam().filter(({ persona }) => !isUno(persona));
  const mia = team.find(({ persona }) => persona.name === "Mia");
  const bolt = team.find(({ persona }) => persona.name === "Bolt");
  const lines = [
    ctx.ops.connectorState("gmail") === "on"
      ? "- Mail: Acme hasn't paid invoice #1042 (5 days late)."
      : "- Mail: I can't read it — Gmail needs you to sign in again.",
    macOnline(ctx.world)
      ? "- MacBook: the landing build broke overnight — I fixed it there, it's green."
      : "- MacBook is asleep — its work waits; the rest ran on uno-work.",
    "- uno-work: 212 orders exported to Drive at 07:00.",
    ...(mia ? ["- Mia: moved your 11:00 with Dana to 15:00."] : []),
    ...(bolt ? ["- Bolt: orders-bot CI is green, PR #41 is up."] : []),
  ];
  return [
    { work: "Reading mail and checking your computers…" },
    {
      say: `Good morning. One summary for everything:\n\n${lines.join("\n")}\n\nOne thing needs you: the Acme reminder. Say “send it” and it goes.`,
    },
    {
      inbox: {
        id: `i-c-morning-${Date.now()}`,
        kind: "agent.done",
        chat: ctx.threadId,
        title: "Uno: your morning summary",
        body: ctx.ops.telegramLinked("work", UNO)
          ? "Also sent to your Telegram."
          : "Link Telegram to get it on your phone at 08:00.",
      },
    },
  ];
}

/** Free: uno-work slept; on opening Work Uno catches up — the summary, and the messages that waited. */
function freeWake(ctx: ScriptContext): Script {
  return [
    { work: "uno-work just woke up — catching up…", delay: 800 },
    {
      say: "Welcome back. uno-work slept from 23:10 until you opened Work, so I couldn't write at 08:00. Here's what waited:\n\n- Mail: Acme hasn't paid invoice #1042 (5 days late).\n- 2 Telegram messages from last night — answering them now.\n- orders-bot export didn't run at 07:00 — running it now.",
    },
    {
      ask: "Want me awake when you're not? On Plus, uno-work never sleeps: the summary comes at 08:00 and I answer Telegram right away.",
      question: {
        id: "plus",
        header: "Plus",
        question: "Keep Uno awake",
        options: [
          { label: "See Plus", description: "uno-work stays on" },
          { label: "Stay on Free", description: "I catch up when you open Work" },
        ],
        skippable: true,
      },
      then: (answer) =>
        /plus/i.test(answer)
          ? [
              {
                run: () => {
                  window.open("https://console.uno4.dev/billing?tab=plan", "_blank");
                },
              },
              { say: "Opened your plan. Nothing changes until you confirm there." },
            ]
          : [{ say: "Fine — I'll catch up each time you open Work." }],
    },
  ];
}

addScene({
  id: "c-morning",
  title: "C · Утренняя сводка Uno",
  hint: "Одна сводка: что было на каждом компьютере и что сделали свои ассистенты (Mia, Bolt) — всё через Uno.",
  run: ({ play: run, target, ops, world }) => void run(cMorning({ ...target, ops, world })),
});

addScene({
  id: "c-free-wake",
  title: "C · Free: облако проснулось",
  hint: "На Free uno-work спал ночью: сводка приходит при открытии Work, сообщения из Telegram ждали. Честно и с путём в Plus.",
  run: ({ play: run, target, ops, world }) => void run(freeWake({ ...target, ops, world })),
});

addScene({
  id: "c-delegate",
  title: "C · Задача своему ассистенту через Uno",
  hint: "Ты пишешь Uno «попроси Mia ответить Acme» — Uno отдаёт Mia, у Mia свой режим (Спрашивает), отчёт возвращается в чат Uno.",
  run: ({ ops, target, play: run, world }) => {
    ops.userSays(target.machine, target.threadId, "Ask Mia to send the Acme reminder");
    const mia = liveTeam().find(({ persona }) => persona.name === "Mia");
    void run(
      mia
        ? delegate({ ...target, ops, world }, mia)
        : [{ say: "Mia isn't on your team. Add her from New teammate." }],
    );
  },
});

addScene({
  id: "c-mia-slow",
  title: "C · Долгая задача у Mia",
  hint: "Uno отдаёт Mia сравнение поставщиков (~15 с). Убери Mia посреди задачи — Uno доделает сам.",
  run: ({ ops, target, play: run, world }) => {
    ops.userSays(target.machine, target.threadId, "Ask Mia to compare the 3 suppliers");
    const mia = liveTeam().find(({ persona }) => persona.name === "Mia");
    if (mia) void run(delegate({ ...target, ops, world }, mia, true));
  },
});

addScene({
  id: "c-mac-fails",
  title: "C · Задача на MacBook упала",
  hint: "Uno запускает сборку на MacBook, там кончилось место — ошибка в Inbox с подписью машины, Uno предлагает uno-work.",
  run: ({ ops, target, play: run, world }) => {
    ops.userSays(target.machine, target.threadId, "Build the landing on my Mac");
    void run(failsOnMac({ ...target, ops, world }));
  },
});

addScene({
  id: "c-investor",
  title: "C · Долгая задача Uno (смени режим посреди)",
  hint: "Uno ~10 с готовит письмо инвесторам. Переключи режим в шапке чата посреди — отправка спросит или не спросит.",
  run: ({ ops, target, play: run }) => {
    ops.userSays(target.machine, target.threadId, "Write and send the October investor update");
    void run(investorUpdate());
  },
});

/** Opens on its own with the page: Free's catch-up when you open Work. */
export const AUTO_SCENE: string | null =
  WORLD.account === "live" && WORLD.tier === "free" ? "c-free-wake" : null;
