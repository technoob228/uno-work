/**
 * The w0138 mock's assistants (p6–p7): Uno, Builder and Scout — their
 * folders and chats on the cloud computers, the profiles the setup would
 * have saved, the Inbox card "Uno set up Scout", and the daemon answers the
 * team needs (assistants list, its AI and sign-ins, memory files, the bot
 * link). Demo only: imported by demoBoot.
 *
 * How an assistant is tied to its chats: an assistant is a folder
 * (`assistant-*` project) on one computer; its chats are the threads in that
 * folder. Uno is `assistant-home` on uno-work (the chats already in
 * heavyFixtures + more here), Scout is `assistant-scout` on uno-work,
 * Builder is `assistant-builder` on uno-product.
 */
import { ASSISTANT_PROJECT_ID, type AssistantLlmStatus } from "@t3tools/contracts";
import { HttpResponse, http } from "msw";

import { type DemoSwitches, useDemoStore } from "./demoFlag";
import {
  type SetupQuestion,
  type SetupWorld,
  answerSetupChatTurn,
  isSetupChatThread,
  startSetupChat,
} from "./setupChatBrain";

import type { AssistantProfile } from "../components/assistants/assistantTeam.logic";
import {
  type RightsCutDetail,
  teamEvents,
  useAssistantTeamStore,
} from "../components/assistants/assistantTeamStore";
import {
  CHATS,
  INBOX,
  MACHINES,
  PROJECTS,
  type ChatSpec,
  type DemoMachine,
  type MachineKey,
} from "./heavyFixtures";

const BUILDER = "assistant-builder";
const SCOUT = "assistant-scout";

// ── Folders ───────────────────────────────────────────────────────────────

PROJECTS.work.push({ id: SCOUT, title: "Scout", root: "/home/uno/UnoWork/Assistants/scout" });
PROJECTS.product.push({
  id: BUILDER,
  title: "Builder",
  root: "/home/uno/UnoWork/Assistants/builder",
});

// ── Chats ─────────────────────────────────────────────────────────────────

