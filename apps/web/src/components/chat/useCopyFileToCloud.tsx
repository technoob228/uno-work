/**
 * "Copy to Cloud storage" for a file in a chat. The copy runs on the chat's
 * computer, so the file goes up from where it lives, not from this device.
 */
import type { EnvironmentId, FilesEntry, FilesEntryKind } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";

import { CopyToCloudDialog } from "../files/CopyToCloudDialog";

export const COPY_TO_CLOUD_LABEL = "Copy to Cloud storage";

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** The dialog sends only the path and shows the name; a chat knows no more. */
export function chatFileEntry(input: {
  readonly path: string;
  readonly kind: FilesEntryKind;
  readonly name?: string;
  readonly sizeBytes?: number;
}): FilesEntry {
  return {
    name: input.name ?? fileName(input.path),
    path: input.path,
    kind: input.kind,
    size: input.sizeBytes ?? 0,
    modifiedAt: new Date(0).toISOString(),
    hidden: false,
    isSymlink: false,
  };
}

/** A chat has many chips: the dialog exists only while it's open. */
export function useCopyFileToCloud(environmentId: EnvironmentId | null): {
  readonly open: (entry: FilesEntry) => void;
  readonly dialog: ReactNode;
} {
  const [entry, setEntry] = useState<FilesEntry | null>(null);
  return {
    open: setEntry,
    dialog: entry ? (
      <CopyToCloudDialog
        open
        environmentId={environmentId}
        entries={[entry]}
        onOpenChange={(open) => {
          if (!open) setEntry(null);
        }}
      />
    ) : null,
  };
}
