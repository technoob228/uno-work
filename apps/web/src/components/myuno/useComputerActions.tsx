/**
 * What My Uno can do to a computer on the account, shared by its row, the
 * side panel and "Worth a look": wake it (or start a stopped one), put it to
 * sleep (an Uno Work computer asks first — it may be the one this window
 * works on), and change what it is for. Each computer tracks its own pending
 * call, so waking one doesn't grey out the others.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { type AccountComputer, setComputerRole } from "../../account/accountOverview";
import { ROLE_LABEL, type ComputerRole } from "../../account/computerRoles";
import { accountRequest } from "../../account/unoAccount";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { bringBackAction } from "./myUnoModel";
import { refreshMyUno } from "./myUnoQueries";

export type PowerVerb = "wake" | "start" | "sleep";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useComputerActions() {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<ReadonlyMap<number, PowerVerb | "role">>(new Map());
  const [asking, setAsking] = useState<{ box: AccountComputer; here: boolean } | null>(null);

  const mark = useCallback((id: number, verb: PowerVerb | "role" | null) => {
    setPending((current) => {
      const next = new Map(current);
      if (verb) next.set(id, verb);
      else next.delete(id);
      return next;
    });
  }, []);

  const power = useMutation({
    mutationFn: ({ box, verb }: { box: AccountComputer; verb: PowerVerb }) =>
      accountRequest("POST", `/api/v1/boxes/${box.id}/${verb}`, {}),
    onMutate: ({ box, verb }) => mark(box.id, verb),
    onSettled: (_data, _error, { box }) => {
      mark(box.id, null);
      refreshMyUno(queryClient);
    },
    onError: (error, { box }) =>
      toastManager.add({
        type: "error",
        title: `Couldn't change ${box.name}`,
        description: message(error),
      }),
  });

  const role = useMutation({
    mutationFn: ({ box, next }: { box: AccountComputer; next: ComputerRole }) =>
      setComputerRole(box, next),
    onMutate: ({ box }) => mark(box.id, "role"),
    onSuccess: (_data, { box, next }) =>
      toastManager.add({ type: "success", title: `${box.name} is now ${ROLE_LABEL[next]}` }),
    onSettled: (_data, _error, { box }) => {
      mark(box.id, null);
      refreshMyUno(queryClient);
    },
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Couldn't change the role",
        description: message(error),
      }),
  });

  /** Wake a sleeping computer, start a stopped one. */
  const bringBack = useCallback(
    (box: AccountComputer) => {
      const verb = bringBackAction(box.status);
      if (verb) power.mutate({ box, verb });
    },
    [power],
  );

  /** An Uno Work computer asks first; a server just goes to sleep. */
  const sleep = useCallback(
    (box: AccountComputer, here: boolean) => {
      if (box.workMachine) setAsking({ box, here });
      else power.mutate({ box, verb: "sleep" });
    },
    [power],
  );

  const setRole = useCallback(
    (box: AccountComputer, next: ComputerRole) => {
      if (next !== box.role) role.mutate({ box, next });
    },
    [role],
  );

  const confirmSleep = (
    <AlertDialog open={asking !== null} onOpenChange={(open) => (open ? null : setAsking(null))}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Put {asking?.box.name} to sleep?</AlertDialogTitle>
          <AlertDialogDescription>
            {asking?.here
              ? "It's the computer this window works on. Chats and apps on it stop until you wake it; nothing is lost."
              : "Chats and apps on it stop until you wake it; nothing is lost."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button
            onClick={() => {
              if (asking) power.mutate({ box: asking.box, verb: "sleep" });
              setAsking(null);
            }}
          >
            Put to sleep
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );

  return {
    bringBack,
    sleep,
    setRole,
    pending: (id: number) => pending.get(id) ?? null,
    confirmSleep,
  };
}

export type ComputerActions = ReturnType<typeof useComputerActions>;
