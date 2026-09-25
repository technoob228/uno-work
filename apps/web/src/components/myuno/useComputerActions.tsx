/**
 * What My Uno can do to a computer on the account, shared by its row, the
 * side panel and "Worth a look": wake it (or start a stopped one), put it to
 * sleep (an Uno Work computer asks first — it may be the one this window
 * works on), restart it (always asks first), and change what it is for. Each
 * computer tracks its own pending call, so waking one doesn't grey out the
 * others.
 *
 * Restart: the console answers at once and restarts the computer in the
 * background (~15 s offline). This window then reads the computer every few
 * seconds until the console says it's back (or failed) and tells the person.
 * My Uno talks to the console, not to the computer, so it keeps working even
 * when the restarted computer is the one this window runs on.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import {
  type AccountComputer,
  describeRestartError,
  restartComputer,
  setComputerRole,
} from "../../account/accountOverview";
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
import { bringBackAction, type RestartRequest, restartPhase } from "./myUnoModel";
import { computersQuery, myUnoKeys, refreshMyUno } from "./myUnoQueries";

export type PowerVerb = "wake" | "start" | "sleep";

/** How often to read the computer while it restarts. */
const RESTART_POLL_MS = 3_000;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useComputerActions() {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<ReadonlyMap<number, PowerVerb | "role" | "restart">>(
    new Map(),
  );
  const [asking, setAsking] = useState<{ box: AccountComputer; here: boolean } | null>(null);
  const [askingRestart, setAskingRestart] = useState<{
    box: AccountComputer;
    here: boolean;
  } | null>(null);
  /** Restarts asked from this window that haven't come back yet. */
  const [restarts, setRestarts] = useState<ReadonlyMap<number, RestartRequest & { name: string }>>(
    new Map(),
  );
  const computers = useQuery(computersQuery()).data;

  const mark = useCallback((id: number, verb: PowerVerb | "role" | "restart" | null) => {
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

  const restart = useMutation({
    mutationFn: ({ box }: { box: AccountComputer }) => restartComputer(box.id),
    onMutate: ({ box }) => mark(box.id, "restart"),
    onSuccess: (answer, { box }) =>
      setRestarts((current) =>
        new Map(current).set(box.id, {
          name: box.name,
          requestedAt: answer?.requestedAt ?? null,
          at: Date.now(),
        }),
      ),
    onSettled: (_data, _error, { box }) => {
      mark(box.id, null);
      void queryClient.invalidateQueries({ queryKey: myUnoKeys.computers });
    },
    onError: (error, { box }) =>
      toastManager.add({
        type: "error",
        title: `Couldn't restart ${box.name}`,
        description: describeRestartError(error),
      }),
  });

  // While a computer restarts: read it every few seconds, and tell the person
  // how it ended.
  useEffect(() => {
    if (restarts.size === 0) return;
    const timer = setInterval(
      () => void queryClient.invalidateQueries({ queryKey: myUnoKeys.computers }),
      RESTART_POLL_MS,
    );
    return () => clearInterval(timer);
  }, [restarts.size, queryClient]);

  useEffect(() => {
    if (restarts.size === 0) return;
    const now = Date.now();
    const finished: number[] = [];
    for (const [id, request] of restarts) {
      const phase = restartPhase(
        request,
        computers?.find((computer) => computer.id === id),
        now,
      );
      if (phase === "restarting") continue;
      finished.push(id);
      const computer = computers?.find((c) => c.id === id);
      if (phase === "done") {
        toastManager.add({
          type: "success",
          title: `${request.name} restarted`,
          description: "It's back on. Files on its disk are where you left them.",
        });
      } else if (phase === "failed") {
        toastManager.add({
          type: "error",
          title: `${request.name} didn't come back`,
          description:
            "Its disk is kept. Uno has been told; try Wake up or Start in a minute, or open it in the console.",
        });
      } else {
        toastManager.add({
          type: "warning",
          title: `${request.name} is taking longer than usual`,
          description: computer
            ? "Check it in a minute, or open it in the console."
            : "Open the console to see how it is.",
        });
      }
    }
    if (finished.length === 0) return;
    setRestarts((current) => {
      const next = new Map(current);
      for (const id of finished) next.delete(id);
      return next;
    });
    refreshMyUno(queryClient);
  }, [computers, restarts, queryClient]);

  /** Always asks first: running programs lose unsaved work. */
  const askRestart = useCallback(
    (box: AccountComputer, here: boolean) => setAskingRestart({ box, here }),
    [],
  );

  const confirmRestart = (
    <AlertDialog
      open={askingRestart !== null}
      onOpenChange={(open) => (open ? null : setAskingRestart(null))}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Restart {askingRestart?.box.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {askingRestart?.here
              ? "It's the computer this window works on: it goes offline for about 15 seconds and this window reconnects by itself. "
              : "It goes offline for about 15 seconds. "}
            Unsaved work in programs that are running is lost; files on its disk are safe.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button
            data-testid="myuno-restart-confirm"
            onClick={() => {
              if (askingRestart) restart.mutate({ box: askingRestart.box });
              setAskingRestart(null);
            }}
          >
            Restart
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );

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
    restart: askRestart,
    setRole,
    pending: (id: number) => pending.get(id) ?? null,
    /** The computer is restarting at the person's request (from this window). */
    restarting: (id: number) => pending.get(id) === "restart" || restarts.has(id),
    confirmSleep,
    confirmRestart,
  };
}

export type ComputerActions = ReturnType<typeof useComputerActions>;
