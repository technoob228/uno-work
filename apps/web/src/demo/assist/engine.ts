/**
 * The assistants base (28.10): the scripted "brain" of every assistant in the
 * demo. The real chat sends a turn / an answer / an Allow; demoBoot hands it
 * here; a script answers with the same events a real agent sends (messages,
 * a running turn, quiz cards with Connect, Allow cards, a chat on another
 * computer, an error), with delays like a real one. Deterministic: the same
 * words give the same replies.
 *
 * Works for any number of assistants: a script gets the persona (name,
 * computer) in its context, and a variant can add triggers and scenes of its
 * own (`addTrigger`, `addScene`) — see README_DEMO.md.
 */
import type { MachineKey } from "../heavyFixtures";
import type { DemoPersona } from "./fixtures";
import { type AssistWorld, type ConnectorProvider, WORLD, macOnline } from "./world";

// ── What demoBoot gives the engine (its chats and Inbox) ──────────────────

export interface DemoQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
  readonly detail?: string;
  readonly input?: {
    readonly placeholder: string;
    readonly kind?: "text" | "email" | "url" | "time";
  };
  readonly connect?: {
    readonly provider: string;
    readonly name: string;
    readonly doneLabel: string;
  };
  readonly skippable?: boolean;
}

export interface DemoInboxInput {
  readonly id: string;
  readonly machine: MachineKey;
  readonly kind: "agent.done" | "agent.approval" | "agent.input" | "agent.error" | "app";
  readonly title: string;
  readonly body: string | null;
  readonly chat?: string;
}

export interface ChatOps {
  /** A new chat in a folder of that computer (an assistant's, or a project's). */
  readonly createThread: (
    machine: MachineKey,
    input: {
      readonly threadId: string;
      readonly projectId: string;
      readonly title: string;
      /** `chat`: an assistant's main chat; `spawned`: one an assistant started. */
      readonly assistantRole?: "chat" | "spawned" | null;
      readonly spawnedBy?: string | null;
    },
  ) => void;
  /** The person's line arrives without the composer (a Telegram message). */
  readonly userSays: (machine: MachineKey, threadId: string, text: string) => void;
  /** The agent is working (a running turn); with `text`, it says that line while it works. */
  readonly working: (machine: MachineKey, threadId: string, text?: string) => void;
  /** The agent finishes its turn with `text`. */
  readonly say: (machine: MachineKey, threadId: string, text: string) => void;
  /** It says `text` and waits for an answer (a quiz card; Connect, a field). */
  readonly ask: (
    machine: MachineKey,
    threadId: string,
    text: string,
    question: DemoQuestion,
  ) => void;
  /** It stops for an Allow of `command` (the real approval card). */
  readonly askApproval: (
    machine: MachineKey,
    threadId: string,
    command: string,
    explanation: string,
  ) => void;
  /** The pending Allow / question is answered: resolved, the turn goes on. */
  readonly resolve: (machine: MachineKey, threadId: string) => void;
  /** The turn ends in an error (the chat shows it as a real failure). */
  readonly fail: (machine: MachineKey, threadId: string, error: string) => void;
  readonly addInbox: (item: DemoInboxInput) => void;
  /** The project id of a chat (to know whose it is). */
  readonly projectOf: (machine: MachineKey, threadId: string) => string | null;
  /** Telegram linked / unlinked for an assistant (its daemon's record). */
  readonly setTelegram: (machine: MachineKey, projectId: string, linked: boolean) => void;
  readonly connectorState: (provider: ConnectorProvider) => "on" | "off" | "expired";
  /** Ask first (Helper/Observer) or does it itself (Full) — its daemon's preset. */
  readonly asksFirst: (machine: MachineKey, projectId: string) => boolean;
  readonly telegramLinked: (machine: MachineKey, projectId: string) => boolean;
  /** Variant A: removed — its scripts stop where they are. */
  readonly gone: (machine: MachineKey, projectId: string) => boolean;
  /** Variant A: its mode from a card in the chat ("Does it itself" / "Asks first"). */
  readonly setMode: (machine: MachineKey, projectId: string, asksFirst: boolean) => void;
  /** Variant A: may it use that computer as its hands. */
  readonly handAllowed: (projectId: string, machine: MachineKey) => boolean;
  /** The page asks its computers again (after the demo changed something behind it). */
  readonly refresh: () => void;
}

