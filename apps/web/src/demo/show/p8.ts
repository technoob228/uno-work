// Point 8 of the w0138 mock: "Показать" puts the interface into the state to look at.
//
// A file open in the panel and its ↗: on the desktop app (the MacBook) the
// menu "Open in Cursor / Share with a link…" (Share uploads a copy to Cloud
// storage first); with the switch on "Cloud computer" — a chat on
// uno-product, where ↗ is Share and opens the link dialog of the computer.
import { demoHooks, demoShow, demoSwitch } from "../demoFlag";
import { ENV_MAC, ENV_PRODUCT } from "../heavyFixtures";
import { SEEDED_CHATS } from "../seedTabs";
import { openLandingChat, waitFor } from "./p4";

interface PaneHandle {
  readonly setActiveFile: (id: string) => void;
}

demoShow.p8 = async () => {
  const desktop = demoSwitch("platform") === "desktop";
  const ok = desktop
    ? await openLandingChat(ENV_MAC, SEEDED_CHATS.copy)
    : await openLandingChat(ENV_PRODUCT, SEEDED_CHATS.pricing);
  if (!ok) return;
  const fileId = desktop
    ? "/Users/misha/projects/landing/pricing.md"
    : "/home/uno/projects/landing/competitors.md";
  (demoHooks.previewPane as PaneHandle | undefined)?.setActiveFile(fileId);
  const selector = desktop ? "[data-testid=preview-open-share]" : "[data-testid=preview-share]";
  if (!(await waitFor(() => document.querySelector(selector) !== null))) return;
  await new Promise((resolve) => setTimeout(resolve, 400));
  document.querySelector<HTMLButtonElement>(selector)?.click();
};