const ASSISTANT_CHATS: ChatSpec[] = [
  // Uno: more conversations besides the main one (p6: "3 + Show N more").
  {
    id: "uno-hackathon",
    machine: "work",
    project: ASSISTANT_PROJECT_ID,
    title: "Saturday hackathon: accounts and KV",
    minutesAgo: 34,
    state: "read",
    role: "solo",
    messages: [
      ["user", "What's left for the hackathon on Saturday?"],
      [
        "assistant",
        "Accounts list from you by Friday, KV is in prod behind the flag. I'll check the 20 test accounts tomorrow at 10.",
      ],
    ],
  },
  {
    id: "uno-week",
    machine: "work",
    project: ASSISTANT_PROJECT_ID,
    title: "What's due this week",
    minutesAgo: 60 * 5,
    state: "read",
    role: "solo",
    messages: [
      ["user", "📱 Telegram: what's due this week?"],
      [
        "assistant",
        "Hostkey invoice (Oct 12), the 0.0.138 release, the hackathon on Saturday and the course group call on Sunday.",
      ],
    ],
  },
  {
    id: "uno-scout",
    machine: "work",
    project: ASSISTANT_PROJECT_ID,
    title: "Set up a marketer to watch competitors",
    minutesAgo: 60 * 26,
    state: "read",
    role: "solo",
    messages: [
      ["user", "I want someone watching what competitors ship. Read only."],
      [
        "assistant",
        "Set up Scout: landing and uno-project, Observer, on your ChatGPT plan. It sends a summary every Monday.",
      ],
    ],
  },
  {
    id: "uno-hostkey-reply",
    machine: "work",
    project: ASSISTANT_PROJECT_ID,
    title: "Reply to Hostkey about the disk upgrade",
    minutesAgo: 60 * 50,
    state: "read",
    role: "solo",
    messages: [
      ["user", "Answer Hostkey: we'll take the custom node instead."],
      ["assistant", "Sent from hello@getuno.xyz. They answer within a day."],
    ],
  },

  // Builder: developer on uno-product, Claude plan, Helper.
  {
    id: "b-ci",
    machine: "product",
    project: BUILDER,
    title: "Keep CI green on fishcode",
    minutesAgo: 1,
    runningFor: 6,
    state: "running",
    role: "solo",
    now: "Re-running the flaky exit IP test",
    messages: [
      ["user", "Keep CI green on fishcode and uno-work-app. Tell me only what you can't fix."],
      ["assistant", "Watching both. One flaky test in internal/exitip — re-running it with -race."],
    ],
  },
  {
    id: "b-review",
    machine: "product",
    project: BUILDER,
    title: "Review PR #412 before the merge",
    minutesAgo: 60 * 3,
    state: "read",
    role: "solo",
    messages: [
      ["user", "Look at PR #412 before I merge it."],
      [
        "assistant",
        "Looks good: 3 files, tests green. One nit about the empty state — left a comment.",
      ],
    ],
  },

  // Scout: marketing on uno-work, ChatGPT plan, Observer, set up by Uno.
  {
    id: "sc-competitors",
    machine: "work",
    project: SCOUT,
    title: "What competitors shipped this week",
    minutesAgo: 60 * 20,
    state: "read",
    role: "solo",
    messages: [
      ["user", "From Uno: every Monday — what competitors shipped, three lines each."],
      [
        "assistant",
        "Replit: agent on mobile. Lovable: team workspaces. Cursor: background agents for everyone. Full notes in NOTES.md.",
      ],
    ],
  },
  {
    id: "sc-hero",
    machine: "work",
    project: SCOUT,
    title: "Ideas for the landing hero",
    minutesAgo: 60 * 30,
    state: "read",
    role: "solo",
    messages: [
      ["user", "Three hero lines for the new landing, simple words."],
      [
        "assistant",
        "1. One place to build and deploy with AI. 2. Your computer in the cloud, with a teammate. 3. Ask once, it gets done.",
      ],
    ],
  },
];

CHATS.push(...ASSISTANT_CHATS);

// ── The Inbox card: Uno set up Scout (no confirmation, a notice) ──────────

INBOX.push({
  id: "i-scout-set-up",
  machine: "work",
  kind: "agent.done",
  minutesAgo: 60 * 26 - 2,
  title: "Uno set up assistant Scout",
  body: "Projects landing, uno-project · Observer · ChatGPT plan. Within Uno's access.",
  source: { kind: "system", id: `assistant-set-up:${SCOUT}`, name: "Uno", icon: "🔭" },
  open: { kind: "url", url: `uno://assistant/${MACHINES.work.environmentId}/${SCOUT}` },
});

