/**
 * The assistants base (28.10): what the made-up account has in each world —
 * projects and chats on every computer, the Inbox, the assistants (Uno on
 * each computer + the personas a variant adds). Replaces the 16.10 mock's
 * heavy fixtures at the start (installAssistFixtures), so the real web
 * client renders them through the same wire shapes (heavyFixtures.ts).
 *
 * Made-up work of a small founder (a landing, an orders bot, a pitch deck);
 * no client data.
 */
import { ASSISTANT_PROJECT_ID } from "@t3tools/contracts";

import {
  CHATS,
  INBOX,
  PROJECTS,
  type ChatSpec,
  type MachineKey,
  type ProjectSpec,
} from "../heavyFixtures";
import { type AssistWorld, macOnline, thirdOnline } from "./world";

/** An assistant the demo has: its folder on one computer, how it looks, what its daemon keeps. */
export interface DemoPersona {
  /** Its folder id: `assistant-home` is Uno, others `assistant-<slug>`. */
  readonly projectId: string;
  readonly machine: MachineKey;
  readonly name: string;
  readonly emoji: string | null;
  readonly tone: string;
  readonly roles: ReadonlyArray<string>;
  readonly character: string;
  readonly duties: ReadonlyArray<string>;
  /** Set up already (its first click opens its chat), or the first click starts its setup. */
  readonly setUp: boolean;
  /** Its own chats (the first is its main one; Telegram talks to that one). */
  readonly chats: ReadonlyArray<ChatSpec>;
}

/**
 * The assistants of the demo, besides Uno. A variant adds its own here (in
 * `variant.ts`, before the demo starts) — any number, on any computer.
 */
export const DEMO_PERSONAS: DemoPersona[] = [];

const UNO_ROOT: Record<MachineKey, string> = {
  work: "/home/uno/.uno/assistant",
  product: "/home/uno/.uno/assistant",
  mac: "/Users/misha/.uno/assistant",
};

const REPO = {
  landing: "github.com/misha-demo/landing",
  bot: "github.com/misha-demo/orders-bot",
  deck: "github.com/misha-demo/pitch-deck",
} as const;

function liveProjects(): Record<MachineKey, ProjectSpec[]> {
  return {
    work: [
      { id: "p-work-home", title: "Home folder", root: "/home/uno" },
      { id: ASSISTANT_PROJECT_ID, title: "Uno", root: UNO_ROOT.work },
      {
        id: "p-work-landing",
        title: "landing",
        root: "/home/uno/projects/landing",
        repo: REPO.landing,
      },
      {
        id: "p-work-bot",
        title: "orders-bot",
        root: "/home/uno/projects/orders-bot",
        repo: REPO.bot,
      },
    ],
    // Variant A: one Uno on the account — it lives on uno-work; the MacBook is its hands.
    mac: [
      { id: "p-mac-home", title: "Home folder", root: "/Users/misha" },
      {
        id: "p-mac-landing",
        title: "landing",
        root: "/Users/misha/projects/landing",
        repo: REPO.landing,
      },
      {
        id: "p-mac-deck",
        title: "pitch-deck",
        root: "/Users/misha/projects/pitch-deck",
        repo: REPO.deck,
      },
    ],
    // The Free computer is asleep (the page never reaches its daemon), or awake (`third=online`).
    product: [],
  };
}

/** Variant A: the third computer when it's awake — one project, Uno's hands there too. */
function thirdProjects(): ProjectSpec[] {
  return [
    { id: "p-free-home", title: "Home folder", root: "/home/uno" },
    {
      id: "p-free-newsletter",
      title: "newsletter",
      root: "/home/uno/projects/newsletter",
      repo: "github.com/misha-demo/newsletter",
    },
  ];
}

function newProjects(): Record<MachineKey, ProjectSpec[]> {
  return {
    work: [
      { id: "p-work-home", title: "Home folder", root: "/home/uno" },
      { id: ASSISTANT_PROJECT_ID, title: "Uno", root: UNO_ROOT.work },
    ],
    mac: [],
    product: [],
  };
}

/** Uno's main chat on uno-work: yesterday's summary, a Telegram question, a task it ran on the Mac. */
const UNO_MAIN: ChatSpec = {
  id: "uno-main",
  machine: "work",
  project: ASSISTANT_PROJECT_ID,
  title: "Uno",
  minutesAgo: 40,
  state: "read",
  role: "assistant",
  messages: [
    [
      "assistant",
      "Good morning. 3 things today: Acme's invoice is 5 days late, the landing build on the MacBook failed overnight, and the orders-bot export ran fine (212 orders).",
    ],
    ["user", "📱 Telegram: fix the landing build"],
    [
      "assistant",
      "Fixed on the MacBook: a missing image in /public. The build is green, the preview is at landing-misha.uno4.me.",
    ],
    ["user", "Thanks. Remind me about Acme at 4 pm."],
    ["assistant", "Will do — at 16:00 here and in Telegram."],
  ],
};