// ── Scripts ───────────────────────────────────────────────────────────────

export interface ScriptContext {
  readonly machine: MachineKey;
  readonly threadId: string;
  readonly persona: DemoPersona;
  readonly world: AssistWorld;
  readonly ops: ChatOps;
}

export type Step =
  /** It says a line and ends its turn. */
  | { readonly say: string; readonly delay?: number }
  /** It says a line and keeps working (a running turn). */
  | { readonly work: string; readonly delay?: number }
  /** A quiz card; the answer picks what comes next. */
  | {
      readonly ask: string;
      readonly question: DemoQuestion;
      readonly then: (answer: string, ctx: ScriptContext) => Script;
      readonly delay?: number;
    }
  /**
   * An outward action. "Does it itself": done at once. "Asks first": the
   * Allow card in the chat + an Inbox card (+ Telegram when linked); it waits
   * there — even with no Work open — and never refuses by itself.
   */
  | {
      readonly act: { readonly command: string; readonly why: string };
      readonly allowed: Script;
      readonly declined: Script;
      readonly delay?: number;
    }
  /** A chat on another computer: it starts there, works in steps, its result comes back here. */
  | {
      readonly elsewhere: {
        readonly machine: MachineKey;
        readonly projectId: string;
        readonly title: string;
        readonly prompt: string;
        readonly steps: ReadonlyArray<string>;
        readonly result: string;
        /** Variant A: it fails there with this error instead (the result never comes). */
        readonly fails?: string;
      };
      /** What it says / offers after a failure there. */
      readonly onFail?: Script;
      readonly delay?: number;
    }
  /** The turn fails with this error. */
  | { readonly fail: string; readonly delay?: number }
  | { readonly inbox: Omit<DemoInboxInput, "machine"> & { readonly machine?: MachineKey } }
  /** Anything else (link Telegram, …). */
  | { readonly run: (ctx: ScriptContext) => void; readonly delay?: number };

export type Script = ReadonlyArray<Step>;

/** Typing time of a reply: a short pause plus its length, capped (a real model's pace). */
export function replyDelay(text: string): number {
  return Math.min(700 + text.length * 9, 2600);
}

let speed = 1;
/** Playwright flows run the scripts faster (`?speed=4`); the people's demo keeps the real pace. */
export function setEngineSpeed(value: number) {
  speed = value > 0 ? value : 1;
}
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms / speed));

/** Waiting for the person: the question's or the Allow's continuation, by chat. */
const pending = new Map<
  string,
  | { readonly kind: "ask"; readonly ctx: ScriptContext; readonly next: (answer: string) => Script }
  | {
      readonly kind: "act";
      readonly ctx: ScriptContext;
      readonly allowed: Script;
      readonly declined: Script;
    }
>();
const keyOf = (machine: MachineKey, threadId: string) => `${machine}:${threadId}`;