// ── Profiles (what the setup saved) ───────────────────────────────────────

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const TEAM: ReadonlyArray<AssistantProfile> = [
  {
    environmentId: MACHINES.work.environmentId,
    projectId: ASSISTANT_PROJECT_ID,
    name: "Uno",
    emoji: null,
    tone: "violet",
    roles: ["Personal assistant"],
    character: "Calm and brief",
    skills: ["Morning plan", "Reminders", "Pay invoices (asks first)"],
    preset: "full",
    brain: "uno",
    channel: "uno-bot",
    channelHandle: "@misha · Uno's bot",
    projects: "all",
    computers: [
      MACHINES.mac.environmentId,
      MACHINES.work.environmentId,
      MACHINES.product.environmentId,
    ],
    createdBy: null,
    createdAt: ago(60 * 24 * 14),
    setUpAt: ago(60 * 24 * 14),
    revokedAt: null,
    schedule: [
      { name: "Morning plan", when: "every day 08:00" },
      { name: "Hostkey invoice reminder", when: "Oct 11, 10:00" },
    ],
    activity: [
      {
        at: ago(60 * 26),
        kind: "teammate",
        text: "Set up Scout — Observer, landing and uno-project",
      },
      {
        at: ago(60 * 24 * 3),
        kind: "money",
        text: "Paid the Hostkey invoice — $347",
        by: "you",
      },
      {
        at: ago(60 * 24 * 3 + 5),
        kind: "login",
        text: "Signed in to my.hostkey.com with your saved login",
        by: "auto",
      },
      { at: ago(60 * 5), kind: "deploy", text: "Published misha-week-1015.uno4.me", by: "auto" },
      {
        at: ago(60 * 4),
        kind: "connector",
        text: "GitHub: merged PR #412 in uno-work-app",
        by: "you",
      },
      { at: ago(60 * 2), kind: "note", text: "Saved the morning plan to NOTES.md" },
    ],
  },
  {
    environmentId: MACHINES.product.environmentId,
    projectId: BUILDER,
    name: "Builder",
    emoji: "🛠️",
    tone: "amber",
    roles: ["Developer"],
    character: "Straight to the point",
    skills: ["Code review", "Run tests", "Fix CI"],
    preset: "helper",
    brain: "claude",
    channel: "slack",
    channelHandle: "#dev",
    projects: ["fishcode", "uno-work-app"],
    computers: [MACHINES.product.environmentId, MACHINES.mac.environmentId],
    createdBy: null,
    createdAt: ago(60 * 24 * 6),
    setUpAt: ago(60 * 24 * 6),
    revokedAt: null,
    schedule: [{ name: "Nightly test run", when: "every day 03:00" }],
    ownComputer: "builder-box",
    activity: [
      {
        at: ago(60 * 20),
        kind: "deploy",
        text: "Deployed fishcode feat/kv-service to stage",
        by: "you",
      },
      {
        at: ago(60 * 20 + 2),
        kind: "key",
        text: "Used Cloudflare API token in `wrangler deploy`",
        by: "auto",
      },
      {
        at: ago(60 * 12),
        kind: "connector",
        text: "GitHub: opened PR #418 in fishcode",
        by: "auto",
      },
      {
        at: ago(60 * 10),
        kind: "denied",
        text: "Wanted to read Gmail — not in its apps; asked you instead",
      },
      {
        at: ago(60 * 9),
        kind: "delete",
        text: "Deleted 3 merged branches in uno-work-app",
        by: "you",
      },
    ],
    access: {
      // Custom (based on Helper): GitHub reads and changes, Drive reads only.
      connectors: { github: "write", "google-drive": "read" },
      browser: "safe",
      logins: ["cred-github"],
      secrets: ["cred-cloudflare-token"],
      projectSkills: true,
      personalSkills: ["code-security-review", "up-to-date-docs"],
    },
  },
  {
    environmentId: MACHINES.work.environmentId,
    projectId: SCOUT,
    name: "Scout",
    emoji: "🔭",
    tone: "teal",
    roles: ["Marketing"],
    character: "Friendly",
    skills: ["Read competitors", "Draft posts", "Weekly numbers"],
    preset: "observer",
    brain: "chatgpt",
    channel: "uno-bot",
    channelHandle: "/assistant scout",
    projects: ["landing", "uno-project"],
    computers: [MACHINES.work.environmentId],
    createdBy: `${MACHINES.work.environmentId}:${ASSISTANT_PROJECT_ID}`,
    createdAt: ago(60 * 26),
    setUpAt: ago(60 * 26),
    revokedAt: null,
    schedule: [{ name: "Competitors digest", when: "Mondays 09:00" }],
    ownComputer: "scout-box",
    activity: [
      {
        at: ago(60 * 31),
        kind: "connector",
        text: "Google Drive: read “Competitors — week 40”",
        by: "auto",
      },
      {
        at: ago(60 * 30),
        kind: "denied",
        text: "Wanted to save “Competitors — week 41” to Drive — Observer only reads",
      },
      { at: ago(60 * 30 - 1), kind: "note", text: "Sent you “Competitors — week 41” in Telegram" },
    ],
    access: {
      // Exactly Observer: apps and pages read only, no logins or keys.
      connectors: "read",
      browser: "read",
      logins: "none",
      secrets: "none",
      projectSkills: true,
      personalSkills: ["sales-copy"],
    },
  },
];

