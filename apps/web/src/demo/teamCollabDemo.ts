/**
 * T51 mockup in the demo (team/teamCollab.ts): the project "landing" has a
 * team — Misha (owner), Andrei and Olga. Misha shares a chat with Andrei;
 * Andrei's agent asks Misha's agent a question and suggests a session on
 * Misha's computer; Project settings → Team says how far their agents may go.
 *
 * Address params: `t51=off` — Work as it is today, same data (before shots);
 * `as=andrei` — Andrei's Work: the chat Misha shared, read-only.
 *
 * `window.__teamDemo` for the shot script: `.reset()`, `.state()`.
 */
import { WS_METHODS } from "@t3tools/contracts";
import { HttpResponse, http } from "msw";

import type { ChatSpec } from "./heavyFixtures";
import { seedTeamCollab, useTeamCollab } from "../team/teamCollab";

const params = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
export const TEAM_DEMO_OFF = params.get("t51") === "off";
export const TEAM_DEMO_AS_ANDREI = params.get("as") === "andrei";

/** The chat Misha shares with Andrei (and Andrei sees). */
export const SHARED_CHAT_ID = "t-stripe";
/** Misha's chat where Andrei's agent asked a question. */
export const EXCHANGE_CHAT_ID = "t-prices";
/** `sentByThreadId` of the messages Andrei's agent wrote (a chat on Andrei's computer). */
const ANDREI_AGENT_CHAT = "andrei:mobile-pricing";

const SESSION_BRIEF = `Misha's uno-work has Stripe signed in (test mode); my computer doesn't, and I need the webhook checked before we ship the mobile pricing cards.

What to do, in the landing project:
1. Run the checkout test: npm run test:checkout.
2. Send a test event: stripe trigger checkout.session.completed.
3. Check that the order shows up in the orders table with the right plan (Starter, Pro or Team).

Please don't change any code and don't deploy. Write what passed and what failed; I'll fix it on my side.`;

const STRIPE_CHAT: ChatSpec = {
  id: SHARED_CHAT_ID,
  machine: "work",
  project: "p-work-landing",
  title: "Stripe checkout for the pricing page",
  minutesAgo: 25,
  state: "read",
  role: "solo",
  messages: [
    [
      "user",
      "Wire the three plans to Stripe Checkout in test mode: Starter $9, Pro $29, Team $79 a month.",
    ],
    [
      "assistant",
      "Done in test mode. Three prices are in Stripe, the Buy buttons open Checkout, and the webhook writes the order to the orders table.\n\n- `src/checkout/prices.ts` — the three price IDs\n- `src/api/stripe-webhook.ts` — checks the signature, saves the order\n- `npm run test:checkout` — 6 tests, all green",
    ],
    ["user", "Does a cancelled payment leave anything behind?"],
    [
      "assistant",
      "No. A cancelled Checkout only writes a line to the log; the orders table stays as it was. I added a test for it (7 now, all green).",
    ],
  ],
};

const PRICES_CHAT: ChatSpec = {
  id: EXCHANGE_CHAT_ID,
  machine: "work",
  project: "p-work-landing",
  title: "Pricing page copy and prices",
  minutesAgo: 4,
  state: "read",
  role: "solo",
  messages: [
    [
      "user",
      "Keep the prices on the pricing page in sync with Stripe: one place, src/checkout/prices.ts.",
    ],
    [
      "assistant",
      "Done: the page reads the amounts from prices.ts, nothing is typed twice. Starter $9, Pro $29, Team $79.",
    ],
    [
      "user",
      "Andrei is making the mobile pricing cards. Which plans and monthly prices does the page show, and is Team still marked “Most popular”? I need the same on mobile.",
      ANDREI_AGENT_CHAT,
    ],
    [
      "assistant",
      "Three plans, from src/checkout/prices.ts: Starter $9, Pro $29, Team $79 a month. “Most popular” is on Pro now, not Team — Misha moved it on Monday. I only read the files; I didn't send any keys or files.",
    ],
  ],
};

/** Andrei's own chats in his Work (`as=andrei`). */
const ANDREI_CHATS: ChatSpec[] = [
  {
    id: "a-mobile",
    machine: "work",
    project: "p-work-landing",
    title: "Pricing page: mobile layout",
    minutesAgo: 6,
    state: "read",
    role: "solo",
    messages: [
      ["user", "Make the pricing cards stack on phones, Pro first."],
      ["assistant", "Done. Asked Misha's agent which plan is “Most popular” — it's Pro."],
    ],
  },
];

export function teamDemoChats(): ChatSpec[] {
  // Andrei's sidebar lists the shared chat under "Shared with you" only.
  if (TEAM_DEMO_AS_ANDREI) return [{ ...STRIPE_CHAT, state: "done" }, ...ANDREI_CHATS];
  return [STRIPE_CHAT, PRICES_CHAT];
}

const PEOPLE = [
  { id: "misha", name: "Misha", email: "misha@example.com", role: "owner", tone: "violet" },
  {
    id: "andrei",
    name: "Andrei Sokolov",
    email: "andrei@example.com",
    role: "editor",
    tone: "emerald",
  },
  { id: "olga", name: "Olga Petrova", email: "olga@example.com", role: "editor", tone: "amber" },
] as const;