function liveChats(world: AssistWorld): ChatSpec[] {
  const chats: ChatSpec[] = [
    UNO_MAIN,
    {
      id: "uno-acme",
      machine: "work",
      project: ASSISTANT_PROJECT_ID,
      // Variant A: a channel of Uno's (a topic), like Duet's.
      title: "invoices",
      minutesAgo: 60 * 20,
      state: "read",
      role: "solo",
      messages: [
        ["user", "Draft a polite reminder to Acme about invoice #1042."],
        [
          "assistant",
          "Draft is in Gmail → Drafts: “Invoice #1042 — a gentle reminder”. I didn't send it.",
        ],
      ],
    },
    {
      id: "w-checkout",
      machine: "work",
      project: "p-work-landing",
      title: "Checkout button does nothing on mobile",
      minutesAgo: 60 * 3,
      state: "done",
      role: "solo",
      messages: [
        ["user", "The checkout button does nothing on iPhone."],
        [
          "assistant",
          "The button was under a transparent banner on narrow screens. Fixed and deployed.",
        ],
      ],
    },
    {
      id: "w-export",
      machine: "work",
      project: "p-work-bot",
      title: "Daily orders export to Drive",
      minutesAgo: 60 * 9,
      state: "scheduled",
      role: "solo",
      schedule: {
        at: new Date(Date.now() + 60 * 60_000 * 14).toISOString(),
        every: "every day at 07:00",
      },
      messages: [
        ["user", "Every morning export yesterday's orders to Drive as a sheet."],
        [
          "assistant",
          "Done for today: 212 orders → Drive / Orders / 2026-10-27. Next run tomorrow at 07:00.",
        ],
      ],
    },
  ];
  // Variant A: one more channel of Uno's.
  chats.push({
    id: "uno-landing",
    machine: "work",
    project: ASSISTANT_PROJECT_ID,
    title: "landing",
    minutesAgo: 60 * 6,
    state: "read",
    role: "solo",
    messages: [
      ["user", "Everything about the landing goes here. Launch is Friday."],
      [
        "assistant",
        "Got it — #landing. Checklist: 4 of 6 done. Left: the pricing copy and the checkout test on a phone.",
      ],
    ],
  });
  if (world.many === "on") chats.push(...manyChannels());
  if (thirdOnline(world)) {
    chats.push({
      id: "f-newsletter",
      machine: "product",
      project: "p-free-newsletter",
      title: "Newsletter #14 draft",
      minutesAgo: 35,
      state: "needs-you",
      role: "from-uno",
      ask: {
        kind: "permission",
        text: "Draft is ready. Send newsletter #14 to 1,240 subscribers?",
        command: "Send newsletter #14 to 1,240 subscribers",
      },
      messages: [
        ["user", "Uno: draft newsletter #14 from this week's changelog."],
        ["assistant", "Draft is in newsletter/drafts/14.md — 380 words, 3 sections."],
      ],
    });
  }
  if (macOnline(world)) {
    chats.push(
      {
        id: "m-landing-build",
        machine: "mac",
        project: "p-mac-landing",
        title: "Fix the landing build",
        minutesAgo: 70,
        state: "unread",
        role: "from-uno",
        messages: [
          ["user", "Uno: the landing build fails — fix it and tell me what it was."],
          [
            "assistant",
            "A missing image in /public/hero.webp. Added it back, `npm run build` is green.",
          ],
        ],
      },
      {
        id: "m-deck",
        machine: "mac",
        project: "p-mac-deck",
        title: "Slide 7: update the numbers",
        minutesAgo: 60 * 26,
        state: "read",
        role: "solo",
        messages: [
          ["user", "Update slide 7 with October revenue."],
          ["assistant", "Slide 7 now says $190 MRR, 12 paying. Exported pitch-deck.pdf."],
        ],
      },
    );
  }
  return chats;
}

/** `many=on`: a heavy account — 10 more channels of Uno's. */
const MANY_CHANNELS = [
  "hiring",
  "taxes-2026",
  "investors",
  "support",
  "partners",
  "content-plan",
  "travel",
  "orders-bot",
  "pitch-deck",
  "family",
];
function manyChannels(): ChatSpec[] {
  return MANY_CHANNELS.map((title, index) => ({
    id: `uno-ch-${title}`,
    machine: "work" as const,
    project: ASSISTANT_PROJECT_ID,
    title,
    minutesAgo: 60 * 24 * (index + 1),
    state: "read" as const,
    role: "solo" as const,
    messages: [
      ["user", `Everything about ${title} goes here.`] as const,
      ["assistant", `OK — #${title}. I'll keep it out of Everything.`] as const,
    ],
  }));
}