async function runSteps(ctx: ScriptContext, script: Script): Promise<void> {
  const { ops, machine, threadId } = ctx;
  for (const step of script) {
    // Removed mid-task: nothing more happens (demoBoot already stopped its turn).
    if (ops.gone(machine, ctx.persona.projectId)) return;
    if ("say" in step) {
      ops.working(machine, threadId);
      await wait(step.delay ?? replyDelay(step.say));
      if (ops.gone(machine, ctx.persona.projectId)) return;
      ops.say(machine, threadId, step.say);
    } else if ("work" in step) {
      await wait(step.delay ?? replyDelay(step.work));
      if (ops.gone(machine, ctx.persona.projectId)) return;
      ops.working(machine, threadId, step.work);
    } else if ("ask" in step) {
      ops.working(machine, threadId);
      await wait(step.delay ?? replyDelay(step.ask));
      if (ops.gone(machine, ctx.persona.projectId)) return;
      pending.set(keyOf(machine, threadId), {
        kind: "ask",
        ctx,
        next: (answer) => step.then(answer, ctx),
      });
      ops.ask(machine, threadId, step.ask, step.question);
      return;
    } else if ("act" in step) {
      await wait(step.delay ?? 900);
      if (ops.gone(machine, ctx.persona.projectId)) return;
      if (!ops.asksFirst(machine, ctx.persona.projectId)) {
        await runSteps(ctx, step.allowed);
        return;
      }
      pending.set(keyOf(machine, threadId), {
        kind: "act",
        ctx,
        allowed: step.allowed,
        declined: step.declined,
      });
      ops.askApproval(machine, threadId, step.act.command, step.act.why);
      const viaTelegram = ops.telegramLinked(machine, ctx.persona.projectId);
      ops.addInbox({
        id: `i-allow-${threadId}-${Date.now()}`,
        machine,
        kind: "agent.approval",
        chat: threadId,
        title: `${ctx.persona.name} asks: ${step.act.command}`,
        body: viaTelegram
          ? `${step.act.why} Also sent to your Telegram — answer there or here.`
          : `${step.act.why} It waits for you here.`,
      });
      return;
    } else if ("elsewhere" in step) {
      const job = step.elsewhere;
      await wait(step.delay ?? 900);
      const childId = `${job.machine}-job-${Date.now().toString(36)}`;
      ops.createThread(job.machine, {
        threadId: childId,
        projectId: job.projectId,
        title: job.title,
        assistantRole: "spawned",
        spawnedBy: threadId,
      });
      ops.userSays(job.machine, childId, `${ctx.persona.name}: ${job.prompt}`);
      ops.working(
        machine,
        threadId,
        `Started “${job.title}” on ${machineName(job.machine)}. I'll tell you when it's done.`,
      );
      for (const line of job.steps) {
        await wait(1500);
        ops.working(job.machine, childId, line);
      }
      await wait(1400);
      if (job.fails) {
        ops.fail(job.machine, childId, job.fails);
        ops.addInbox({
          id: `i-job-${childId}`,
          machine: job.machine,
          kind: "agent.error",
          chat: childId,
          title: `Failed on ${machineName(job.machine)}: ${job.title}`,
          body: job.fails,
        });
        await wait(900);
        ops.working(machine, threadId);
        await runSteps(ctx, [
          { say: `It failed on ${machineName(job.machine)}: ${job.fails}`, delay: 600 },
          ...(step.onFail ?? []),
        ]);
        return;
      }
      ops.say(job.machine, childId, job.result);
      ops.addInbox({
        id: `i-job-${childId}`,
        machine: job.machine,
        kind: "agent.done",
        chat: childId,
        title: `Finished on ${machineName(job.machine)}: ${job.title}`,
        body: job.result,
      });
      await wait(900);
      ops.say(machine, threadId, `Done on ${machineName(job.machine)}: ${job.result}`);
    } else if ("fail" in step) {
      ops.working(machine, threadId);
      await wait(step.delay ?? 2200);
      ops.fail(machine, threadId, step.fail);
      return;
    } else if ("inbox" in step) {
      ops.addInbox({ machine, ...step.inbox });
    } else if ("run" in step) {
      if (step.delay) await wait(step.delay);
      step.run(ctx);
    }
  }
}

const NAMES: Record<MachineKey, string> = {
  work: "uno-work",
  mac: "MacBook",
  product: "free-cloud",
};
export const machineName = (machine: MachineKey) => NAMES[machine];

// ── Triggers: what the person writes → which script ─────────────────────

export interface Trigger {
  readonly id: string;
  /** What the person's words must match (case-insensitive). */
  readonly match: RegExp;
  /** Only for this assistant (its folder id), or any. */
  readonly persona?: string;
  readonly script: (ctx: ScriptContext, text: string) => Script;
}