function seed() {
  if (TEAM_DEMO_OFF) {
    seedTeamCollab({});
    return;
  }
  const viewer = TEAM_DEMO_AS_ANDREI ? "andrei" : "misha";
  seedTeamCollab({
    enabled: true,
    viewer,
    project: "landing",
    people: PEOPLE.map((person) => ({ ...person, you: person.id === viewer })),
    shares: TEAM_DEMO_AS_ANDREI ? {} : { [SHARED_CHAT_ID]: [] },
    sharedWithMe: TEAM_DEMO_AS_ANDREI
      ? { [SHARED_CHAT_ID]: { ownerId: "misha", level: "read", computer: "uno-work" } }
      : {},
    requests: TEAM_DEMO_AS_ANDREI
      ? [
          {
            id: "tr-shared",
            kind: "shared",
            fromPersonId: "misha",
            viaAgentChat: null,
            project: "landing",
            computer: "uno-work",
            title: "Misha shared a chat with you",
            gist: "Stripe checkout for the pricing page · you can read",
            minutesAgo: 1,
            status: "waiting",
          },
        ]
      : [
          {
            id: "tr-session",
            kind: "session",
            fromPersonId: "andrei",
            viaAgentChat: "Pricing page: mobile layout",
            project: "landing",
            computer: "uno-work",
            title: "Check the Stripe webhook before release",
            gist: "Run the checkout test and one test payment here: only your uno-work is signed in to Stripe",
            brief: SESSION_BRIEF,
            minutesAgo: 2,
            status: "waiting",
          },
          {
            id: "tr-message",
            kind: "message",
            fromPersonId: "andrei",
            viaAgentChat: null,
            project: "landing",
            computer: "uno-work",
            title: "Andrei",
            gist: "Mobile pricing cards are in the branch mobile-pricing. Have a look when you can, no rush.",
            minutesAgo: 9,
            status: "waiting",
          },
        ],
    agentSenders: {
      [ANDREI_AGENT_CHAT]: {
        personId: "andrei",
        chatTitle: "Pricing page: mobile layout",
        level: "answer",
      },
    },
    markedChats: { [EXCHANGE_CHAT_ID]: "andrei" },
    defaultLevel: "ask",
    levelFor: { andrei: "answer" },
    journal: [
      {
        at: "14:16",
        text: "Andrei's agent asked yours which plans the page shows — answered by itself",
        level: "answer",
      },
      {
        at: "14:18",
        text: "Andrei's agent suggests a session on uno-work — waits for you",
        level: "ask",
      },
      {
        at: "Yesterday",
        text: "Olga's agent sent you the new hero image — in your Inbox",
        level: "ask",
      },
      { at: "Yesterday", text: "You declined a session from Olga's agent (“Clean up old images”)" },
    ],
  });
}

export function installTeamCollabDemo() {
  seed();
  (window as unknown as { __teamDemo: unknown }).__teamDemo = {
    reset: seed,
    state: () => useTeamCollab.getState(),
  };
}

// ── The Uno account's project team (/api/v1/work/team, already in prod) ──

const TEAM_PROJECT_ID = 512;
const person = (id: number, username: string, email: string) => ({ user_id: id, username, email });
const OWNER = person(85, "misha", "misha@example.com");

export function teamAccountHandlers() {
  const projectRow = {
    id: TEAM_PROJECT_ID,
    name: "landing",
    role: TEAM_DEMO_AS_ANDREI ? "editor" : "owner",
    owner: OWNER,
  };
  return [
    http.get("*/_account/api/v1/work/team/projects", () =>
      HttpResponse.json({ projects: [projectRow], invites: [] }),
    ),
    http.get(`*/_account/api/v1/work/team/projects/${TEAM_PROJECT_ID}`, () =>
      HttpResponse.json({
        project: projectRow,
        members: [
          { ...OWNER, username: "Misha", role: "owner" },
          {
            ...person(2731, "Andrei Sokolov", "andrei@example.com"),
            role: "editor",
            secrets: ["STRIPE_PUBLISHABLE_KEY"],
          },
          { ...person(2744, "Olga Petrova", "olga@example.com"), role: "editor", secrets: [] },
        ],
        invites: [],
        secrets: ["STRIPE_PUBLISHABLE_KEY", "STRIPE_SECRET_KEY"],
      }),
    ),
  ];
}

// ── "On all my computers" for landing on uno-work (Team needs it) ────────

export function answerTeamCollabRpc(machineKey: string, tag: string, body: unknown): unknown {
  if (machineKey !== "work") return undefined;
  const projectId = (body as { projectId?: string } | null)?.projectId ?? "p-work-landing";
  switch (tag) {
    case WS_METHODS.projectSyncStatus:
      return {
        available: true,
        unavailableReason: null,
        projects: [
          {
            projectId: "p-work-landing",
            enabled: true,
            name: "landing",
            mode: "git",
            state: "synced",
            message: "",
            lastSyncedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
            conflict: null,
            team: TEAM_DEMO_AS_ANDREI ? { id: TEAM_PROJECT_ID, owner: "Misha" } : null,
          },
        ],
        elsewhere: [],
      };
    case WS_METHODS.projectSyncHistory:
      return { mode: "git", versions: [], more: false };
    case WS_METHODS.projectSyncFiles:
      return { mode: "git", synced: 214, localOnly: [], keyFiles: [".env"], more: 0 };
    case WS_METHODS.projectSecretsList:
      return {
        projectId,
        synced: true,
        secrets: [
          { name: "STRIPE_PUBLISHABLE_KEY", inVault: true, inFile: true },
          { name: "STRIPE_SECRET_KEY", inVault: true, inFile: true },
        ],
        vaultError: null,
      };
    default:
      return undefined;
  }
}
