/**
 * The desktop side of "Use this computer": a browser on app.uno4.work asked
 * the local daemon for access, the daemon told us over the owner WebSocket,
 * and a human has to say Allow or Deny here. Modelled on
 * SshPasswordPromptDialog: a queue, a countdown, one request at a time.
 *
 * Only mounted in the desktop shell (`isElectron`): the browser build has no
 * daemon of its own to approve for.
 */
import type { AuthLinkRequestPending } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { APP_BASE_NAME } from "../../branding";
import { decideServerLinkRequest } from "../../environments/primary";
import { getPrimaryEnvironmentConnection } from "../../environments/runtime";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

function formatRemainingSeconds(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function describeOrigin(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export function LinkRequestPromptDialog() {
  const [queue, setQueue] = useState<readonly AuthLinkRequestPending[]>([]);
  const [isResponding, setIsResponding] = useState(false);
  const [responseError, setResponseError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const current = queue[0] ?? null;

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = getPrimaryEnvironmentConnection().client.server.subscribeAuthLinkRequests(
      (event) => {
        if (cancelled) return;
        switch (event.type) {
          case "snapshot":
            setQueue(event.payload.pending);
            break;
          case "requested":
            setQueue((existing) => [
              ...existing.filter((item) => item.requestId !== event.payload.requestId),
              event.payload,
            ]);
            break;
          case "resolved":
            setQueue((existing) =>
              existing.filter((item) => item.requestId !== event.payload.requestId),
            );
            break;
        }
      },
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    setResponseError(null);
    if (!current) return;
    setNow(Date.now());
    // The person is looking at the browser that asked; bring the answer to them.
    void window.desktopBridge?.focusWindow().catch(() => undefined);
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [current]);

  const expiresAtMs = current ? Date.parse(String(current.expiresAt)) : Number.NaN;
  const remainingMs = Number.isFinite(expiresAtMs) ? Math.max(0, expiresAtMs - now) : null;
  const isExpired = remainingMs !== null && remainingMs <= 0;
  const remainingLabel =
    remainingMs === null ? null : formatRemainingSeconds(Math.ceil(remainingMs / 1_000));

  const dropCurrent = (requestId: string) => {
    setQueue((existing) => existing.filter((item) => item.requestId !== requestId));
    setResponseError(null);
  };

  const respond = async (decision: "allow" | "deny") => {
    if (!current || isResponding) return;
    const requestId = current.requestId;
    setIsResponding(true);
    setResponseError(null);
    try {
      await decideServerLinkRequest(requestId, decision);
      dropCurrent(requestId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not answer the request.";
      if (decision === "deny" || /already|Unknown link request/u.test(message)) {
        // Nothing to allow anymore either way; do not trap the user in the dialog.
        dropCurrent(requestId);
      } else {
        setResponseError(message);
      }
    } finally {
      setIsResponding(false);
    }
  };

  const origin = current ? describeOrigin(current.origin) : "";

  return (
    <Dialog
      open={current !== null}
      onOpenChange={(open) => {
        if (!open) void respond("deny");
      }}
    >
      <DialogPopup className="max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{origin} wants to use this computer</DialogTitle>
          <DialogDescription>
            The {APP_BASE_NAME} website open in {current?.label ?? "a browser"} is asking to run
            projects and agents on this computer through {APP_BASE_NAME}. Allow only if that is you.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-2" scrollFade={false}>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Allowing gives that browser the same access to this computer as this app.
            </p>
            {remainingLabel ? (
              <span
                className={
                  isExpired
                    ? "shrink-0 text-xs font-medium text-destructive"
                    : "shrink-0 text-xs text-muted-foreground"
                }
              >
                {isExpired ? "Expired" : remainingLabel}
              </span>
            ) : null}
          </div>
          {responseError ? <p className="text-sm text-destructive">{responseError}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            disabled={isResponding}
            type="button"
            variant="outline"
            onClick={() =>
              isExpired && current ? dropCurrent(current.requestId) : respond("deny")
            }
          >
            {isExpired ? "Dismiss" : "Deny"}
          </Button>
          <Button
            disabled={isResponding || isExpired}
            type="button"
            onClick={() => respond("allow")}
          >
            Allow
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
