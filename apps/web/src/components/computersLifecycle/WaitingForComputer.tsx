/**
 * A chat on one of the person's own computers (its project stands for a folder
 * there, `project.computer`; the chat itself runs on the cloud computer):
 *
 *   - its turn waits while the computer sleeps (`thread.computerWait`, set by
 *     the daemon) — "Waiting for MacBook…"; it goes on by itself when the
 *     computer is back, a message written meanwhile goes after (the outbox);
 *     after a while the chat offers "Continue in the cloud";
 *   - the computer is used as a tool for agents now, or was removed: the chat
 *     can't go on there — "Continue in the cloud" at once.
 *
 * An imported chat on a computer used as a tool offers the same
 * (ImportedChatNote). Continuing is `computers.continueInCloud`.
 */
import type {
  EnvironmentId,
  ProjectComputer,
  ThreadComputerWait,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CloudIcon, Loader2Icon, WrenchIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { waitForThreadInStore } from "../../assistant/useAssistantChat";

import { CONTINUE_OFFER_MS, useComputersLifecycleOn } from "../../computersLifecycle/flag";
import { ownComputerChatState } from "../../computersLifecycle/chatState";
import { errorText, useOwnComputers } from "../../computersLifecycle/useComputers";
import { ensureEnvironmentApi } from "../../environmentApi";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/** "Continue in the cloud": the project goes to the cloud computer, the chat follows it there. */
export function useContinueInCloud() {
  const navigate = useNavigate();
  const lifecycleOn = useComputersLifecycleOn();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (environmentId: EnvironmentId, threadId: ThreadId) => {
      setBusy(true);
      try {
        const target = await ensureEnvironmentApi(environmentId).computers.continueInCloud({
          threadId,
        });
        // The new chat reaches the store by its event, maybe after this answer:
        // opening it before then would land on Home.
        await waitForThreadInStore(environmentId, target.threadId as ThreadId, 5_000);
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: target.threadId },
        } as never);
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: errorText(cause, "Couldn’t move the chat. Try again."),
        });
      } finally {
        setBusy(false);
      }
    },
    [navigate],
  );
  return { run, busy, available: lifecycleOn };
}

export function useOwnComputerWaitingItem(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly computer: ProjectComputer | null | undefined;
  readonly wait: ThreadComputerWait | null | undefined;
}): ComposerBannerStackItem | null {
  const lifecycleOn = useComputersLifecycleOn();
  const { computers, settled, enabled } = useOwnComputers();
  const continueInCloud = useContinueInCloud();
  const state = lifecycleOn
    ? ownComputerChatState({
        computer: input.computer,
        wait: input.wait,
        // Not known (yet, or the console didn't answer): never say "removed" by mistake.
        own: settled && enabled ? computers : null,
      })
    : null;
  const sinceMs = state?.kind === "waiting" ? Date.parse(state.since) : null;
  const [now, setNow] = useState(() => Date.now());
  const offered =
    state !== null &&
    (state.kind !== "waiting" || (sinceMs !== null && now - sinceMs >= CONTINUE_OFFER_MS));
  useEffect(() => {
    if (sinceMs === null || offered) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [offered, sinceMs]);

  if (state === null || input.environmentId === null || input.threadId === null) return null;
  const { environmentId, threadId } = input;
  const action = offered
    ? {
        actions: (
          <Button
            size="xs"
            disabled={continueInCloud.busy}
            onClick={() => void continueInCloud.run(environmentId, threadId)}
            data-testid="lc-continue-cloud"
          >
            {continueInCloud.busy ? <Loader2Icon className="animate-spin" /> : <CloudIcon />}
            Continue in the cloud
          </Button>
        ),
      }
    : {};
  if (state.kind === "waiting") {
    return {
      id: `lc-waiting:${threadId}`,
      variant: "info",
      icon: <Loader2Icon className="animate-spin" />,
      title: <span data-testid="lc-waiting-banner">Waiting for {state.name}…</span>,
      description: offered
        ? `It goes on when ${state.name} wakes, or now in the cloud.`
        : "It goes on when it wakes. You can keep writing.",
      ...action,
    };
  }
  return {
    id: `lc-cant-go-on:${threadId}`,
    variant: "info",
    icon: <WrenchIcon />,
    title: (
      <span data-testid="lc-cant-go-on-banner">
        {state.kind === "tool"
          ? `${state.name} is a tool for your agents now`
          : `${state.name} was removed`}
      </span>
    ),
    description: "This chat can go on in the cloud.",
    ...action,
  };
}
