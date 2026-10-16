// Point 4 of the w0138 mock: "Показать" puts the interface into the state to look at.
//
// The running chat "Landing copy" of the project landing: on the left of the
// panel's tab row the pins (Pult everywhere, README/pricing of the project),
// then the chat's own tabs (opened by the agent), and the "All tabs" menu
// open — with documents of the other landing chats under "In other chats".
import type { getRouter } from "../../router";
import { demoHooks, demoShow } from "../demoFlag";
import { ENV_MAC } from "../heavyFixtures";
import { SEEDED_CHATS } from "../seedTabs";

interface PaneHandle {
  readonly currentChatThreadId: string | null;
  readonly setOpen: (open: boolean) => void;
  readonly setPreviewLayoutMode: (mode: "sidebar" | "focus") => void;
  readonly setWidth: (width: number) => void;
}

const pane = () => demoHooks.previewPane as PaneHandle | undefined;

export async function waitFor(check: () => boolean, timeoutMs = 8000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return true;
}

/** Open a chat of "landing" with its panel shown. */
export async function openLandingChat(environmentId: string, threadId: string) {
  const router = demoHooks.router as ReturnType<typeof getRouter> | undefined;
  if (!router) return false;
  await router.navigate({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId } as never,
  });
  if (!(await waitFor(() => pane()?.currentChatThreadId === threadId))) return false;
  pane()?.setPreviewLayoutMode("sidebar");
  pane()?.setOpen(true);
  // Wide enough to see the pins, the divider and the chat's tabs side by side.
  pane()?.setWidth(Math.min(600, Math.round(window.innerWidth * 0.42)));
  await new Promise((resolve) => setTimeout(resolve, 250));
  // Once more after the chat has settled (its view may be written right after the switch).
  pane()?.setWidth(Math.min(600, Math.round(window.innerWidth * 0.42)));
  return true;
}

demoShow.p4 = async () => {
  if (!(await openLandingChat(ENV_MAC, SEEDED_CHATS.copy))) return;
  await new Promise((resolve) => setTimeout(resolve, 300));
  (demoHooks.openAllTabs as (() => void) | undefined)?.();
};
