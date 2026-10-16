/**
 * ↗ on a file in the panel's path bar (w0138, point 8). Desktop app: a small
 * menu — "Open in <editor>" and "Share with a link…". Work on a cloud
 * computer: ↗ is the Share button. A file on the laptop is shared as a copy
 * in Cloud storage (the laptop isn't reachable from the internet): a progress
 * line "Uploading to Cloud storage…", then the Cloud storage link dialog. A
 * file on a cloud computer gets a link from the computer (files/ShareDialog).
 * See fileShare.logic.ts.
 */
import { EDITORS, type EnvironmentId, type FilesEntry } from "@t3tools/contracts";
import {
  CloudUploadIcon,
  ExternalLinkIcon,
  LinkIcon,
  Loader2Icon,
  RefreshCwIcon,
  ShareIcon,
  SquarePenIcon,
} from "lucide-react";
import { useState } from "react";

import { useDemoDesktop } from "../../demo/demoFlag";
import { usePreferredEditor } from "../../editorPreferences";
import { isElectron } from "../../env";
import { isPrimaryEnvironmentId } from "../../environments/http/target";
import { useServerAvailableEditors } from "../../rpc/serverState";
import { DriveShareDialog } from "../drive/DriveShareDialog";
import { filesApi } from "../files/filesApi";
import { ShareDialog } from "../files/ShareDialog";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { PreviewFile } from "./PreviewPaneContext";
import { planFileActions, SHARED_COPIES_PREFIX, sharedCopyKey } from "./fileShare.logic";

const iconButton =
  "inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 data-popup-open:bg-accent data-popup-open:text-foreground";

/** Upload a copy of the file into Cloud storage → Shared/; the key of the copy. */
async function uploadSharedCopy(environmentId: EnvironmentId, path: string, name: string) {
  const api = filesApi(environmentId);
  const drive = await api.driveState();
  if (!drive.available || drive.bucketId === null) {
    throw new Error(drive.message ?? "Cloud storage isn't available on this computer.");
  }
  await api.cloudCopyToCloud({
    paths: [path],
    bucketId: drive.bucketId,
    prefix: SHARED_COPIES_PREFIX,
  });
  return { key: sharedCopyKey(name), name };
}

