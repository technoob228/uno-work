/**
 * p7 (Misha 16.10): the demo "brain" of an assistant that sets itself up in a
 * chat — like Grok's companions: it introduces itself, asks one question at
 * a time (a quiz card with 2–4 answers, your own words in the composer, a
 * short field, a Connect button), reacts in a line, saves each answer to its
 * profile at once ("✓ Saved: …") and moves on. Any question can be skipped.
 *
 * The order: who it is and what it does → where you talk → what it may do
 * (and its own computer when limited) → projects → apps with levels →
 * browser → keys → how it reports → the first task. In the product the
 * assistant's own AI runs this as its setup skill; here it is a script.
 */
import type { AppLevel, AssistantProfile } from "../components/assistants/assistantTeam.logic";
import {
  APP_NAME,
  BROWSER_USE,
  accessOf,
  CHARACTER_CHIPS,
  PRESETS,
  PRESET_NAME,
  ROLE_CHIPS,
  ownComputerName,
  presetAccess,
  toggleRole,
} from "../components/assistants/assistantTeam.logic";
import { useAssistantTeamStore } from "../components/assistants/assistantTeamStore";
import { APP_TECH } from "../components/connectors/connectorsCatalog.logic";

export interface SetupQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
  readonly multiSelect?: boolean;
  readonly detail?: string;
  readonly input?: { readonly placeholder: string; readonly kind?: "text" | "email" | "time" };
  readonly connect?: {
    readonly provider: string;
    readonly name: string;
    readonly doneLabel: string;
  };
  readonly skippable: true;
}

/** What the chat knows about the world around it (from the demo's fixtures). */
export interface SetupWorld {
  /** Project names on its computer. */
  readonly projects: ReadonlyArray<string>;
  /** App id → connected now. */
  readonly connected: (provider: string) => boolean;
  /** Keys and tokens in the vault. */
  readonly keys: ReadonlyArray<{ readonly id: string; readonly label: string }>;
}

interface Step {
  readonly id: string;
  /** null: not asked for this profile (e.g. its own computer when it has Full). */
  readonly ask: (
    profile: AssistantProfile,
    world: SetupWorld,
    state: ChatState,
  ) => SetupQuestion | null;
  /** Saves the answer; returns the "✓ Saved" line and a short reaction. */
  readonly apply: (
    answer: string,
    profile: AssistantProfile,
    world: SetupWorld,
    state: ChatState,
  ) => {
    readonly saved: string;
    readonly reply: string;
    readonly patch: Partial<AssistantProfile>;
  };
}

interface ChatState {
  /** The not-yet-connected app it offers to connect. */
  offerApp: string | null;
  wantsEmail: boolean;
}

const opt = (label: string, description = label) => ({ label, description });
const q = (question: Omit<SetupQuestion, "skippable">): SetupQuestion => ({
  ...question,
  skippable: true,
});

const ROLE_REACTION: Readonly<Record<string, string>> = {
  "Personal assistant": "I'll keep your day tidy.",
  Developer: "Green CI is my happy place.",
  Marketing: "Competitors are my favorite reading.",
  Ops: "I like quiet servers.",
  Security: "I'll keep an eye on the doors.",
};

const TONE_REACTION: Readonly<Record<string, string>> = {
  "Calm and brief": "Noted. Short it is.",
  Friendly: "Yay — friendly it is 🙂",
  "Straight to the point": "Done.",
  Playful: "Ooh, fun. Deal 😄",
};

const limited = (profile: AssistantProfile) => profile.preset !== "full";

