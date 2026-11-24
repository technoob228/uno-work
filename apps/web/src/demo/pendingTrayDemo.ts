/**
 * T52 demo (Misha 20.11): one long coordinator chat where three things wait
 * for the person — a choice card that answered his question, a link to two
 * hero banners, and a pricing report card (posted twice: the newer one
 * replaces the older) — buried under the helpers' talk. The demo daemon
 * folds the chat with the daemon's own code (@t3tools/shared/pendingForYou)
 * into the shell's `pendingForYou`; the strip, the sidebar count and the
 * feed marks are the real ones. Only the chat is made up.
 */
import type { ThreadPendingForYou } from "@t3tools/contracts";
import { injectHtmlRenderBootstrap, readHtmlRenderReference } from "@t3tools/shared/htmlRender";
import {
  derivePendingForYouState,
  normalizePendingLink,
  pendingFeedOf,
  pendingForYouView,
} from "@t3tools/shared/pendingForYou";
import type { PersonCard } from "@t3tools/shared/personCard";
import { renderPersonCardHtml } from "@t3tools/shared/personCardHtml";

import type { ChatSpec } from "./heavyFixtures";
import { demoHooks } from "./demoFlag";

export const PENDING_TRAY_CHAT_ID = "w-t52-launch";
const PROJECT = "p-work-landing";

/**
 * The banners as the person's published sites. The demo's screenshot script
 * answers these addresses with public/demo-site/banner-*.html.
 */
const BANNER_A = "https://launch-banner-a.uno4.me/";
const BANNER_B = "https://launch-banner-b.uno4.me/";

const CHOICE: PersonCard = {
  kind: "choice",
  question: "Ship on Thursday?",
  options: [
    {
      label: "Thursday",
      description: "Copy freezes Wednesday 12:00",
      recommended: true,
    },
    { label: "Keep Friday", description: "One more day for the banners" },
  ],
};

const PRICING_V1: PersonCard = {
  kind: "report",
  title: "Pricing: where we stand",
  summary: "4 competitors checked. $12 a month keeps us the cheapest that never sleeps.",
  metrics: [
    { label: "Trial → paid", value: "18%", tone: "good" },
    { label: "Median rival", value: "$20" },
    { label: "Our price now", value: "$9" },
  ],
  actions: [{ label: "Go with $12", style: "success" }, { label: "Keep $9" }],
};

const PRICING_V2: PersonCard = {
  kind: "report",
  title: "Pricing: where we stand",
  summary: "6 competitors now (Lovable went to $30). $12 is still the cheapest that never sleeps.",
  metrics: [
    { label: "Trial → paid", value: "18%", tone: "good" },
    { label: "Median rival", value: "$22", note: "was $20" },
    { label: "Our price now", value: "$9" },
  ],
  sections: [
    {
      table: {
        columns: ["Product", "Starts at", "Sleeps when idle"],
        rows: [
          ["Lovable", "$30", "—"],
          ["Replit", "$20", "yes"],
          ["Railway", "$5 + usage", "no"],
          ["Uno (proposed)", "$12", "no"],
        ],
      },
    },
  ],
  actions: [
    { label: "Go with $12", style: "success" },
    { label: "Keep $9" },
    { label: "Show all six" },
  ],
};

interface DemoCard {
  readonly attachmentId: string;
  readonly card: PersonCard;
  readonly height: number;
  /** After which message of the chat it shows. */
  readonly afterMessage: number;
}

const CARDS: ReadonlyArray<DemoCard> = [
  { attachmentId: "t52-ship-thursday", card: CHOICE, height: 250, afterMessage: 3 },
  { attachmentId: "t52-pricing-v1", card: PRICING_V1, height: 330, afterMessage: 5 },
  { attachmentId: "t52-pricing-v2", card: PRICING_V2, height: 520, afterMessage: 23 },
];

const cardTitle = (card: PersonCard) =>
  card.kind === "choice" ? (card.title ?? card.question) : (card.title ?? "Quiz");

/** The cards' pages, by file name, for the demo's file reads (demoFiles.ts). */
export const PENDING_TRAY_PAGES: Record<string, string> = Object.fromEntries(
  CARDS.map(({ attachmentId, card }) => [
    `${attachmentId}.html`,
    injectHtmlRenderBootstrap(renderPersonCardHtml(card)),
  ]),
);