function liveInbox(world: AssistWorld): (typeof INBOX)[number][] {
  const items: (typeof INBOX)[number][] = [
    {
      id: "i-morning",
      machine: "work",
      kind: "agent.done",
      minutesAgo: 40,
      chat: "uno-main",
      title: "Uno: your morning summary",
      body: "Acme is 5 days late · landing build fixed on the MacBook · 212 orders exported.",
    },
    {
      id: "i-export",
      machine: "work",
      kind: "agent.done",
      minutesAgo: 60 * 9,
      chat: "w-export",
      read: true,
      title: "Finished: Daily orders export to Drive",
      body: "212 orders → Drive / Orders / 2026-10-27.",
    },
  ];
  if (thirdOnline(world)) {
    items.push({
      id: "i-free-newsletter",
      machine: "product",
      kind: "agent.approval",
      minutesAgo: 35,
      chat: "f-newsletter",
      title: "Uno asks: send newsletter #14 to 1,240 subscribers?",
      body: "The draft is in newsletter/drafts/14.md — 380 words.",
    });
  }
  if (macOnline(world)) {
    items.push({
      id: "i-mac-build",
      machine: "mac",
      kind: "agent.done",
      minutesAgo: 70,
      chat: "m-landing-build",
      title: "Finished on MacBook: Fix the landing build",
      body: "A missing image in /public. The build is green.",
    });
  } else {
    items.push({
      id: "i-mac-asleep",
      machine: "work",
      kind: "app",
      minutesAgo: 25,
      source: { kind: "system", id: "uno", name: "Uno", icon: "💤" },
      title: "Your MacBook is asleep",
      body: "Uno keeps working here on uno-work. Chats on the MacBook wait until it wakes.",
      open: null,
    });
  }
  if (world.connectors.gmail === "expired") {
    items.push({
      id: "i-gmail-expired",
      machine: "work",
      kind: "app",
      minutesAgo: 12,
      source: { kind: "system", id: "connectors", name: "Gmail", icon: "✉️" },
      title: "Gmail needs you to sign in again",
      body: "Google ended the sign-in. Uno can't read or send mail until you reconnect.",
      open: null,
    });
  }
  if (world.tier === "free") {
    items.push({
      id: "i-free-sleep",
      machine: "work",
      kind: "app",
      minutesAgo: 60 * 5,
      read: true,
      source: { kind: "system", id: "uno", name: "Uno", icon: "⏱" },
      title: "On Free, uno-work sleeps after 15 min without you",
      body: "Uno answers Telegram when it wakes (about 20 s). Plus keeps it on.",
      open: { kind: "url", url: "https://console.uno4.dev/billing?tab=plan" },
    });
  }
  return items;
}

/** A persona's folder and chats go in with the rest. */
function personaParts(persona: DemoPersona) {
  const slug = persona.projectId.replace(/^assistant-/, "");
  const home = persona.machine === "mac" ? "/Users/misha" : "/home/uno";
  return {
    project: {
      id: persona.projectId,
      title: persona.name,
      root: `${home}/UnoWork/Assistants/${slug}`,
    } satisfies ProjectSpec,
    chats: persona.chats,
  };
}

function replace<T>(target: T[], next: ReadonlyArray<T>) {
  target.length = 0;
  target.push(...next);
}

/**
 * The 16.10 mock's fixtures out, this world's in (CHATS, PROJECTS and INBOX
 * are what demoBoot builds every computer from). Called once, before boot.
 */
export function installAssistFixtures(world: AssistWorld) {
  const live = world.account === "live";
  const projects = live ? liveProjects() : newProjects();
  if (live && thirdOnline(world)) projects.product = thirdProjects();
  const chats = live ? liveChats(world) : [];
  for (const persona of DEMO_PERSONAS) {
    if (!live && persona.machine !== "work") continue;
    if (persona.machine === "mac" && !macOnline(world)) continue;
    const parts = personaParts(persona);
    projects[persona.machine].push(parts.project);
    chats.push(...parts.chats);
  }
  for (const key of Object.keys(PROJECTS) as MachineKey[]) replace(PROJECTS[key], projects[key]);
  replace(CHATS, chats);
  replace(INBOX, live ? liveInbox(world) : []);
}

/** Uno, plus the personas on that computer, as the daemon lists them. */
export function assistantsOn(machine: MachineKey, world: AssistWorld): ReadonlyArray<DemoPersona> {
  const projects = PROJECTS[machine];
  if (!projects.some((project) => project.id === ASSISTANT_PROJECT_ID)) return [];
  const uno: DemoPersona = {
    projectId: ASSISTANT_PROJECT_ID,
    machine,
    name: "Uno",
    emoji: null,
    tone: "violet",
    roles: ["Personal assistant"],
    character: "Calm, short, says what matters first.",
    duties:
      world.account === "live" ? ["Morning summary at 08:00", "Watch the inbox for money"] : [],
    // A new account's Uno is there already and talks first (Duet): it is
    // never "not set up" — its first chat is its introduction.
    setUp: true,
    chats: [],
  };
  return [uno, ...DEMO_PERSONAS.filter((persona) => persona.machine === machine)];
}