const STEPS: ReadonlyArray<Step> = [
  {
    id: "role",
    ask: () =>
      q({
        id: "role",
        header: "My job",
        question: "First — what should I take off your plate?",
        options: ROLE_CHIPS.filter((role) => role !== "Security").map((role) => opt(role)),
      }),
    apply: (answer) => {
      const known = (ROLE_CHIPS as ReadonlyArray<string>).includes(answer);
      const next = known
        ? toggleRole({ roles: [], skills: [] }, answer)
        : { roles: [answer], skills: [] };
      return {
        saved: `role — ${answer}${next.skills.length > 0 ? ` (good at ${next.skills.join(", ")})` : ""}`,
        reply: ROLE_REACTION[answer] ?? "Something new — I'll learn it with you.",
        patch: { roles: next.roles, skills: next.skills },
      };
    },
  },
  {
    id: "tone",
    ask: () =>
      q({
        id: "tone",
        header: "How I talk",
        question: "How should I talk to you?",
        options: CHARACTER_CHIPS.map((tone) => opt(tone)),
      }),
    apply: (answer) => ({
      saved: `tone — ${answer}`,
      reply: TONE_REACTION[answer] ?? "Got it.",
      patch: { character: answer },
    }),
  },
  {
    id: "channel",
    ask: () =>
      q({
        id: "channel",
        header: "Where we talk",
        question: "Where do you want to reach me?",
        options: [
          opt("Telegram", "Uno's assistant bot — one tap to link"),
          opt("Slack", "a channel you pick"),
          opt("Only here", "in Uno Work"),
        ],
      }),
    apply: (answer) => {
      if (/telegram/i.test(answer))
        return {
          saved: "talk in Telegram (Uno's bot)",
          reply:
            "Tap once to link us: [Open in Telegram](https://t.me/uno_team_bot?start=k3x9q) — I answer only you, nobody else.",
          patch: { channel: "uno-bot" },
        };
      if (/slack/i.test(answer))
        return {
          saved: "talk in Slack",
          reply: "I'll ask which channel once Slack is connected — it's on my page.",
          patch: { channel: "slack" },
        };
      return { saved: "talk here in Uno Work", reply: "Cozy. Here it is.", patch: {} };
    },
  },
  {
    id: "rights",
    ask: () =>
      q({
        id: "rights",
        header: "What I may do",
        question: "How much should I do on my own?",
        detail: "This sets my apps, browser and keys too — you can fine-tune each on my page.",
        options: PRESETS.map((preset) => opt(preset.name, `${preset.line} ${preset.examples}`)),
      }),
    apply: (answer, profile) => {
      const preset = PRESETS.find((item) => item.name === answer)?.id ?? "helper";
      const reply =
        preset === "full"
          ? "I'll still ask before money and deleting."
          : preset === "helper"
            ? "I'll ask before deploys, payments, deleting and emails out."
            : "Hands off — I'll only read and report.";
      return {
        saved: `can do — ${PRESET_NAME[preset]}`,
        reply,
        patch: {
          preset,
          access: presetAccess(preset, accessOf(profile), false),
        },
      };
    },
  },
  {
    id: "own-computer",
    ask: (profile) =>
      limited(profile) && !profile.ownComputer
        ? q({
            id: "own-computer",
            header: "My own computer",
            question: `Limits hold only on a computer of my own — next to you I could still read any file. Make ${ownComputerName(profile.name)}?`,
            detail:
              "Lite · from your plan's quota, at most $5/mo · starts with my first task in ~3 s, wakes in under half a second · sleeps when idle and costs nothing then.",
            options: [
              opt(`Make ${ownComputerName(profile.name)}`, "your projects get copied there"),
              opt("Not now", "I stay next to you with Full"),
            ],
          })
        : null,
    apply: (answer, profile) =>
      /^make/i.test(answer)
        ? {
            saved: `lives on ${ownComputerName(profile.name)} (Lite)`,
            reply: "Done — it starts with my first task, in a few seconds: the same teammate image, with my settings and memory attached. Nothing to wait for now.",
            patch: { ownComputer: ownComputerName(profile.name), computers: [] },
          }
        : {
            saved: "stays next to you with Full",
            reply: "OK — then limits wouldn't hold anyway, so Full it is.",
            patch: { preset: "full", access: presetAccess("full", accessOf(profile), false) },
          },
  },
  {
    id: "projects",
    ask: (profile, world) =>
      q({
        id: "projects",
        header: "My projects",
        question: "Which projects are mine?",
        detail: profile.ownComputer
          ? `I'll copy them to ${profile.ownComputer}; nothing else of yours goes there.`
          : "Where I work. On your computer I could still open other files — this is a focus, not a wall.",
        multiSelect: true,
        options: [
          opt("All projects", "new ones too"),
          ...world.projects.slice(0, 3).map((name) => opt(name)),
        ],
      }),
    apply: (answer) => {
      const picked = answer
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      const all = picked.includes("All projects") || picked.length === 0;
      return {
        saved: all ? "projects — all of them" : `projects — ${picked.join(", ")}`,
        reply: all ? "The whole garden. Nice." : "Got it — I'll stay in those.",
        patch: { projects: all ? "all" : picked },
      };
    },
  },
  {
    id: "github",
    ask: (profile, world) =>
      world.connected("github")
        ? q({
            id: "github",
            header: "Apps",
            question: "GitHub is connected. What can I do there?",
            detail: APP_TECH.github!.plain,
            options:
              profile.preset === "observer"
                ? [opt("Reads only"), opt("Stay out")]
                : [opt("Reads & changes", "push, open PRs"), opt("Reads only"), opt("Stay out")],
          })
        : null,
    apply: (answer, profile) => {
      const level: AppLevel = /changes/i.test(answer)
        ? "write"
        : /read/i.test(answer)
          ? "read"
          : "none";
      const current = accessOf(profile).connectors;
      const base = current && typeof current === "object" ? current : {};
      return {
        saved: `GitHub — ${level === "write" ? "reads and changes" : level === "read" ? "reads only" : "no access"}`,
        reply:
          level === "none" ? "Staying out." : "I'll check it's the right repo before anything.",
        patch: { access: { ...accessOf(profile), connectors: { ...base, github: level } } },
      };
    },
  },
  {
    id: "connect",
    ask: (_profile, world, state) => {
      const app = ["notion", "gmail", "google-drive"].find((id) => !world.connected(id)) ?? null;
      state.offerApp = app;
      if (!app) return null;
      const name = APP_NAME[app] ?? app;
      return q({
        id: "connect",
        header: "Apps",
        question: `Want me in ${name} too?`,
        detail: APP_TECH[app]?.plain ?? "",
        connect: { provider: app, name, doneLabel: "Connected" },
        options: [opt("Connected"), opt("Not now")],
      });
    },
    apply: (answer, profile, _world, state) => {
      const app = state.offerApp ?? "notion";
      const name = APP_NAME[app] ?? app;
      if (answer !== "Connected")
        return {
          saved: `${name} — not now`,
          reply: "Fine — it's one click in Settings → Connectors.",
          patch: {},
        };
      const level: AppLevel = profile.preset === "observer" ? "read" : "write";
      const current = accessOf(profile).connectors;
      const base = current && typeof current === "object" ? current : {};
      return {
        saved: `${name} connected — ${level === "read" ? "reads only" : "reads and changes"}`,
        reply: "Your token stays in your Uno account; I only get the tools.",
        patch: { access: { ...accessOf(profile), connectors: { ...base, [app]: level } } },
      };
    },
  },
  {
    id: "browser",
    ask: (profile) =>
      q({
        id: "browser",
        header: "Browser",
        question: "Can I use the browser?",
        detail: profile.ownComputer
          ? `My own browser on ${profile.ownComputer} — none of your sign-ins.`
          : "Next to you I'd see the sites you're already signed in to.",
        options: BROWSER_USE.filter(
          (option) => profile.preset !== "observer" || option.id === "read" || option.id === "off",
        ).map((option) => opt(option.name, option.line)),
      }),
    apply: (answer, profile) => {
      const use = BROWSER_USE.find((option) => option.name === answer)?.id ?? "safe";
      return {
        saved: `browser — ${answer}`,
        reply:
          use === "off"
            ? "No browser, OK."
            : "Saved logins I use only where you tick them — on my page.",
        patch: { access: { ...accessOf(profile), browser: use } },
      };
    },
  },
  {
    id: "keys",
    ask: (profile, world) =>
      profile.preset === "observer" || world.keys.length === 0
        ? null
        : q({
            id: "keys",
            header: "Keys & tokens",
            question: "Any keys I may use?",
            detail:
              "I don't get the value as text, but a command I run can use it — tick only keys you're fine letting me act with.",
            multiSelect: true,
            options: [...world.keys.slice(0, 3).map((key) => opt(key.label)), opt("None")],
          }),
    apply: (answer, profile, world) => {
      const picked = world.keys.filter((key) => answer.includes(key.label));
      return {
        saved:
          picked.length > 0
            ? `keys — ${picked.map((key) => key.label).join(", ")}`
            : "keys — none, I'll ask",
        reply:
          picked.length > 0
            ? "I'll use them only in commands, never in chat."
            : "I'll ask when I need one.",
        patch: {
          access: {
            ...accessOf(profile),
            secrets: picked.length > 0 ? picked.map((key) => key.id) : [],
          },
        },
      };
    },
  },
  {
    id: "report",
    ask: () =>
      q({
        id: "report",
        header: "Reporting",
        question: "How should I report?",
        options: [
          opt("Every evening", "a short note where we talk"),
          opt("Weekly email", "a summary on Mondays"),
          opt("Only when I need you", "quiet otherwise"),
        ],
      }),
    apply: (answer, profile, _world, state) => {
      state.wantsEmail = /email/i.test(answer);
      const schedule = /evening/i.test(answer)
        ? [{ name: "Evening report", when: "every day 19:00" }]
        : state.wantsEmail
          ? [{ name: "Weekly summary by email", when: "Mondays 09:00" }]
          : [];
      return {
        saved: `report — ${answer.toLowerCase()}`,
        reply:
          "Everything I do is also in my Activity; money, deleting and deploys go to Needs you.",
        patch: { schedule: [...(profile.schedule ?? []), ...schedule] },
      };
    },
  },
  {
    id: "email",
    ask: (_profile, _world, state) =>
      state.wantsEmail
        ? q({
            id: "email",
            header: "Email",
            question: "Which email should the summary go to?",
            input: { placeholder: "you@company.com", kind: "email" },
            options: [],
          })
        : null,
    apply: (answer, profile) => ({
      saved: `weekly summary → ${answer}`,
      reply: "Mondays, 9:00.",
      patch: {
        schedule: (profile.schedule ?? []).map((task) =>
          task.name === "Weekly summary by email"
            ? { name: `Weekly summary → ${answer}`, when: task.when }
            : task,
        ),
      },
    }),
  },
  {
    id: "first-task",
    ask: (profile) =>
      q({
        id: "first-task",
        header: "First task",
        question: "Last one — what's my first task?",
        input: {
          placeholder: profile.roles.includes("Marketing")
            ? "Every Monday: what competitors shipped last week"
            : profile.roles.includes("Developer")
              ? "Keep CI green on fishcode and tell me what broke"
              : "Every morning at 8: what's running, what needs me",
        },
        options: [],
      }),
    apply: (answer, profile) => ({
      saved: `first task — “${answer}”`,
      reply: "On it.",
      patch: {
        activity: [
          ...(profile.activity ?? []),
          { at: new Date().toISOString(), kind: "note", text: `First task: ${answer}` },
        ],
      },
    }),
  },
];