/** The coordinator's chat and its three helpers. */
export function pendingTrayChats(): ChatSpec[] {
  const bannerA = BANNER_A;
  const bannerB = BANNER_B;
  return [
    {
      id: PENDING_TRAY_CHAT_ID,
      machine: "work",
      project: PROJECT,
      title: "Launch week — coordinator",
      minutesAgo: 1,
      state: "read",
      role: "coordinator",
      pinned: true,
      turnPerReply: true,
      messages: [
        [
          "user",
          "Run launch week: pricing, two hero banners, the release checks. Tell me only what needs me.",
        ],
        [
          "assistant",
          "Split into three helpers: Pricing research, Hero banners, Release checks. I'll post here what needs you.",
        ],
        ["user", "Can we ship on Thursday instead of Friday?"],
        ["assistant", "Thursday works if the copy freezes Wednesday at noon. Your call:"],
        [
          "user",
          "From Pricing research: 4 competitors checked, the table is in pricing.md. Our trial converts 18%.",
          "h-t52-pricing",
        ],
        ["assistant", "Here is where pricing stands — one decision for you."],
        [
          "user",
          "From Hero banners: both variants are published, A is calm with the product shot, B leads with the promise.",
          "h-t52-banners",
        ],
        [
          "assistant",
          `Both hero banners are up: [Variant A](${bannerA}) · [Variant B](${bannerB}). I'd go with B — open them when you can.`,
        ],
        [
          "user",
          "From Release checks: 6 of 8 green. The Stripe webhook test is flaky.",
          "h-t52-release",
        ],
        ["assistant", "Re-run the webhook test three times; call it green only if all three pass."],
        [
          "user",
          "From Pricing research: the FAQ draft is ready in faq.md — refunds, seats, invoices.",
          "h-t52-pricing",
        ],
        ["assistant", "Good. Put it under the plans table and keep each answer to two lines."],
        [
          "user",
          "From Release checks: Lighthouse on /pricing — performance 91, accessibility 100.",
          "h-t52-release",
        ],
        [
          "assistant",
          "Fine for launch. The hero image is the heaviest thing on the page: Hero banners, compress it once the variant is picked.",
        ],
        ["user", "From Hero banners: will do, waiting for the pick.", "h-t52-banners"],
        ["assistant", "OK."],
        [
          "user",
          "From Release checks: links checked, 0 broken; the sitemap lists /pricing.",
          "h-t52-release",
        ],
        ["assistant", "Good. Next: the webhook re-runs."],
        ["user", "Also check the mobile checkout before you call it green."],
        ["assistant", "Will do — added it to Release checks."],
        ["user", "From Release checks: webhook passed 3 of 3.", "h-t52-release"],
        ["assistant", "Good. Now the mobile checkout on iPhone and Android, please."],
        [
          "user",
          "From Pricing research: two more competitors added. Lovable raised its plan to $30.",
          "h-t52-pricing",
        ],
        ["assistant", "Updated the pricing card with the two new ones."],
        [
          "user",
          "From Release checks: mobile checkout OK on iPhone 15 and Pixel 8.",
          "h-t52-release",
        ],
        ["assistant", "Release checks are green: 8 of 8."],
        ["user", "From Hero banners: exported B at 2× for retina screens.", "h-t52-banners"],
        ["assistant", "Noted. Waiting on your banner pick for the final export."],
      ],
    },
    {
      id: "h-t52-pricing",
      machine: "work",
      project: PROJECT,
      title: "Pricing research",
      minutesAgo: 12,
      state: "read",
      role: "helper",
      parent: PENDING_TRAY_CHAT_ID,
      messages: [
        ["user", "From the coordinator: compare our price with the closest rivals."],
        ["assistant", "6 competitors in pricing.md; Lovable went to $30."],
      ],
    },
    {
      id: "h-t52-banners",
      machine: "work",
      project: PROJECT,
      title: "Hero banners",
      minutesAgo: 4,
      state: "read",
      role: "helper",
      parent: PENDING_TRAY_CHAT_ID,
      messages: [
        ["user", "From the coordinator: two hero banners, publish both."],
        ["assistant", "A and B published; B exported at 2×."],
      ],
    },
    {
      id: "h-t52-release",
      machine: "work",
      project: PROJECT,
      title: "Release checks",
      minutesAgo: 7,
      state: "read",
      role: "helper",
      parent: PENDING_TRAY_CHAT_ID,
      messages: [
        ["user", "From the coordinator: run the release checks for Thursday."],
        ["assistant", "8 of 8 green."],
      ],
    },
  ];
}