/** A thing that happens without the person typing (from the panel or a flow). */
export interface Scene {
  readonly id: string;
  /** For the panel (Russian, for Misha). */
  readonly title: string;
  readonly hint: string;
  readonly run: (input: SceneInput) => void;
}

export interface SceneInput {
  readonly ops: ChatOps;
  readonly world: AssistWorld;
  /** The assistant and its main chat to play it in (Uno on uno-work by default). */
  readonly target: {
    readonly machine: MachineKey;
    readonly threadId: string;
    readonly persona: DemoPersona;
  };
  readonly play: (script: Script) => Promise<void>;
}

const triggers: Trigger[] = [];
const scenes: Scene[] = [];

/** A variant's own trigger goes first (wins over the base's). */
export function addTrigger(trigger: Trigger) {
  triggers.unshift(trigger);
}
/** A variant's scene; one with the same id as the base's takes its place. */
export function addScene(scene: Scene) {
  const index = scenes.findIndex((item) => item.id === scene.id);
  if (index >= 0) scenes[index] = scene;
  else scenes.push(scene);
}
export function listScenes(): ReadonlyArray<Scene> {
  return scenes;
}

// ── The engine ───────────────────────────────────────────────────────────

let ops: ChatOps | null = null;
let personaOf: (machine: MachineKey, projectId: string) => DemoPersona | null = () => null;

let greeting: (ctx: ScriptContext) => Script = (ctx) => greetingScript(ctx);
/** What an assistant says first in a new chat of its own (a variant may change it). */
export function setGreeting(script: (ctx: ScriptContext) => Script) {
  greeting = script;
}
let channelGreeting: (ctx: ScriptContext, title: string) => Script = (_ctx, title) => [
  { say: `This is #${title}. Everything about ${title} goes here.` },
];
/** Variant A: what Uno says in a new channel of its own. */
export function setChannelGreeting(script: (ctx: ScriptContext, title: string) => Script) {
  channelGreeting = script;
}
export function greetChannel(machine: MachineKey, threadId: string, title: string): Promise<void> {
  const ctx = contextOf(machine, threadId);
  return ctx ? runSteps(ctx, channelGreeting(ctx, title)) : Promise.resolve();
}

/** Its first words in a new main chat / setup chat. */
export function greet(machine: MachineKey, threadId: string): Promise<void> {
  const ctx = contextOf(machine, threadId);
  return ctx ? runSteps(ctx, greeting(ctx)) : Promise.resolve();
}

export function startEngine(input: {
  readonly ops: ChatOps;
  readonly personaOf: (machine: MachineKey, projectId: string) => DemoPersona | null;
}) {
  ops = input.ops;
  personaOf = input.personaOf;
}

function contextOf(machine: MachineKey, threadId: string): ScriptContext | null {
  if (!ops) return null;
  const projectId = ops.projectOf(machine, threadId);
  if (!projectId) return null;
  const persona = personaOf(machine, projectId);
  if (!persona) return null;
  return { machine, threadId, persona, world: WORLD, ops };
}

/** Plays a script in a chat (scenes, the greeting, a variant's own flows). */
export function play(machine: MachineKey, threadId: string, script: Script): Promise<void> {
  const ctx = contextOf(machine, threadId);
  if (!ctx) return Promise.resolve();
  return runSteps(ctx, script);
}

/**
 * The person wrote in a chat. True: an assistant's script answers (the
 * caller doesn't add its generic reply). A chat outside an assistant's
 * folder answers with the generic reply.
 */
export function onTurn(machine: MachineKey, threadId: string, text: string): boolean {
  const ctx = contextOf(machine, threadId);
  if (!ctx) return false;
  pending.delete(keyOf(machine, threadId));
  const trigger =
    triggers.find(
      (item) =>
        (item.persona === undefined || item.persona === ctx.persona.projectId) &&
        item.match.test(text),
    ) ?? null;
  const script = trigger ? trigger.script(ctx, text) : fallback(ctx);
  void runSteps(ctx, script);
  return true;
}