type DemoInboxSpec = (typeof INBOX)[number];

/**
 * The team's profiles, unless the person changed them in this browser
 * already — and the notice the daemon will send when cutting rights cuts
 * what an assistant set up (decision 16.10): a card in Needs you.
 */
export function seedAssistantTeam(hooks: { readonly addInbox: (spec: DemoInboxSpec) => void }) {
  const store = useAssistantTeamStore.getState();
  store.seed(TEAM);
  // Profiles saved by an earlier mock (before p9/16.10) get what's new.
  for (const profile of TEAM) {
    const key = `${profile.environmentId}:${profile.projectId}`;
    const saved = useAssistantTeamStore.getState().profiles[key];
    if (!saved) continue;
    const missing: Partial<AssistantProfile> = {
      // No access yet, or the shape before levels (critics track 3): the team's.
      ...(profile.access &&
      (!saved.access ||
        Array.isArray(saved.access.connectors) ||
        (saved.access.connectors as unknown) === "all")
        ? { access: profile.access }
        : {}),
      ...(profile.ownComputer && saved.ownComputer === undefined
        ? { ownComputer: profile.ownComputer }
        : {}),
      // Activity from before "who allowed it" (critics track 3): the team's.
      ...(profile.activity &&
      (!saved.activity || !saved.activity.some((entry) => entry.kind === "connector"))
        ? { activity: profile.activity }
        : {}),
    };
    if (Object.keys(missing).length > 0) store.patch(key, missing);
  }
  teamEvents.addEventListener("rights-cut", (event) => {
    const { by, losses } = (event as CustomEvent<RightsCutDetail>).detail;
    const machine =
      (Object.keys(MACHINES) as MachineKey[]).find(
        (key) => MACHINES[key].environmentId === by.environmentId,
      ) ?? "work";
    const first = losses[0]!;
    const firstProfile = Object.values(useAssistantTeamStore.getState().profiles).find(
      (profile) => profile.name === first.name,
    );
    hooks.addInbox({
      id: `i-rights-cut-${Date.now()}`,
      machine,
      kind: "agent.done",
      minutesAgo: 0,
      title:
        losses.length === 1
          ? `${first.name} lost some access`
          : `${losses.length} assistants lost some access`,
      body: `${by.name}'s rights changed, so what it set up was cut to match. ${losses
        .map((loss) => `${loss.name}: ${loss.lost.join(", ")}`)
        .join(" · ")}.`,
      source: {
        kind: "system",
        id: `assistant-rights:${first.key}`,
        name: by.name,
        icon: firstProfile?.emoji ?? "🔒",
      },
      open: firstProfile
        ? {
            kind: "url",
            url: `uno://assistant/${firstProfile.environmentId}/${firstProfile.projectId}`,
          }
        : null,
    });
  });
}

// ── p9: Connectors, the vault, the projects' skills ───────────────────────

