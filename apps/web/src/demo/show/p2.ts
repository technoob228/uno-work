// Point 2 of the w0138 mock: "Показать" puts the interface into the state to look at.
//
// The landing chat on this Mac, the test site's pricing page in the panel's
// own browser (a same-origin iframe in the demo — the comments and the
// console are real): Comment on with two pins, Debug open with the page's
// errors (an uncaught error, a warning, a missing image, /api/order → 500).
import type { getRouter } from "../../router";
import { usePageToolsStore } from "../../components/preview/annotate/pageToolsStore";
import type { PageComment } from "../../components/preview/annotate/pageTools.logic";
import { demoSiteUrl } from "../demoBrowser";
import { demoHooks, demoShow } from "../demoFlag";
import { ENV_MAC } from "../heavyFixtures";

const CHAT = "l-copy";

interface PaneHandle {
  readonly currentChatThreadId: string | null;
  readonly files: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly url?: string;
  }>;
  readonly openUrl: (url?: string) => void;
  readonly setOpen: (open: boolean) => void;
  readonly setWidth?: (width: number) => void;
  readonly setPreviewLayoutMode: (mode: "sidebar" | "focus") => void;
}

const pane = () => demoHooks.previewPane as PaneHandle | undefined;

async function waitFor(check: () => boolean, timeoutMs = 8000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return true;
}

const COMMENTS: PageComment[] = [
  {
    id: "demo-c1",
    n: 1,
    kind: "element",
    selector: "section.hero > p.lead",
    label: "p.lead",
    text: "Start free. Upgrade when your team does. Cancel any time.",
    note: "Say the trial is 14 days and needs no card",
    docRect: { x: 120, y: 190, w: 560, h: 26 },
  },
  {
    id: "demo-c2",
    n: 2,
    kind: "element",
    selector: "article.plan-card.featured > div.price",
    label: "div.price",
    text: "$23/month",
    note: "Show the monthly price crossed out next to it: $29 → $23",
    docRect: { x: 300, y: 380, w: 200, h: 46 },
  },
];

demoShow.p2 = async () => {
  const router = demoHooks.router as ReturnType<typeof getRouter> | undefined;
  if (!router) return;
  pane()?.setPreviewLayoutMode("sidebar");
  await router.navigate({
    to: "/$environmentId/$threadId",
    params: { environmentId: ENV_MAC, threadId: CHAT },
  });
  await waitFor(() => pane()?.currentChatThreadId === CHAT);
  const url = demoSiteUrl("pricing.html");
  pane()?.setOpen(true);
  pane()?.setWidth?.(Math.round(Math.min(860, window.innerWidth * 0.56)));
  pane()?.openUrl(url);
  await waitFor(
    () => pane()?.files.some((file) => file.kind === "browser" && file.url === url) ?? false,
  );
  const tab = pane()?.files.find((file) => file.kind === "browser" && file.url === url);
  if (!tab) return;
  usePageToolsStore.getState().patch(tab.id, {
    commenting: true,
    comments: COMMENTS,
    draft: null,
    debugOpen: true,
    debugTab: "console",
  });
  // The plans with both pins in view above the drawer.
  const frame = await waitFor(() => findFrame(url)?.contentDocument?.readyState === "complete");
  if (frame) findFrame(url)?.contentWindow?.scrollTo({ top: 150 });
};

function findFrame(url: string): HTMLIFrameElement | null {
  return (
    [...document.querySelectorAll<HTMLIFrameElement>("iframe")].find((frame) => frame.src === url) ??
    null
  );
}
