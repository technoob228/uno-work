/**
 * The Fix Work button's dialog: one question, what the agent will and won't do,
 * then a new chat on the computer in front of the person.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import { useState } from "react";

import { useHomeLaunchers } from "../components/computer/useHomeLaunchers";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Textarea } from "../components/ui/textarea";
import { useActiveMachine } from "../hooks/useActiveMachine";
import { FIX_WORK_COPY as COPY, FIX_WORK_RUNTIME_MODE, fixWorkPrompt, prepareFixWork } from "./fixWork";

function FixWorkForm(props: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const { startTask } = useHomeLaunchers(props.environmentId);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const playbookPath = await prepareFixWork(props.environmentId);
      props.onClose();
      await startTask(fixWorkPrompt(problem, playbookPath), {
        environmentId: props.environmentId,
        folder: null,
        modelSelection: null,
        runtimeMode: FIX_WORK_RUNTIME_MODE,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : COPY.failed);
      setBusy(false);
    }
  };
  return (
    <>
      <DialogPanel className="space-y-3">
        <Textarea
          autoFocus
          aria-label="What went wrong"
          placeholder={COPY.placeholder}
          value={problem}
          onChange={(event) => setProblem(event.target.value)}
          className="min-h-24"
        />
        <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
          {COPY.promises.map((line) => (
            <li key={line} className="flex items-start gap-2">
              <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-success" />
              {line}
            </li>
          ))}
        </ul>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={props.onClose}>
          {COPY.cancel}
        </Button>
        <Button data-testid="fix-work-start" disabled={busy} onClick={() => void start()}>
          {busy ? COPY.starting : COPY.start}
        </Button>
      </DialogFooter>
    </>
  );
}

export function FixWorkDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { environmentId } = useActiveMachine();
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md" data-testid="fix-work-dialog">
        <DialogHeader>
          <DialogTitle>{COPY.title}</DialogTitle>
          <DialogDescription>{COPY.description}</DialogDescription>
        </DialogHeader>
        {environmentId ? (
          <FixWorkForm environmentId={environmentId} onClose={() => props.onOpenChange(false)} />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