type Provider = "github" | "google-drive" | "notion" | "gmail";
const CONNECTOR_META: ReadonlyArray<{ provider: Provider; name: string; description: string }> = [
  {
    provider: "google-drive",
    name: "Google Drive",
    description: "Only files Uno created or you picked for it — not your whole Drive.",
  },
  {
    provider: "github",
    name: "GitHub",
    description: "Reads and pushes to all your repos, private ones too; issues and PRs.",
  },
  {
    provider: "notion",
    name: "Notion",
    description: "Only the pages you shared with Uno; reads and edits them.",
  },
  {
    provider: "gmail",
    name: "Gmail & Calendar",
    description: "Reads, drafts and sends mail, can move it to Trash; reads your calendar.",
  },
];
const ACCOUNT: Record<Provider, string> = {
  github: "technoob228",
  "google-drive": "misha@getuno.xyz",
  notion: "Uno workspace",
  gmail: "misha@getuno.xyz",
};
/** Connected now, or since when a sign-in was started (it lands ~2 s later). */
const connectors = new Map<Provider, { connectedAt: string | null; startedAt: number | null }>();
/** p9 switch: GitHub and Drive connected, or nothing yet (to see the empty state). */
function resetConnectors(state: DemoSwitches["connectors"]) {
  const on = state === "connected";
  connectors.set("github", { connectedAt: on ? ago(60 * 24 * 20) : null, startedAt: null });
  connectors.set("google-drive", { connectedAt: on ? ago(60 * 24 * 9) : null, startedAt: null });
  connectors.set("notion", { connectedAt: null, startedAt: null });
  connectors.set("gmail", { connectedAt: null, startedAt: null });
}
resetConnectors(useDemoStore.getState().switches.connectors);
useDemoStore.subscribe((state, previous) => {
  if (state.switches.connectors === previous.switches.connectors) return;
  resetConnectors(state.switches.connectors);
  // The lists ask again on focus; a reload shows it at once.
  location.reload();
});

function connectorsState() {
  const now = Date.now();
  return {
    available: true,
    reason: null,
    connectors: CONNECTOR_META.map((meta) => {
      const state = connectors.get(meta.provider)!;
      if (state.connectedAt === null && state.startedAt !== null && now - state.startedAt > 1_800) {
        state.connectedAt = new Date().toISOString();
        state.startedAt = null;
      }
      return {
        ...meta,
        available: true,
        connected: state.connectedAt !== null,
        account: state.connectedAt !== null ? ACCOUNT[meta.provider] : null,
        connectedAt: state.connectedAt,
        toolCount: state.connectedAt !== null ? 12 : 0,
      };
    }),
  };
}

const VAULT = [
  { id: "cred-github", label: "GitHub", url: "https://github.com/login", username: "technoob228" },
  {
    id: "cred-hostkey",
    label: "Hostkey",
    url: "https://my.hostkey.com",
    username: "misha@getuno.xyz",
  },
  {
    id: "cred-stripe",
    label: "Stripe dashboard",
    url: "https://dashboard.stripe.com",
    username: "misha@getuno.xyz",
  },
  {
    id: "cred-cloudflare",
    label: "Cloudflare",
    url: "https://dash.cloudflare.com",
    username: "misha@getuno.xyz",
  },
  { id: "cred-cloudflare-token", label: "Cloudflare API token", url: "", username: "" },
  { id: "cred-openai", label: "OpenAI API key", url: "", username: "" },
  { id: "cred-hostkey-api", label: "Hostkey API key", url: "", username: "" },
].map((entry, index) => ({ ...entry, updatedAt: Date.now() - index * 86_400_000 }));

/** WebSocket RPC answers the team needs (the vault lives on the computer). */
export function answerTeamRpc(tag: string): unknown {
  if (tag === "vault.list") return VAULT;
  return undefined;
}

const PROJECT_SKILLS = [
  {
    name: "release-train",
    project: "fishcode",
    path: ".claude/skills/release-train/SKILL.md",
    description: "How a release goes out.",
  },
  {
    name: "go-migrations",
    project: "fishcode",
    path: ".claude/skills/go-migrations/SKILL.md",
    description: "Writing a migration safely.",
  },
  {
    name: "electron-release",
    project: "uno-work-app",
    path: ".claude/skills/electron-release/SKILL.md",
    description: "Building and notarizing the Mac app.",
  },
  {
    name: "browser-tests",
    project: "uno-work-app",
    path: ".claude/skills/browser-tests/SKILL.md",
    description: "Running the browser tests.",
  },
  {
    name: "landing-copy",
    project: "landing",
    path: ".claude/skills/landing-copy/SKILL.md",
    description: "Our words on the landing.",
  },
  {
    name: "pult-post",
    project: "uno-project",
    path: ".claude/skills/pult-post/SKILL.md",
    description: "Posting to the Pult.",
  },
];

