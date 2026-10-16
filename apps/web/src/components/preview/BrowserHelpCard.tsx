/**
 * "The agent needs you to sign in to github.com" (w0138, Misha 16.10): the
 * agent hit a sign-in, a captcha or a 2FA code in the browser on its
 * computer and called the person. The same card sits above the chat's
 * composer and on top of the agent's browser tab:
 *
 *   - "Sign in for the agent" — takes control of that browser and opens its
 *     tab beside the chat; the person types the login, password and code
 *     right in the live picture;
 *   - "Done — hand back" — the agent goes on with the session it now has.
 *
 * Nothing here sees the password: the keys go straight to the page on the
 * computer, and the session (cookies) stays in that browser — said in one
 * honest line on the card.
 *
 * The page comes from the computer's own `requestHelp` (`page.help`), so the
 * card shows for a real agent too, not only in the mock. Before 0.0.139 that
 * call reached the person only through the Inbox, the messenger and an amber
 * strip on the browser tab — easy to miss with the panel closed. Behind Labs
 * "Panel launcher: two browsers and Apps" (`panelLauncherV2`); without it the
 * tab keeps the strip of 0.0.137 (`LiveBrowserView`).
 */
import type { BrowserLivePage, EnvironmentId } from "@t3tools/contracts";
import { HandIcon, LockIcon, UndoIcon } from "lucide-react";
import { useCallback } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { useFeatureFlag } from "../../hooks/useFeatureFlags";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { browserHelpCopy, pageAskingForHelp, SESSION_STAYS_LINE } from "./browserHelp.logic";
import { useBrowserLiveState } from "./browserLiveStore";
import { makeLiveBrowserFile, usePreviewPane } from "./PreviewPaneContext";

function useSetControl(environmentId: EnvironmentId, pageId: string) {
  return useCallback(
    async (control: "agent" | "human") => {
      try {
        await readEnvironmentApi(environmentId)?.browserLive.setControl({ pageId, control });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Couldn't switch control",
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [environmentId, pageId],
  );
}

/**
 * The card. `where="chat"` also opens the agent's browser beside the chat on
 * "Sign in for the agent"; on the browser tab itself it is already open.
 */
export function BrowserHelpCard({
  environmentId,
  page,
  where,
}: {
  environmentId: EnvironmentId;
  page: BrowserLivePage;
  where: "chat" | "panel";
}) {
  const { openFileForTarget, currentProjectKey, currentChatThreadId, setOpen } = usePreviewPane();
  const setControl = useSetControl(environmentId, page.pageId);
  if (!page.help) return null;
  const copy = browserHelpCopy({ reason: page.help.reason, url: page.url });
  const human = page.control === "human";

  const takeOver = () => {
    if (where === "chat") {
      openFileForTarget(
        {
          projectKey: currentProjectKey,
          threadId: page.context?.threadId ?? currentChatThreadId,
        },
        "chat",
        makeLiveBrowserFile({ environmentId, page, projectKey: currentProjectKey }),
      );
      setOpen(true);
    }
    void setControl("human");
  };

  return (
    <div
      className={cn(
        "flex items-start gap-2.5 text-sm",
        where === "chat"
          ? "mb-2 rounded-2xl border border-amber-500/30 bg-amber-500/[0.06] px-3.5 py-3"
          : "border-b border-amber-500/30 bg-amber-500/[0.06] px-3 py-2.5",
      )}
      data-testid={`browser-help-card-${where}`}
    >
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background">
        {copy.kind === "signIn" ? (
          <LockIcon className="size-3.5 text-muted-foreground" />
        ) : (
          <HandIcon className="size-3.5 text-muted-foreground" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-medium leading-snug">{human ? copy.activeTitle : copy.title}</div>
        <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
          {human
            ? copy.activeHint
            : copy.kind === "other"
              ? page.help.reason
              : "It waits in its browser until you're done."}
        </p>
        {copy.kind === "signIn" ? (
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
            {SESSION_STAYS_LINE}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {human ? (
            <Button
              size="xs"
              onClick={() => void setControl("agent")}
              data-testid="browser-help-done"
            >
              <UndoIcon />
              Done — hand back
            </Button>
          ) : (
            <Button size="xs" onClick={takeOver} data-testid="browser-help-take">
              {copy.action}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Above the composer: the card of this chat's page on its computer, if the
 * agent asked (Labs `panelLauncherV2`).
 */
export function ComposerBrowserHelpPanel({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: string | undefined;
}) {
  const enabled = useFeatureFlag("panelLauncherV2");
  const state = useBrowserLiveState(environmentId);
  const page = enabled && threadId && state ? pageAskingForHelp(state.pages, threadId) : null;
  if (!page) return null;
  return <BrowserHelpCard environmentId={environmentId} page={page} where="chat" />;
}
