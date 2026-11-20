/**
 * Chat requests from the cloud in the demo (chatRequests/): the MacBook's
 * Uno Work answers `chatRequests.*` — two requests from chats on uno-work
 * wait, three decided ones fill the journal; Start opens a real demo chat on
 * the MacBook with the brief, Decline declines, the switch toggles. Only in
 * the demo build; nothing leaves the page.
 *
 * `window.__chatRequestsDemo.hold()` takes the waiting ones away and
 * `.arrive()` brings them back one by one (a request coming in, for the
 * walkthrough); `.fresh()` is the first open after the update: switched off
 * (the default) and nothing asked yet.
 */
import { WS_METHODS } from "@t3tools/contracts";

import { demoHooks } from "./demoFlag";

type Status = "waiting" | "started" | "declined" | "expired" | "refused";

interface DemoRequest {
  id: string;
  status: Status;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  from: { computerName: string; boxId: number | null; threadId: string; threadTitle: string };
  cwd: string | null;
  provider: string | null;
  title: string;
  gist: string;
  brief: string;
  reason: string | null;
  decidedVia?: "here" | "telegram";
  threadId: string | null;
  threadState: string | null;
}

export interface ChatRequestsDemoHooks {
  /** Start: a chat on the MacBook with the brief as its first message; its id. */
  startChat(input: { title: string; cwd: string | null; brief: string }): string;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const UNO_WORK = { computerName: "uno-work", boxId: 395 };

const BAKERY_BRIEF = `The order form of the bakery's landing page is ready on uno-work. Misha wants it checked in Safari on his Mac before it goes live, and that can only be done there.

What to do:
1. In ~/projects/landing, check out the branch order-form (it is already on GitHub) and run npm install.
2. Start the site with npm run dev and open http://localhost:5173 in Safari.
3. Place a test order: two sourdough loaves, pickup on Saturday, name "Test order".
4. Check that the date picker opens in Safari, that the total changes when the number of loaves changes, and that the thank-you message shows after sending.

Please don't change the code. If something breaks in Safari, write down what you saw and what the browser console says, and end with a short list of what works and what doesn't. I'll fix it on uno-work.`;

const SALES_BRIEF = `Misha keeps the shop's orders in a Numbers file on his Mac: ~/Documents/Orders 2026.numbers. The weekly sales report on uno-work needs last week's orders.

What to do:
1. Open the file in Numbers and find the sheet for November 10–16.
2. Export only that sheet as CSV into ~/Documents/exports/orders-week-46.csv.
3. Say how many rows there are and the total of the Amount column.

Don't edit the Numbers file itself. If the sheet for that week isn't there, say which sheets you see and stop.`;

const requests: DemoRequest[] = [
  {
    id: "cr-bakery",
    status: "waiting",
    createdAt: at(-4 * MIN),
    expiresAt: at(2 * HOUR - 4 * MIN),
    decidedAt: null,
    from: { ...UNO_WORK, threadId: "w-bakery", threadTitle: "Landing page for the bakery" },
    cwd: "~/projects/landing",
    provider: "claudeAgent",
    title: "Check the order form in Safari",
    gist: "Run the site locally and check the order form in Safari",
    brief: BAKERY_BRIEF,
    reason: null,
    threadId: null,
    threadState: null,
  },
  {
    id: "cr-sales",
    status: "waiting",
    createdAt: at(-1 * MIN),
    expiresAt: at(2 * HOUR - 1 * MIN),
    decidedAt: null,
    from: { ...UNO_WORK, threadId: "w-sales", threadTitle: "Weekly sales report" },
    cwd: null,
    provider: "claudeAgent",
    title: "Export last week's orders",
    gist: "Export last week's orders from the Numbers file on this Mac as CSV",
    brief: SALES_BRIEF,
    reason: null,
    threadId: null,
    threadState: null,
  },
  {
    id: "cr-deck",
    status: "started",
    createdAt: at(-26 * HOUR),
    expiresAt: at(-24 * HOUR),
    decidedAt: at(-26 * HOUR + 3 * MIN),
    from: { ...UNO_WORK, threadId: "w-deck", threadTitle: "Pitch deck numbers" },
    cwd: "~/projects/pitch-deck",
    provider: "claudeAgent",
    title: "Slide 7: update the numbers",
    gist: "Update slide 7 in Keynote with October revenue",
    brief: "Update slide 7 of the pitch deck with October revenue and export it as PDF.",
    reason: null,
    threadId: "m-deck",
    threadState: "done",
    decidedVia: "telegram",
  },
  {
    id: "cr-downloads",
    status: "declined",
    createdAt: at(-30 * HOUR),
    expiresAt: at(-28 * HOUR),
    decidedAt: at(-30 * HOUR + 6 * MIN),
    from: { ...UNO_WORK, threadId: "w-tidy", threadTitle: "Tidy up the computers" },
    cwd: "~/Downloads",
    provider: "claudeAgent",
    title: "Clean up Downloads",
    gist: "Delete files in Downloads older than a year",
    brief: "Delete the files in ~/Downloads that are older than a year.",
    reason: "Misha declined it.",
    threadId: null,
    threadState: null,
  },
  {
    id: "cr-print",
    status: "expired",
    createdAt: at(-50 * HOUR),
    expiresAt: at(-48 * HOUR),
    decidedAt: at(-48 * HOUR),
    from: { ...UNO_WORK, threadId: "w-sales", threadTitle: "Weekly sales report" },
    cwd: null,
    provider: "claudeAgent",
    title: "Print the report",
    gist: "Print the weekly report on the office printer",
    brief: "Print the weekly report on the office printer.",
    reason: "No one answered in 2 hours.",
    threadId: null,
    threadState: null,
  },
];

let allow = true;
/** Waiting requests taken away by `hold()`, to arrive again. */
const held: DemoRequest[] = [];

function snapshot() {
  const active =
    requests.filter((q) => q.status === "waiting").length +
    requests.filter((q) => q.status === "started" && q.threadState === "running").length;
  return {
    allow,
    limit: 2,
    active,
    requests: requests
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((q) => ({ ...q, from: { ...q.from } })),
  };
}

export function installChatRequestsDemo(environmentId: string): void {
  demoHooks.chatRequestsHost = environmentId;
  (window as unknown as Record<string, unknown>).__chatRequestsDemo = {
    hold() {
      for (let i = requests.length - 1; i >= 0; i -= 1) {
        if (requests[i]!.status === "waiting") held.unshift(...requests.splice(i, 1));
      }
    },
    fresh() {
      allow = false;
      requests.length = 0;
      held.length = 0;
    },
    arrive() {
      const next = held.shift();
      if (!next) return false;
      next.createdAt = at(0);
      next.expiresAt = at(2 * HOUR);
      requests.push(next);
      return true;
    },
  };
}

/** The MacBook's `chatRequests.*`; undefined for anything else. */
export function answerChatRequestsRpc(
  tag: string,
  body: Record<string, unknown>,
  hooks: ChatRequestsDemoHooks,
): unknown {
  switch (tag) {
    case WS_METHODS.chatRequestsState:
      return snapshot();
    case WS_METHODS.chatRequestsSetAllowed:
      allow = body.allow === true;
      return snapshot();
    case WS_METHODS.chatRequestsDecide: {
      const request = requests.find((q) => q.id === body.id && q.status === "waiting");
      if (!request) return { state: snapshot(), threadId: null };
      request.decidedAt = at(0);
      if (body.decision === "start") {
        request.status = "started";
        request.threadId = hooks.startChat({
          title: request.title,
          cwd: request.cwd,
          brief: request.brief,
        });
        request.threadState = "running";
        return { state: snapshot(), threadId: request.threadId };
      }
      request.status = "declined";
      request.reason = "Misha declined it.";
      return { state: snapshot(), threadId: null };
    }
    default:
      return undefined;
  }
}
