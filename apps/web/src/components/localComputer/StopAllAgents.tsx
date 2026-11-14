/**
 * "Stop all agents on my computer": one call that stops every agent call on
 * the person's computers, disconnects them and pauses agents until Resume.
 * Always confirmed first. Reached from Settings → My computer, the computer's
 * menu, the manage card and the Inbox's banner; each shows the same toast.
 */
import { OctagonXIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { myComputerErrorText, useMyComputerTrustActions } from "../../localComputer/useMyComputers";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { stopAllToast } from "./myComputerTrust.logic";

export const STOP_ALL_TITLE = "Stop all agents on your computer?";

/** What the confirmation says will happen. */
export const STOP_ALL_LINES: ReadonlyArray<string> = [
  "Everything agents run there stops now.",
  "Your computer disconnects from Uno.",
  "Agents can’t reach it until you resume them in Settings → My computer.",
];

/** Runs Stop all and shows its toast. `run` answers whether it went through. */
export function useStopAllAgents() {
  const environmentId = usePrimaryEnvironmentId();
  const { stopAll } = useMyComputerTrustActions(environmentId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      toastManager.add(stopAllToast(await stopAll()));
      return true;
    } catch (cause) {
      setError(myComputerErrorText(cause));
      return false;
    } finally {
      setPending(false);
    }
  }, [stopAll]);
  const reset = useCallback(() => setError(null), []);
  return { run, pending, error, reset };
}

export function StopAllLines() {
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
      {STOP_ALL_LINES.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

export function StopAllAgentsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { run, pending, error, reset } = useStopAllAgents();
  const close = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogPopup className="max-w-md" data-testid="stop-all-dialog">
        <DialogHeader>
          <DialogTitle className="text-lg">{STOP_ALL_TITLE}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          <StopAllLines />
          {error !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => void run().then((done) => done && close(false))}
            data-testid="stop-all-confirm"
          >
            <OctagonXIcon />
            {pending ? "Stopping…" : "Stop all agents"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
