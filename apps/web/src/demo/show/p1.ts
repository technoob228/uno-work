// Point 1 of the w0138 mock: "Показать" puts the interface into the state to look at.
//
// The landing chat on uno-product, the panel open and empty: the launcher —
// Browser (this Mac, Comment and Debug) and Agent's browser (uno-product,
// marked "default" there), Files, Changes, Apps (always; the list has apps of
// every computer and the sites).
import type { getRouter } from "../../router";
import { demoHooks, demoShow } from "../demoFlag";
import { ENV_PRODUCT } from "../heavyFixtures";

const CHAT = "s-pricing";

interface PaneHandle {
  readonly currentChatThreadId: string | null;
  readonly files: ReadonlyArray<unknown>;
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

demoShow.p1 = async () => {
  const router = demoHooks.router as ReturnType<typeof getRouter> | undefined;
  if (!router) return;
  pane()?.setPreviewLayoutMode("sidebar");
  await router.navigate({
    to: "/$environmentId/$threadId",
    params: { environmentId: ENV_PRODUCT, threadId: CHAT },
  });
  await waitFor(() => pane()?.currentChatThreadId === CHAT);
  pane()?.setOpen(true);
  pane()?.setWidth?.(Math.round(Math.min(600, window.innerWidth * 0.42)));
  await new Promise((resolve) => setTimeout(resolve, 200));
  // Tabs already open in this chat: "+" shows the launcher over them.
  if ((pane()?.files.length ?? 0) > 0) {
    document.querySelector<HTMLButtonElement>('[data-testid="panel-launcher-open"]')?.click();
  }
};