// ── What each computer's daemon answers ───────────────────────────────────

const SUMMARIES: Record<
  MachineKey,
  ReadonlyArray<{ projectId: string; title: string; emoji: string | null }>
> = {
  work: [
    { projectId: ASSISTANT_PROJECT_ID, title: "Uno", emoji: null },
    { projectId: SCOUT, title: "Scout", emoji: "🔭" },
  ],
  product: [{ projectId: BUILDER, title: "Builder", emoji: "🛠️" }],
  mac: [],
};

const FILES: Record<string, Record<string, string>> = {
  [ASSISTANT_PROJECT_ID]: {
    "NOTES.md":
      "# Notes\n- Misha pays Hostkey from the card ending 4412, asks first\n- Morning plan goes to Telegram at 08:00\n- Releases: Work on Fridays, never during a hackathon\n",
    "AGENTS.md":
      "# Uno\nYou are Misha's personal assistant. Take tasks only from Misha.\nRun work in chats on his computers; write to him only when he is needed.\n",
  },
  [BUILDER]: {
    "NOTES.md":
      "# Notes\n- internal/exitip tests are flaky under load: re-run with -race once\n- PRs go to release/0.0.138\n",
    "AGENTS.md":
      "# Builder\nDeveloper for fishcode and uno-work-app. Ask Misha before merging or deploying.\n",
  },
  [SCOUT]: {
    "NOTES.md":
      "# Notes\n- Watch: Replit, Lovable, Cursor, Bolt\n- Misha wants three lines per competitor, no fluff\n",
    "AGENTS.md":
      "# Scout\nMarketing observer. Read only: landing and uno-project. Summaries every Monday.\n",
  },
};

interface MachineAi {
  provider: AssistantLlmStatus["provider"];
  model: string;
  chatgptReady: boolean;
  signInStartedAt: number | null;
}

const ai = new Map<MachineKey, MachineAi>();
function aiOf(machine: DemoMachine): MachineAi {
  let state = ai.get(machine.key);
  if (!state) {
    // On the Mac ChatGPT isn't signed in yet: the setup shows both states.
    state = {
      provider: "uno",
      model: "uno/smart",
      chatgptReady: machine.key !== "mac",
      signInStartedAt: null,
    };
    ai.set(machine.key, state);
  }
  return state;
}

function llmStatus(machine: DemoMachine): AssistantLlmStatus {
  const state = aiOf(machine);
  return {
    threadId: null,
    provider: state.provider,
    model: state.model,
    harness: { state: "ready", message: null, version: "0.21.5", logTail: null },
    keys: [],
    gatewayConfigured: true,
    subscriptions: [
      {
        provider: "claude",
        state: "ready",
        plan: "Claude Max",
        account: "misha@getuno.xyz",
        signIn: "harness",
        message: null,
      },
      {
        provider: "chatgpt",
        state: state.chatgptReady ? "ready" : "sign-in",
        plan: state.chatgptReady ? "ChatGPT Plus" : null,
        account: state.chatgptReady ? "misha@getuno.xyz" : null,
        signIn: "assistant",
        message: null,
      },
    ],
  } as AssistantLlmStatus;
}

function signInStatus(machine: DemoMachine) {
  const state = aiOf(machine);
  const done = state.signInStartedAt !== null && Date.now() - state.signInStartedAt > 6_000;
  if (done) state.chatgptReady = true;
  return {
    provider: "chatgpt",
    state: state.chatgptReady ? "succeeded" : state.signInStartedAt ? "waiting" : "idle",
    url: "https://auth.openai.com/codex/device",
    code: "K7QX-2MWD",
    message: null,
  };
}

