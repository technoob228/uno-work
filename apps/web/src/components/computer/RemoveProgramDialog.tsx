/**
 * "Remove <app>?" — the confirmation behind a program's Remove button.
 *
 * An App Store app: Uno stops it and takes it off the computer; its data stays
 * unless the person ticks "Also delete … data" (unticked by default, and the
 * button turns red and says so when it is ticked). A docker container the
 * person started themselves: the daemon deletes the container, its volumes
 * stay. Either can take a minute, so the dialog shows it working and can't be
 * sent twice.
 */
import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";
import { Spinner } from "../ui/spinner";
import type { ProgramRemoval } from "./programModel";

export function RemoveProgramDialog({
  open,
  name,
  removal,
  pending,
  error,
  onConfirm,
  onOpenChange,
}: {
  open: boolean;
  name: string;
  removal: ProgramRemoval | null;
  pending: boolean;
  error: string | null;
  onConfirm: (deleteData: boolean) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [deleteData, setDeleteData] = useState(false);
  // Every time it opens, it starts from "keep the data".
  useEffect(() => {
    if (open) setDeleteData(false);
  }, [open]);

  const store = removal?.kind === "store";
  const destructive = store && deleteData;

  return (
    <AlertDialog
      open={open && removal !== null}
      onOpenChange={(next) => {
        // While removing, the dialog stays: closing it would hide the outcome.
        if (!pending) onOpenChange(next);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {removal?.kind === "container" ? (
              <>
                This was not installed from the App Store. Uno will stop and delete the container{" "}
                <span className="font-mono text-foreground">{removal.container}</span>. Its data
                volumes are kept.
              </>
            ) : (
              <>
                {name} will stop and disappear from this computer. Its data (notes, files, accounts)
                stays on the computer, so if you install {name} again, everything will be back.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div
          className="-mt-2 flex flex-col gap-3 px-6 pb-5 empty:hidden"
          hidden={!store && !pending && !error}
        >
          {store ? (
            <div className="flex items-start gap-2">
              <Checkbox
                id="remove-app-delete-data"
                className="mt-0.5"
                checked={deleteData}
                disabled={pending}
                onCheckedChange={(checked) => setDeleteData(checked === true)}
              />
              <Label
                htmlFor="remove-app-delete-data"
                className="text-sm leading-snug font-normal text-foreground"
              >
                Also delete {name}'s data (notes, files, accounts). This can't be undone.
              </Label>
            </div>
          ) : null}

          {pending ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Spinner className="size-3.5" />
              Removing {name}… This can take a minute.
            </p>
          ) : null}

          {error && !pending ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <AlertDialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={destructive || !store ? "destructive" : "default"}
            disabled={pending}
            onClick={() => onConfirm(store && deleteData)}
          >
            {pending ? <Spinner className="size-3.5" /> : null}
            {destructive ? "Remove and delete data" : "Remove"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
