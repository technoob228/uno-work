// Point 3 of the w0138 mock: "Показать" puts the interface into the state to look at.
//
// The running release-train chat on uno-work, a document of it opened on the
// whole window: the dense "latest step + composer" block at the bottom. Then
// the chat folds into the mini window (or the column — the switch), the agent
// replies (a hint pops up and hides itself), and a bit later asks for an OK
// (the hint stays with Approve / Deny).
import type { getRouter } from "../../router";
import type { PreviewFile } from "../../components/preview/PreviewPaneContext";
import { demoAgentAsksApprovalIn, demoAgentRepliesIn, demoResetChatIn } from "../demoBoot";
import { demoHooks, demoShow } from "../demoFlag";
import { ENV_WORK } from "../heavyFixtures";

const CHAT = "c-train";

interface PaneHandle {
  readonly currentChatThreadId: string | null;
  readonly previewLayoutMode: "sidebar" | "focus";
  readonly openFile: (file: PreviewFile) => void;
  readonly setPreviewLayoutMode: (mode: "sidebar" | "focus") => void;
}

const PLAN_MD = `# Train 10.10 — Clean exit IP to prod

**Goal:** paid accounts get a clean exit IP; the console has a switch; docs are live.

| Task | Where | Status |
| --- | --- | --- |
| L4 — exit IP for paid accounts | fishcode · uno-work | tests 31/44 |
| L5 — switch in the console | uno-console · uno-product | waits for Misha |
| Knowledge page | uno-project · MacBook | done |
| go test -race | fishcode · MacBook | stopped (Mac asleep) |

## Order

1. L4 green → merge into \`train/1010\`
2. L5: price on the switch — Misha decides
3. Stage smoke (41 steps), then prod at 22:00 UTC

## Rollback

\`./scripts/release.sh rollback train/1010\` — one command, ~2 min.
`;

const timers: number[] = [];
function later(ms: number, fn: () => void) {
  timers.push(window.setTimeout(fn, ms));
}

async function waitFor(check: () => boolean, timeoutMs = 8000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return true;
}

const pane = () => demoHooks.previewPane as PaneHandle | undefined;

demoShow.p3 = async () => {
  for (const timer of timers.splice(0)) window.clearTimeout(timer);
  const router = demoHooks.router as ReturnType<typeof getRouter> | undefined;
  if (!router) return;
  pane()?.setPreviewLayoutMode("sidebar");
  // Pressed again: the chat starts over (running, no demo replies yet).
  demoResetChatIn(ENV_WORK, CHAT);
  await router.navigate({
    to: "/$environmentId/$threadId",
    params: { environmentId: ENV_WORK, threadId: CHAT },
  });
  await waitFor(() => pane()?.currentChatThreadId === CHAT);
  pane()?.openFile({
    id: "demo-p3-train-plan",
    name: "train-1010-plan.md",
    kind: "md",
    content: PLAN_MD,
    path: "/home/uno/projects/uno-project/reports/train-1010-plan.md",
    environmentId: ENV_WORK,
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  pane()?.setPreviewLayoutMode("focus");
  await waitFor(() => document.querySelector("[data-chat-dock-minimize]") !== null);

  // A moment to see the dense block, then the chat folds away…
  later(2500, () => {
    document.querySelector<HTMLButtonElement>("[data-chat-dock-minimize]")?.click();
  });
  // …the agent replies (hint, hides itself after ~6 s)…
  later(5000, () =>
    demoAgentRepliesIn(
      ENV_WORK,
      CHAT,
      "L4 is green: 44/44 tests passed. Merged into train/1010 — stage rebuilds in ~3 min.",
    ),
  );
  // …and then waits for an OK (the hint stays until Approve / Deny).
  later(14_000, () =>
    demoAgentAsksApprovalIn(
      ENV_WORK,
      CHAT,
      "./scripts/release.sh promote train/1010 --to prod --canary 2534 --wait-healthy 120s --notify coordinator",
      "Release train/1010 to everyone? Rollback is one command.",
    ),
  );
};