const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "new";

// ── p7: the assistant sets itself up in a chat (Misha 16.10) ──────────────

interface ChatHooks {
  readonly create: (
    machine: DemoMachine,
    input: { threadId: string; projectId: string; title: string },
  ) => void;
  readonly says: (
    machine: DemoMachine,
    threadId: string,
    text: string,
    question?: Record<string, unknown>,
  ) => void;
}
let chatHooks: ChatHooks | null = null;

function worldOf(machine: DemoMachine): SetupWorld {
  return {
    projects: PROJECTS[machine.key]
      .filter((project) => !project.id.startsWith("assistant-") && project.title !== "Home folder")
      .map((project) => project.title),
    connected: (provider) => connectors.get(provider as Provider)?.connectedAt != null,
    keys: VAULT.filter((entry) => entry.url === "").map((entry) => ({
      id: entry.id,
      label: entry.label,
    })),
  };
}

const machineByEnvironment = (environmentId: string) =>
  (Object.values(MACHINES) as DemoMachine[]).find(
    (machine) => machine.environmentId === environmentId,
  ) ?? null;

export const isSetupChat = isSetupChatThread;

/** The person answered a question of a setup chat: the assistant saves it and asks on. */
export function answerSetupChat(environmentId: string, threadId: string, answer: string) {
  const machine = machineByEnvironment(environmentId);
  if (!machine || !chatHooks) return;
  const next = answerSetupChatTurn(threadId, answer, worldOf(machine));
  if (!next) return;
  const hooks = chatHooks;
  // A short "thinking" beat, like a person typing.
  setTimeout(
    () =>
      hooks.says(
        machine,
        threadId,
        next.text,
        next.question
          ? (next.question as SetupQuestion as unknown as Record<string, unknown>)
          : undefined,
      ),
    1100,
  );
}