/** The answer to its quiz card. True: the script goes on (the caller adds nothing). */
export function onAnswer(machine: MachineKey, threadId: string, answer: string): boolean {
  const key = keyOf(machine, threadId);
  const wait = pending.get(key);
  if (!wait || wait.kind !== "ask") return false;
  pending.delete(key);
  void runSteps(wait.ctx, wait.next(answer));
  return true;
}

/** Allow / Decline on its card (in the chat or the Inbox). True: handled here. */
export function onApproval(machine: MachineKey, threadId: string, allowed: boolean): boolean {
  const key = keyOf(machine, threadId);
  const wait = pending.get(key);
  if (!wait || wait.kind !== "act") return false;
  pending.delete(key);
  wait.ctx.ops.resolve(machine, threadId);
  void runSteps(wait.ctx, allowed ? wait.allowed : wait.declined);
  return true;
}

function fallback(ctx: ScriptContext): Script {
  return [
    {
      say: `Got it. (This is a demo, ${ctx.persona.name} answers a few things for real: “morning summary”, “send the Acme reminder”, “export the deck on my Mac”, “connect my apps”, “connect Telegram”, “break something”.)`,
    },
  ];
}

// ── The base scripts (any assistant) ─────────────────────────────────────

const CONNECTOR_NAME: Record<ConnectorProvider, string> = {
  gmail: "Gmail & Calendar",
  "google-drive": "Google Drive",
  notion: "Notion",
  github: "GitHub",
};

/** The first app it offers: Gmail when it's off or expired, else the next one off. */
function appToOffer(ctx: ScriptContext): ConnectorProvider | null {
  const order: ConnectorProvider[] = ["gmail", "google-drive", "notion", "github"];
  return order.find((provider) => ctx.ops.connectorState(provider) !== "on") ?? null;
}

/** The connectors card: Connect inside the chat (the real Connect flow), or Later. */
export function connectorsCard(ctx: ScriptContext, after: Script = []): Script {
  const provider = appToOffer(ctx);
  if (provider === null)
    return [{ say: "Your apps are all connected — Gmail, Drive, Notion and GitHub." }, ...after];
  const name = CONNECTOR_NAME[provider];
  const expired = ctx.ops.connectorState(provider) === "expired";
  return [
    {
      ask: expired
        ? `${name} ended its sign-in — I can't read your mail until you connect it again.`
        : `To be useful I need your mail and calendar. Connect ${name}? I only read until you ask me to send.`,
      question: {
        id: `connect-${provider}`,
        header: "Apps",
        question: expired ? `Sign in to ${name} again` : `Connect ${name}`,
        detail:
          "It opens Google's own page. You can turn it off any time in Settings → Connectors.",
        options: [{ label: "Later", description: "Ask me another time" }],
        connect: { provider, name, doneLabel: `Connected ${name}` },
        skippable: true,
      },
      then: (answer) =>
        /^connected/i.test(answer)
          ? [
              {
                say: `${name} is connected. I'll look at today's mail and calendar for your summary.`,
              },
              ...after,
            ]
          : [{ say: "OK, later. I'll ask again when I need it." }, ...after],
    },
  ];
}

/** The Telegram card: one tap links Uno's bot (no token, no BotFather). */
export function telegramCard(ctx: ScriptContext, after: Script = []): Script {
  if (ctx.ops.telegramLinked(ctx.machine, ctx.persona.projectId)) {
    return [
      {
        say: `We're already linked in Telegram (@uno_team_bot). I write there only when it matters.`,
      },
      ...after,
    ];
  }
  return [
    {
      ask: "Want me in Telegram too? I'll only ping you there for decisions and the morning summary.",
      question: {
        id: "telegram",
        header: "Telegram",
        question: "Talk to me in Telegram",
        detail: "Opens @uno_team_bot — press Start, that's it.",
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
              { say: "Linked: @uno_team_bot. Write me there any time." },
              ...after,
            ]
          : [{ say: "Fine — I'm here whenever you open Work." }, ...after],
    },
  ];
}

