// Point 2b of the w0138 mock: "Показать" puts the interface into the state to look at.
//
// The landing chat on uno-product: the person asks to open a pull request, the
// agent goes to github.com in the browser on its computer and meets the
// sign-in. It asks for help — the card "The agent needs you to sign in to
// github.com" shows above the composer and on the agent's browser tab, which
// opens beside the chat. From here Misha clicks himself: "Sign in for the
// agent" → types a login, any password and a 6-digit code right in the live
// picture → "Done — hand back" → the agent says it's signed in and goes on.
import type { getRouter } from "../../router";
import { demoAgentRepliesIn, demoAgentWorksIn, demoResetChatIn } from "../demoBoot";
import { demoAgentNeedsSignIn, demoSignIn, demoSignInReset } from "../demoBrowser";
import { demoHooks, demoShow } from "../demoFlag";
import { ENV_PRODUCT } from "../heavyFixtures";

const CHAT = "s-pricing";

interface PaneHandle {
  readonly currentChatThreadId: string | null;
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

demoShow.p2b = async () => {
  const router = demoHooks.router as ReturnType<typeof getRouter> | undefined;
  if (!router) return;
  pane()?.setPreviewLayoutMode("sidebar");
  await router.navigate({
    to: "/$environmentId/$threadId",
    params: { environmentId: ENV_PRODUCT, threadId: CHAT },
  });
  await waitFor(() => pane()?.currentChatThreadId === CHAT);
  // Press it again — the scene starts over.
  demoSignInReset(ENV_PRODUCT, CHAT);
  demoResetChatIn(ENV_PRODUCT, CHAT);
  pane()?.setOpen(true);
  pane()?.setWidth?.(Math.round(Math.min(620, window.innerWidth * 0.44)));
  await sleep(300);
  demoAgentWorksIn(
    ENV_PRODUCT,
    CHAT,
    "Open a pull request with the new pricing on GitHub.",
    "Pushed the `pricing-by-jobs` branch. Opening github.com to make the pull request — GitHub wants me to sign in, and I don't have your account. I'll wait in my browser.",
  );
  demoSignIn.onSignedIn = (login) =>
    demoAgentRepliesIn(
      ENV_PRODUCT,
      CHAT,
      `Signed in as **${login}** on github.com — continuing.\n\nOpened pull request **#42 “Pricing by jobs”**. The session stays in my browser on uno-product, so next time I won't need to ask.`,
    );
  await sleep(1200);
  demoAgentNeedsSignIn(ENV_PRODUCT, CHAT);
};
