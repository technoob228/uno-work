/**
 * One quiet line above the composer while the daemon has the chat marked as
 * holding a stranger's text (`lib/outsideTextApi.ts`): its Uno Work tools ask
 * first. "Trust this chat" asks once more, then lifts the mark. Only the
 * person can: the route takes their session, never an agent's token.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { memo, useState } from "react";

import { chatOutsideTextQueryKey, trustChatOutsideText } from "../../lib/outsideTextApi";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { outsideTextNoteLine, type OutsideTextSource } from "./OutsideTextNote.logic";

export const OutsideTextNote = memo(function OutsideTextNote(props: {
  environmentId: EnvironmentId;
  threadId: string;
  source: OutsideTextSource;
  /** T51: "Andrei's agent" — whose text it is, when a colleague's. */
  from?: string | null;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trust = async () => {
    setPending(true);
    setError(null);
    try {
      await trustChatOutsideText({ environmentId: props.environmentId, threadId: props.threadId });
      const key = chatOutsideTextQueryKey(props.environmentId, props.threadId);
      queryClient.setQueriesData({ queryKey: key }, { holdsOutsideText: false });
      await queryClient.invalidateQueries({ queryKey: key });
      setOpen(false);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message ? cause.message : "Couldn't save that. Try again.",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <p
        className="mx-auto mb-1.5 flex max-w-3xl flex-wrap items-center gap-x-1.5 px-3 text-xs text-muted-foreground"
        role="status"
        data-testid="outside-text-note"
      >
        <span>
          {props.from
            ? `This chat has text from ${props.from}. Uno Work tools ask you first.`
            : outsideTextNoteLine(props.source)}
        </span>
        <button
          type="button"
          className="underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
        >
          Trust this chat
        </button>
      </p>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!pending) setOpen(next);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Trust this chat?</AlertDialogTitle>
            <AlertDialogDescription>
              Only do this if you know who sent that text. Uno Work tools in this chat will stop
              asking you first and work as the chat's mode allows. If new text from outside comes
              in, they ask again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <p className="-mt-2 px-6 pb-5 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={pending} onClick={() => void trust()}>
              {pending ? <Spinner className="size-3.5" /> : null}
              Trust this chat
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
});