interface SetupChat {
  readonly environmentId: string;
  readonly key: string;
  step: number;
  readonly state: ChatState;
}

const chats = new Map<string, SetupChat>();

export function isSetupChatThread(threadId: string): boolean {
  return chats.has(threadId);
}

const profileOf = (key: string) => useAssistantTeamStore.getState().profiles[key] ?? null;

/** The next question from `from` on, skipping the ones that don't apply. */
function nextQuestion(chat: SetupChat, world: SetupWorld): SetupQuestion | null {
  while (chat.step < STEPS.length) {
    const profile = profileOf(chat.key);
    if (!profile) return null;
    const question = STEPS[chat.step]!.ask(profile, world, chat.state);
    if (question) return question;
    chat.step += 1;
  }
  return null;
}

/** The chat begins: it introduces itself and asks the first question. */
export function startSetupChat(
  threadId: string,
  input: { readonly environmentId: string; readonly key: string },
  world: SetupWorld,
): { readonly text: string; readonly question: SetupQuestion | null } {
  const chat: SetupChat = {
    environmentId: input.environmentId,
    key: input.key,
    step: 0,
    state: { offerApp: null, wantsEmail: false },
  };
  chats.set(threadId, chat);
  const profile = profileOf(input.key);
  const name = profile?.name ?? "your assistant";
  const engine =
    profile?.brain === "claude"
      ? "your Claude plan"
      : profile?.brain === "chatgpt"
        ? "your ChatGPT plan"
        : profile?.brain === "key"
          ? "your own key"
          : "Uno AI";
  return {
    text: `Hi, I'm ${name} ${profile?.emoji ?? "👋"} — your new teammate, running on ${engine}.\n\nLet's set me up together: one quick question at a time, skip anything, change it all later on my page.`,
    question: nextQuestion(chat, world),
  };
}

/** An answer came: save it, react, ask the next one (or wrap up). */
export function answerSetupChatTurn(
  threadId: string,
  answer: string,
  world: SetupWorld,
): { readonly text: string; readonly question: SetupQuestion | null } | null {
  const chat = chats.get(threadId);
  if (!chat) return null;
  const profile = profileOf(chat.key);
  const step = STEPS[chat.step];
  if (!profile || !step) return null;
  let line: string;
  if (/^skip$/i.test(answer.trim())) {
    line = "Skipped — it's on my page whenever you want it.";
  } else {
    const result = step.apply(answer.trim(), profile, world, chat.state);
    useAssistantTeamStore.getState().patch(chat.key, result.patch);
    line = `✓ **Saved:** ${result.saved}\n\n${result.reply}`;
  }
  chat.step += 1;
  const question = nextQuestion(chat, world);
  if (question) return { text: line, question };
  useAssistantTeamStore.getState().patch(chat.key, { setUpAt: new Date().toISOString() });
  chats.delete(threadId);
  const done = profileOf(chat.key);
  return {
    text: `${line}\n\nAll set ✓ Everything you told me is on my page — Assistants → ${done?.name ?? "me"} — and you can change any of it there.`,
    question: null,
  };
}