/** Hello on a new account: who it is, the apps card, the Telegram card, then "what's burning". */
export function greetingScript(ctx: ScriptContext): Script {
  const where = machineName(ctx.machine);
  return [
    {
      say: `Hi, I'm ${ctx.persona.name}. I live on ${where} and I'm awake when you're not — I can read your mail, keep your projects moving and do tasks on any of your computers.`,
      delay: 900,
    },
    ...connectorsCard(ctx, [
      ...telegramCard(ctx, [
        { say: "So — what's burning today? Tell me in a line, or say “morning summary”." },
      ]),
    ]),
  ];
}

export function morningSummary(ctx: ScriptContext, proactive = false): Script {
  const gmail = ctx.ops.connectorState("gmail");
  const lines: string[] = [];
  if (gmail === "on")
    lines.push("• Mail: Acme hasn't paid invoice #1042 (5 days late); 2 newsletters, skipped.");
  if (gmail === "on") lines.push("• Calendar: call with Dana at 15:00.");
  lines.push(
    macOnline(ctx.world)
      ? "• MacBook: the landing build is green again."
      : "• MacBook is asleep — its chats wait; everything else runs here on uno-work.",
  );
  lines.push("• orders-bot: 212 orders exported to Drive at 07:00.");
  const summary: Script = [
    {
      work:
        gmail === "on"
          ? "Reading mail, calendar and your computers…"
          : "Looking at your computers and projects…",
    },
    { say: `${proactive ? "Good morning. " : ""}Here's today:\n${lines.join("\n")}` },
  ];
  if (gmail !== "on") return [...summary, ...connectorsCard(ctx)];
  if (proactive && ctx.ops.telegramLinked(ctx.machine, ctx.persona.projectId)) {
    return [
      ...summary,
      {
        inbox: {
          id: `i-summary-${Date.now()}`,
          kind: "agent.done",
          chat: ctx.threadId,
          title: `${ctx.persona.name}: your morning summary`,
          body: "Also sent to your Telegram.",
        },
      },
    ];
  }
  return summary;
}

export function acmeDecision(ctx: ScriptContext): Script {
  if (ctx.ops.connectorState("gmail") === "expired") {
    return [{ say: "I can't send it: Gmail ended its sign-in." }, ...connectorsCard(ctx)];
  }
  if (ctx.ops.connectorState("gmail") === "off") {
    return [
      { say: "I'd send it from your Gmail, but it isn't connected yet." },
      ...connectorsCard(ctx),
    ];
  }
  return [
    { work: "Taking the draft “Invoice #1042 — a gentle reminder” from Gmail…" },
    {
      act: {
        command: "Send an email to billing@acme.example — “Invoice #1042 — a gentle reminder”",
        why: "It goes out from your Gmail, to a client.",
      },
      allowed: [{ say: "Sent to billing@acme.example. I'll tell you when they answer." }],
      declined: [{ say: "OK, not sending. The draft stays in Gmail → Drafts." }],
    },
  ];
}