/** The coordinator chat's cards, each a moment after its message (buildThread). */
export function pendingTrayActivities(
  chatId: string,
  messages: ReadonlyArray<{ createdAt: string; turnId: string | null }>,
): Array<Record<string, unknown>> {
  if (chatId !== PENDING_TRAY_CHAT_ID) return [];
  return CARDS.flatMap(({ attachmentId, card, height, afterMessage }) => {
    const after = messages[afterMessage];
    if (!after) return [];
    return [
      {
        id: `${attachmentId}-page`,
        tone: "info",
        kind: "html.render",
        summary: "Card",
        payload: {
          attachmentId,
          path: `/home/uno/.uno-work/attachments/${attachmentId}.html`,
          title: cardTitle(card),
          height,
          source: "card",
          waitsForAnswer: card.kind !== "report" || (card.actions?.length ?? 0) > 0,
        },
        turnId: after.turnId,
        createdAt: new Date(Date.parse(after.createdAt) + 20_000).toISOString(),
      },
    ];
  });
}

/** The coordinator's reply to a card's answer. */
function replyToCard(text: string): string | null {
  if (text.startsWith("[from the card «Ship on Thursday?»]")) {
    return text.includes("Keep Friday")
      ? "Friday it is. Nothing changes for the helpers."
      : "Thursday it is. Told Release checks and Hero banners: copy freezes Wednesday 12:00.";
  }
  if (text.startsWith("[from the card «Pricing: where we stand»]")) {
    return text.includes("$12")
      ? "Going with $12. Pricing research updates the page; it goes live with Thursday's release."
      : "Keeping $9. I'll tell Pricing research to stop.";
  }
  return null;
}

/** Chains onto a variant's own replies. */
export function installPendingTrayReplies() {
  const previous = demoHooks.replyTo as ((text: string) => string | null) | undefined;
  demoHooks.replyTo = (text: string) => replyToCard(text) ?? previous?.(text) ?? null;
}

/**
 * The chats the demo daemon keeps "Waiting for you" for (the T52 ones).
 * `?tray=off`: a computer from before 0.0.192, which keeps no list (the
 * screenshots' "before").
 */
const tracked = (threadId: string) =>
  (threadId.startsWith("w-t52-") || threadId.startsWith("h-t52-")) &&
  new URLSearchParams(globalThis.location?.search ?? "").get("tray") !== "off";

/** What the person did there (`thread.pending-for-you.update`), as the daemon keeps it. */
export interface DemoPendingActions {
  dismissed: string[];
  opened: string[];
}

export function applyDemoPendingUpdate(
  thread: { id: string; pendingActions?: DemoPendingActions },
  command: { dismiss?: unknown; restore?: unknown; opened?: unknown },
) {
  if (!tracked(thread.id)) return;
  const list = (value: unknown) =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  const current = thread.pendingActions ?? { dismissed: [], opened: [] };
  const restore = new Set(list(command.restore));
  thread.pendingActions = {
    dismissed: [
      ...current.dismissed.filter((id) => !restore.has(id)),
      ...list(command.dismiss).filter((id) => !restore.has(id)),
    ],
    opened: [...current.opened, ...list(command.opened)],
  };
}

/** The shell's `pendingForYou` for a tracked chat, folded from its feed like the daemon does. */
export function demoPendingForYou(thread: {
  id: string;
  createdAt: string;
  messages: ReadonlyArray<{
    id: string;
    role: string;
    text: string;
    createdAt: string;
    streaming?: boolean;
    sentByThreadId?: string | null;
  }>;
  activities: ReadonlyArray<{ id: string; kind: string; payload: unknown; createdAt: string }>;
  pendingActions?: DemoPendingActions;
}): ThreadPendingForYou | undefined {
  if (!tracked(thread.id)) return undefined;
  const feed = pendingFeedOf({
    messages: thread.messages.map((message) => ({
      ...message,
      role: message.role as "user" | "assistant" | "system",
    })),
    pages: thread.activities.flatMap((activity) => {
      const page =
        activity.kind === "html.render" ? readHtmlRenderReference(activity.payload) : undefined;
      return page ? [{ activityId: activity.id, page, createdAt: activity.createdAt }] : [];
    }),
  });
  const actions = thread.pendingActions ?? { dismissed: [], opened: [] };
  return pendingForYouView(
    derivePendingForYouState("1970-01-01T00:00:00.000Z", feed, {
      dismissed: actions.dismissed,
      opened: actions.opened.map(normalizePendingLink),
    }),
  );
}
