/**
 * "Remove <app>?" — the confirmation behind a program's Remove button.
 *
 * An App Store app: Uno stops it and takes it off the computer; its data stays
 * unless the person ticks "Also delete … data" (unticked by default, and the
 * button turns red and says so when it is ticked). A docker container the
 * person started themselves: the daemon deletes the container, its volumes
 * stay. An app built on this computer (registered in `~/.uno/apps`): the
 * daemon stops it and takes it off the computer; its code folder stays unless
 * the person ticks "Also delete its code" (unticked by default, and the
 * dialog says where the code stays). Any of these can take a minute, so the
 * dialog shows it working and can't be sent twice.
 *
 * An app that keeps files in the account's cloud (the App SDK's storage) gets
 * one more box, also unticked: "Also delete its files in the cloud". Those
 * files are not on the computer, so removing the app never touches them on
 * its own. A shared folder says so — the same app on the account's other
 * computers uses the same files.
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
import { formatFileSize } from "../files/fileTypes";
import { Spinner } from "../ui/spinner";
import type { ProgramRemoval, RemovalCloudFiles } from "./programModel";

/** "Also delete its files in the cloud (120 MB)." */
export function cloudFilesLabel(cloudFiles: RemovalCloudFiles): string {
  const size = cloudFiles.usedBytes === null ? "" : ` (${formatFileSize(cloudFiles.usedBytes)})`;
  return `Also delete its files in the cloud${size}.`;
}

export function RemoveProgramDialog({
  open,
  name,
  removal,
  cloudFiles = null,
  pending,
  error,
  onConfirm,
  onOpenChange,
}: {
  open: boolean;
  name: string;
  removal: ProgramRemoval | null;
  /** The app's cloud folder, when it has one worth asking about. */
  cloudFiles?: RemovalCloudFiles | null;
  pending: boolean;
  error: string | null;
  onConfirm: (deleteData: boolean, deleteCloudFiles: boolean, deleteCode: boolean) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [deleteData, setDeleteData] = useState(false);
  const [deleteCloud, setDeleteCloud] = useState(false);
  const [deleteCode, setDeleteCode] = useState(false);
  // Every time it opens, it starts from "keep the data", "keep the files", "keep the code".
  useEffect(() => {
    if (open) {
      setDeleteData(false);
      setDeleteCloud(false);
      setDeleteCode(false);
    }
  }, [open]);

  const store = removal?.kind === "store";
  const registered = removal?.kind === "registered" ? removal : null;
  const cloud = (store || registered !== null) && cloudFiles !== null;
  const codeDir = registered?.codeDir ?? null;
  const codeDeletable = codeDir !== null && registered?.codeDirKeepReason === null;
  const wipeData = store && deleteData;
  const wipeCloud = cloud && deleteCloud;
  const wipeCode = codeDeletable && deleteCode;
  const destructive = wipeData || wipeCloud || wipeCode;
  const hasOptions = store || registered !== null;

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
            ) : registered ? (
              <>
                {name} was made on this computer. Uno will stop it, take it off this computer and
                turn off its access to AI and to the cloud.{" "}
                {codeDir ? (
                  <>
                    Its code stays in <span className="font-mono text-foreground">{codeDir}</span>{" "}
                    unless you tick below.
                  </>
                ) : (
                  "Its code, wherever it is, stays on the computer."
                )}
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
          hidden={!hasOptions && !pending && !error}
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

          {cloud && cloudFiles ? (
            <div className="flex items-start gap-2">
              <Checkbox
                id="remove-app-delete-cloud"
                className="mt-0.5"
                checked={deleteCloud}
                disabled={pending}
                onCheckedChange={(checked) => setDeleteCloud(checked === true)}
              />
              <Label
                htmlFor="remove-app-delete-cloud"
                className="flex flex-col items-start gap-0.5 text-sm leading-snug font-normal text-foreground"
              >
                <span>{cloudFilesLabel(cloudFiles)}</span>
                <span className="text-xs text-muted-foreground">
                  {cloudFiles.scope === "account"
                    ? `Careful: this folder is shared. ${name} on your other computers uses the same files.`
                    : "Only this computer's folder. This can't be undone."}
                </span>
              </Label>
            </div>
          ) : null}

          {registered && codeDir ? (
            <div className="flex items-start gap-2">
              <Checkbox
                id="remove-app-delete-code"
                className="mt-0.5"
                checked={wipeCode}
                disabled={pending || !codeDeletable}
                onCheckedChange={(checked) => setDeleteCode(checked === true)}
              />
              <Label
                htmlFor="remove-app-delete-code"
                className="flex flex-col items-start gap-0.5 text-sm leading-snug font-normal text-foreground"
              >
                <span>
                  Also delete its code in <span className="font-mono">{codeDir}</span>.
                </span>
                <span className="text-xs text-muted-foreground">
                  {codeDeletable
                    ? wipeCode
                      ? "The whole folder goes. This can't be undone."
                      : `If you leave this unticked, the code stays in ${codeDir} — Uno can bring the app back from it.`
                    : `The code stays. ${registered.codeDirKeepReason ?? ""}`}
                </span>
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
            onClick={() => onConfirm(wipeData, wipeCloud, wipeCode)}
          >
            {pending ? <Spinner className="size-3.5" /> : null}
            {wipeData
              ? "Remove and delete data"
              : wipeCode && wipeCloud
                ? "Remove and delete code and files"
                : wipeCode
                  ? "Remove and delete code"
                  : wipeCloud
                    ? "Remove and delete files"
                    : "Remove"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