export function otherComputerTask(ctx: ScriptContext): Script {
  if (!macOnline(ctx.world)) {
    return [
      {
        ask: "Your MacBook is asleep, and the deck lives there. Run it on uno-work from GitHub instead, or wait for the Mac?",
        question: {
          id: "mac-asleep",
          header: "MacBook",
          question: "Where should I do it?",
          options: [
            { label: "Run on uno-work", description: "Takes the deck from GitHub" },
            { label: "Wait for the MacBook", description: "Starts when it wakes" },
          ],
        },
        then: (answer) =>
          /uno-work/i.test(answer)
            ? [
                {
                  elsewhere: {
                    machine: "work",
                    projectId: "p-work-landing",
                    title: "Export the pitch deck to PDF",
                    prompt: "Clone pitch-deck from GitHub and export it to PDF.",
                    steps: ["Cloning github.com/misha-demo/pitch-deck…", "Exporting 14 slides…"],
                    result: "pitch-deck.pdf (2.1 MB) is in Files → Downloads.",
                  },
                },
              ]
            : [
                {
                  say: "OK — it waits. When the MacBook wakes, I start it and tell you here and in Telegram.",
                },
                {
                  inbox: {
                    id: `i-wait-mac-${Date.now()}`,
                    kind: "agent.input",
                    chat: ctx.threadId,
                    title: "Waiting for your MacBook: Export the pitch deck",
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
        projectId: "p-mac-deck",
        title: "Export the pitch deck to PDF",
        prompt: "Export the pitch deck to PDF and put it in Downloads.",
        steps: [
          "Opening pitch-deck (14 slides)…",
          "Exporting to PDF… 60%",
          "Checking fonts and images…",
        ],
        result: "pitch-deck.pdf (2.1 MB) is in ~/Downloads on the MacBook.",
      },
    },
  ];
}

export function failingScript(): Script {
  return [
    { work: "Asking Uno AI…" },
    { fail: "Uno AI didn't answer in 60 s. Nothing was changed — send it again in a minute." },
  ];
}

triggers.push(
  {
    id: "morning",
    match: /morning|summary|what's up|today|сводк|утр/i,
    script: (ctx) => morningSummary(ctx),
  },
  { id: "acme", match: /acme|invoice|remind|send|отправ|напомн/i, script: acmeDecision },
  {
    id: "elsewhere",
    match: /\bmac\b|macbook|deck|other computer|другом|маке/i,
    script: otherComputerTask,
  },
  {
    id: "connect-apps",
    match: /connect.*(app|gmail|mail|drive|notion)|apps|коннектор|подключ.*(почт|прил)/i,
    script: (ctx) => connectorsCard(ctx),
  },
  { id: "telegram", match: /telegram|телеграм/i, script: (ctx) => telegramCard(ctx) },
  { id: "error", match: /break|error|fail|ошибк|слома/i, script: failingScript },
  { id: "hello", match: /^(hi|hello|hey|привет)\b/i, script: (ctx) => greetingScript(ctx) },
);

scenes.push(
  {
    id: "morning",
    title: "Утренняя сводка (08:00)",
    hint: "Ассистент сам пишет первым: почта, календарь, компьютеры. Если Telegram связан — карточка в Inbox «и в Telegram».",
    run: ({ play, target, ops, world }) =>
      void play(morningSummary({ ...target, ops, world }, true)),
  },
  {
    id: "telegram-message",
    title: "Сообщение из Telegram",
    hint: "Ты пишешь боту «send the Acme reminder» — в режиме «Спрашивает» придёт карточка Allow в чат, Inbox и Telegram.",
    run: ({ ops, target, play, world }) => {
      ops.userSays(target.machine, target.threadId, "📱 Telegram: send the Acme reminder");
      void play(acmeDecision({ ...target, ops, world }));
    },
  },
  {
    id: "reminder-closed",
    title: "Напоминание 16:00, Work закрыт",
    hint: "Срабатывает напоминание, когда вкладки нет: просьба Allow ждёт в Inbox (и в Telegram), а не отказывает.",
    run: ({ ops, target, play, world }) => {
      ops.userSays(target.machine, target.threadId, "⏰ 16:00 — reminder: Acme invoice");
      void play(acmeDecision({ ...target, ops, world }));
    },
  },
  {
    id: "elsewhere",
    title: "Задача на другом компьютере",
    hint: "Ассистент запускает чат на MacBook, там видно шаги, итог возвращается в его чат и в Inbox. Если Mac спит — спрашивает, где делать.",
    run: ({ ops, target, play, world }) => {
      ops.userSays(target.machine, target.threadId, "Export the deck on my Mac");
      void play(otherComputerTask({ ...target, ops, world }));
    },
  },
  {
    id: "error",
    title: "Ошибка",
    hint: "Ход ассистента падает с понятной ошибкой: что случилось и что ничего не сломано.",
    run: ({ ops, target, play }) => {
      ops.userSays(target.machine, target.threadId, "Check the Stripe payouts");
      void play(failingScript());
    },
  },
);