export function FileOpenShareButton({
  file,
  environmentId,
  onOpenInEditor,
}: {
  file: PreviewFile;
  environmentId: EnvironmentId | null;
  onOpenInEditor: (path: string) => void;
}) {
  const demoDesktop = useDemoDesktop();
  const desktop = isElectron || demoDesktop;
  const envId = file.environmentId ?? environmentId;
  const plan = planFileActions({
    desktop,
    onThisLaptop: envId !== null && isPrimaryEnvironmentId(envId),
  });
  const availableEditors = useServerAvailableEditors();
  const [editor] = usePreferredEditor(availableEditors);
  const editorName =
    EDITORS.find((candidate) => candidate.id === editor && candidate.id !== "file-manager")
      ?.label ?? "your editor";

  const [uploading, setUploading] = useState(false);
  const [driveTarget, setDriveTarget] = useState<{ key: string; name: string } | null>(null);
  const [shareEntry, setShareEntry] = useState<FilesEntry | null>(null);
  const path = file.path ?? null;

  const shareCloudCopy = async () => {
    if (!path || !envId || uploading) return;
    setShareEntry(null);
    setUploading(true);
    try {
      setDriveTarget(await uploadSharedCopy(envId, path, file.name));
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't upload to Cloud storage",
        description: error instanceof Error ? error.message : "Try again in a moment.",
      });
    } finally {
      setUploading(false);
    }
  };

  const updateCloudCopy = async () => {
    if (!path || !envId) return;
    setUploading(true);
    try {
      await uploadSharedCopy(envId, path, file.name);
      toastManager.add({
        type: "success",
        title: "Shared copy updated",
        description: "The same link now opens the file as it is now.",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't update the copy",
        description: error instanceof Error ? error.message : "Try again in a moment.",
      });
    } finally {
      setUploading(false);
    }
  };

  const share = () => {
    if (!path) return;
    if (plan.share === "cloud-copy") {
      void shareCloudCopy();
      return;
    }
    setShareEntry({
      name: file.name,
      path,
      kind: "file",
      size: 0,
      modifiedAt: new Date().toISOString(),
      hidden: false,
      isSymlink: false,
    });
  };

  const trigger = plan.menu ? (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              disabled={!path}
              aria-label="Open or share"
              data-testid="preview-open-share"
              className={iconButton}
            />
          }
        >
          {uploading ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <ExternalLinkIcon className="size-3.5" />
          )}
        </TooltipTrigger>
        <TooltipPopup side="bottom">Open or share</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" className="w-64" data-testid="preview-open-share-menu">
        <MenuItem onClick={() => path && onOpenInEditor(path)}>
          <SquarePenIcon />
          Open in {editorName}
        </MenuItem>
        <MenuItem onClick={share} disabled={uploading}>
          <LinkIcon />
          <span className="flex min-w-0 flex-col">
            <span>Share with a link…</span>
            {plan.share === "cloud-copy" ? (
              <span className="text-[11px] text-muted-foreground">
                Uploads a copy to Cloud storage
              </span>
            ) : null}
          </span>
        </MenuItem>
      </MenuPopup>
    </Menu>
  ) : (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={share}
            disabled={!path}
            aria-label="Share"
            data-testid="preview-share"
            className={iconButton}
          >
            <ShareIcon className="size-3.5" />
          </button>
        }
      />
      <TooltipPopup side="bottom">Share with a link</TooltipPopup>
    </Tooltip>
  );

  return (
    <>
      {trigger}
      {uploading ? (
        <div
          role="status"
          data-testid="preview-share-uploading"
          className="absolute inset-x-0 top-full z-20 flex h-7 items-center gap-2 border-b border-border bg-card px-3 text-xs text-muted-foreground"
        >
          <CloudUploadIcon className="size-3.5 shrink-0 text-sky-500" />
          <span className="min-w-0 flex-1 truncate">
            Uploading to Cloud storage… <span className="text-foreground">{file.name}</span> →{" "}
            {SHARED_COPIES_PREFIX}
          </span>
          <span className="relative h-1 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
            <span className="absolute inset-y-0 left-0 w-1/2 animate-[uno-upload_1.2s_ease-in-out_infinite] rounded-full bg-sky-500" />
          </span>
          <style>{`@keyframes uno-upload{0%{transform:translateX(-100%)}100%{transform:translateX(200%)}}`}</style>
        </div>
      ) : null}
      <DriveShareDialog
        environmentId={envId}
        target={driveTarget}
        onOpenChange={(open) => !open && setDriveTarget(null)}
        note={
          <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <CloudUploadIcon className="mt-px size-3.5 shrink-0 text-sky-500" />
            <div className="min-w-0 flex-1">
              This is a copy as of now, in Cloud storage → {SHARED_COPIES_PREFIX}. Change the file —
              update the copy, the link stays the same.
            </div>
            <Button
              size="xs"
              variant="outline"
              disabled={uploading}
              onClick={() => void updateCloudCopy()}
              className="shrink-0"
            >
              {uploading ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
              Update
            </Button>
          </div>
        }
      />
      <ShareDialog
        open={shareEntry !== null}
        environmentId={envId}
        entry={shareEntry}
        onOpenChange={(open) => !open && setShareEntry(null)}
        note={
          <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <div className="min-w-0 flex-1">
              The link opens the file right on this computer. Asleep, it wakes up for the visitor (a
              few seconds). Turning it off? Share a copy from Cloud storage — it opens any time.
            </div>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void shareCloudCopy()}
              className="shrink-0"
              data-testid="preview-share-cloud-copy"
            >
              <CloudUploadIcon />
              Cloud copy
            </Button>
          </div>
        }
      />
    </>
  );
}