export function assistantHandlers(input: {
  readonly machineForHost: (host: string) => DemoMachine;
  /** Makes the assistant's folder on that computer (and tells the page). */
  readonly addProject: (
    machine: DemoMachine,
    project: { id: string; title: string; workspaceRoot: string },
  ) => void;
  /** p7: the setup chat — a new thread, and the assistant's lines in it. */
  readonly chat: ChatHooks;
}) {
  chatHooks = input.chat;
  const machineOf = (request: Request) => input.machineForHost(new URL(request.url).host);
  return [
    http.post("*/api/manager/assistants/:projectId/setup-chat", ({ request, params }) => {
      const machine = machineOf(request);
      const projectId = String(params.projectId);
      const key = `${machine.environmentId}:${projectId}`;
      const name = useAssistantTeamStore.getState().profiles[key]?.name ?? "assistant";
      const threadId = `setup-${projectId}-${Date.now().toString(36)}`;
      input.chat.create(machine, { threadId, projectId, title: `Setting up ${name}` });
      const first = startSetupChat(
        threadId,
        { environmentId: machine.environmentId, key },
        worldOf(machine),
      );
      setTimeout(
        () =>
          input.chat.says(
            machine,
            threadId,
            first.text,
            first.question ? (first.question as unknown as Record<string, unknown>) : undefined,
          ),
        700,
      );
      return HttpResponse.json({ threadId });
    }),
    http.get("*/api/manager/assistants", ({ request }) => {
      const machine = machineOf(request);
      return HttpResponse.json({
        assistants: SUMMARIES[machine.key].map((item) => ({
          projectId: item.projectId,
          title: item.title,
          workspaceRoot: `${machine.home}/UnoWork/Assistants/${item.title.toLowerCase()}`,
          token: null,
          telegram: {
            configured: true,
            enabled: true,
            allowedChatIds: [],
            botUsername: "uno_team_bot",
            lastError: null,
          },
          slack: {
            configured: false,
            enabled: false,
            allowedChannelIds: [],
            botUserId: null,
            botUserName: null,
            lastError: null,
          },
          skills: [],
          profile: { emoji: item.emoji, template: null, createdAt: null },
        })),
      });
    }),
    http.post("*/api/manager/assistants", async ({ request }) => {
      const machine = machineOf(request);
      const body = (await request.json()) as { name?: string };
      const name = body.name?.trim() || "Assistant";
      const id = `assistant-${slugOf(name)}`;
      input.addProject(machine, {
        id,
        title: name,
        workspaceRoot: `${machine.home}/UnoWork/Assistants/${slugOf(name)}`,
      });
      return HttpResponse.json({ projectId: id });
    }),
    http.get("*/api/manager/assistant/llm", ({ request }) =>
      HttpResponse.json(llmStatus(machineOf(request))),
    ),
    http.post("*/api/manager/assistant/llm", async ({ request }) => {
      const machine = machineOf(request);
      const body = (await request.json()) as { provider: MachineAi["provider"]; model: string };
      Object.assign(aiOf(machine), { provider: body.provider, model: body.model });
      return HttpResponse.json(llmStatus(machine));
    }),
    http.get("*/api/manager/assistant/llm/models", ({ request }) => {
      const provider = new URL(request.url).searchParams.get("provider") ?? "uno";
      return HttpResponse.json({
        provider,
        models: [{ id: "uno/smart", name: "Smart" }],
        defaultModel: provider === "uno" ? "uno/smart" : null,
        error: null,
      });
    }),
    http.post("*/api/manager/assistant/llm/sign-in", ({ request }) => {
      const machine = machineOf(request);
      aiOf(machine).signInStartedAt = Date.now();
      return HttpResponse.json(signInStatus(machine));
    }),
    http.get("*/api/manager/assistant/llm/sign-in", ({ request }) =>
      HttpResponse.json(signInStatus(machineOf(request))),
    ),
    http.post("*/api/manager/assistant/llm/sign-in/cancel", ({ request }) => {
      aiOf(machineOf(request)).signInStartedAt = null;
      return HttpResponse.json({ ok: true });
    }),
    http.get("*/api/manager/connectors", () => HttpResponse.json(connectorsState())),
    http.post("*/api/manager/connectors/:provider/start", ({ params }) => {
      const provider = String(params.provider) as Provider;
      const state = connectors.get(provider);
      if (state) state.startedAt = Date.now();
      return HttpResponse.json({
        authorizeUrl: `${location.origin}${import.meta.env.BASE_URL}demo-oauth/?provider=${provider}`,
      });
    }),
    http.delete("*/api/manager/connectors/:provider", ({ params }) => {
      const state = connectors.get(String(params.provider) as Provider);
      if (state) Object.assign(state, { connectedAt: null, startedAt: null });
      return HttpResponse.json({ ok: true });
    }),
    http.post("*/api/manager/mcp/probe", () =>
      HttpResponse.json({
        ok: true,
        toolCount: 3,
        toolNames: ["resolve-library-id", "get-library-docs", "search"],
        needsAuth: false,
        error: null,
      }),
    ),
    http.get("*/api/manager/project-skills", () => HttpResponse.json({ skills: PROJECT_SKILLS })),
    http.get("*/api/manager/assistant/file", ({ request }) => {
      const url = new URL(request.url);
      const project = url.searchParams.get("projectId") ?? ASSISTANT_PROJECT_ID;
      const name = url.searchParams.get("name") ?? "NOTES.md";
      return HttpResponse.json({ content: FILES[project]?.[name] ?? "" });
    }),
    http.post("*/api/manager/assistant/telegram/pair", () => {
      const code = Math.random().toString(36).slice(2, 8);
      return HttpResponse.json({
        code,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        botUsername: "uno_team_bot",
        link: `https://t.me/uno_team_bot?start=${code}`,
      });
    }),
  ];
}
