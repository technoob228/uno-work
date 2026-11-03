/**
 * A full computer's chat while that computer sleeps (SPEC "Полноценный режим"):
 * the turn waits — "Waiting for MacBook…" — and goes on by itself when it
 * wakes; a message written meanwhile goes out after (the outbox). After a
 * while the chat offers "Continue in the cloud". An imported chat on a
 * computer used as a tool offers the same at once.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CloudIcon, Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { lifecycleBackend } from "../../computersLifecycle/backend";
import { COMPUTERS_LIFECYCLE, CONTINUE_OFFER_MS } from "../../computersLifecycle/flag";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { useSidebarDComputers } from "../sidebar/SidebarDComputers";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/** "Continue in the cloud": the project goes to the cloud computer, the chat follows it there. */
export function useContinueInCloud() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (environmentId: EnvironmentId, threadId: string) => {
      setBusy(true);
      try {
        const target = await lifecycleBackend.continueInCloud(environmentId, threadId);
        if (target === null) return;
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: target.environmentId, threadId: target.threadId },
        } as never);
      } catch {
        toastManager.add({ type: "error", title: "Couldn’t move the chat. Try again." });
      } finally {
        setBusy(false);
      }
    },
    [navigate],
  );
  return { run, busy, available: COMPUTERS_LIFECYCLE && lifecycleBackend.canContinueInCloud() };
}

export function useOwnComputerWaitingItem(input: {
  readonly unavailable: { readonly environmentId: string; readonly label: string } | null;
  readonly threadId: string | null;
  readonly visible: boolean;
}): ComposerBannerStackItem | null {
  const computers = useSidebarDComputers();
  const environmentId = input.unavailable?.environmentId ?? null;
  const own =
    COMPUTERS_LIFECYCLE &&
    environmentId !== null &&
    computers.some((computer) => computer.environmentId === environmentId && !computer.cloud);
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const continueInCloud = useContinueInCloud();

  useEffect(() => {
    if (!own) {
      setSince(null);
      return;
    }
    setSince((current) => current ?? Date.now());
    if (environmentId !== null && input.threadId !== null) {
      lifecycleBackend.waiting(environmentId, input.threadId);
    }
  }, [environmentId, input.threadId, own]);

  const offered = since !== null && now - since >= CONTINUE_OFFER_MS;
  useEffect(() => {
    if (since === null || offered) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [offered, since]);

  if (!own || !input.unavailable || !input.visible) return null;
  const label = input.unavailable.label;
  const offer = offered && continueInCloud.available && input.threadId !== null;
  return {
    id: `lc-waiting:${environmentId}`,
    variant: "info",
    icon: <Loader2Icon className="animate-spin" />,
    title: <span data-testid="lc-waiting-banner">Waiting for {label}…</span>,
    description: offer
      ? `It goes on when ${label} wakes, or now in the cloud.`
      : "It goes on when it wakes. You can keep writing.",
    ...(offer
      ? {
          actions: (
            <Button
              size="xs"
              disabled={continueInCloud.busy}
              onClick={() =>
                void continueInCloud.run(environmentId as EnvironmentId, input.threadId!)
              }
              data-testid="lc-continue-cloud"
            >
              <CloudIcon />
              Continue in the cloud
            </Button>
          ),
        }
      : {}),
  };
}
