/**
 * "The agent needs you in its browser" — a card above the composer while the
 * chat's agent waits on the person in the computer's browser
 * (`browser_command` `requestHelp`: a sign-in, a captcha, a 2FA code). Before
 * 0.0.139 the call reached the person only through the Inbox, the messenger
 * and an amber strip on the browser tab itself — easy to miss when the panel
 * is closed or shows something else. One button opens that tab and takes
 * control; "Hand back" is on the tab as before.
 *
 * Behind Labs "Panel launcher: two browsers and Apps" (Misha 16.10: the
 * agent's browser is where you sign in for the agent).
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { HandIcon } from "lucide-react";
import { memo, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { pageAskingForHelp } from "./browserHelp.logic";
import { useBrowserLiveState } from "./browserLiveStore";
import { makeLiveBrowserFile, usePreviewPane } from "./PreviewPaneContext";

/** The agent's words as a sentence: "Sign in to x.com" → "Sign in to x.com." */
function sentence(text: string): string {
  const trimmed = text.trim();
  return trimmed && !/[.!?…]$/.test(trimmed) ? `${trimmed}.` : trimmed;
}

export const BrowserHelpCard = memo(function BrowserHelpCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
}) {
  const state = useBrowserLiveState(props.environmentId);
  const { openFileForTarget, currentProjectKey, setOpen } = usePreviewPane();
  const [busy, setBusy] = useState(false);
  const page = pageAskingForHelp(state?.pages ?? [], props.threadId);
  if (!page || !page.help) return null;
  const human = page.control === "human";

  const showTab = () => {
    openFileForTarget(
      { projectKey: currentProjectKey, threadId: props.threadId },
      "chat",
      makeLiveBrowserFile({
        environmentId: props.environmentId,
        page,
        projectKey: currentProjectKey,
      }),
    );
    setOpen(true);
  };
  const takeControl = async () => {
    showTab();
    if (human) return;
    const api = readEnvironmentApi(props.environmentId);
    if (!api) return;
    setBusy(true);
    try {
      await api.browserLive.setControl({ pageId: page.pageId, control: "human" });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't take control",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="mb-2 flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/[0.06] px-3.5 py-3 sm:px-4"
      data-testid="browser-help-card"
      role="status"
    >
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background">
        <HandIcon className="size-4 text-amber-600 dark:text-amber-400" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">The agent needs you in its browser</div>
        <div className="text-xs text-muted-foreground">
          {sentence(page.help.reason) ||
            "Sign in, pass a check or make a choice only you can make."}{" "}
          {human
            ? "You're in control — hand the browser back on its tab when you're done."
            : "It waits until you hand the browser back."}
        </div>
      </div>
      <Button
        size="sm"
        className="shrink-0"
        disabled={busy}
        onClick={() => void takeControl()}
        data-testid="browser-help-take-control"
      >
        {human ? "Open the browser" : "Take control"}
      </Button>
    </div>
  );
});
