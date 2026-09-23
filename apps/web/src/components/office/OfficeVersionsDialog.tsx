/**
 * Office → "Versions": the older copies of the open document, newest first,
 * each downloadable. A Cloud document's copies live in its bucket (under a
 * `.versions` folder that Files doesn't show); a file on the computer has the
 * copies its share-link saves kept.
 */
import {
  FILES_OFFICE_VERSIONS_ROUTE_PATH,
  type EnvironmentId,
  type FilesOfficeVersion,
  type FilesOfficeVersionList,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { DownloadIcon, HistoryIcon, Loader2Icon } from "lucide-react";

import { environmentFetchJson, environmentFetchResponse } from "../../environments/http/target";
import { ensureEnvironmentApi } from "../../environmentApi";
import { formatFileSize } from "../files/fileTypes";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import type { OfficeCloudRef } from "./officeCloud";

export type OfficeVersionsSource =
  | { readonly kind: "computer"; readonly path: string }
  | { readonly kind: "cloud"; readonly ref: OfficeCloudRef };

export async function listOfficeVersions(
  environmentId: EnvironmentId,
  source: OfficeVersionsSource,
): Promise<ReadonlyArray<FilesOfficeVersion>> {
  if (source.kind === "cloud") {
    return (await ensureEnvironmentApi(environmentId).files.cloudOfficeVersions(source.ref))
      .versions;
  }
  const result = await environmentFetchJson<FilesOfficeVersionList>({
    environmentId,
    pathname: FILES_OFFICE_VERSIONS_ROUTE_PATH,
    searchParams: { path: source.path },
  });
  return result.versions;
}

/** `plan (2026-09-24 10-00).docx` — the document's name plus when the copy was replaced. */
export function versionFileName(documentName: string, createdAt: string | null): string {
  const dot = documentName.lastIndexOf(".");
  const stem = dot > 0 ? documentName.slice(0, dot) : documentName;
  const ext = dot > 0 ? documentName.slice(dot) : "";
  const when = createdAt ? createdAt.slice(0, 16).replace("T", " ").replace(":", "-") : "older";
  return `${stem} (${when})${ext}`;
}

async function downloadVersion(
  environmentId: EnvironmentId,
  source: OfficeVersionsSource,
  version: FilesOfficeVersion,
  documentName: string,
) {
  if (source.kind === "cloud") {
    const { url } = await ensureEnvironmentApi(environmentId).files.cloudDownloadUrl({
      bucketId: source.ref.bucketId,
      key: version.id,
    });
    window.open(url, "_blank", "noopener");
    return;
  }
  const response = await environmentFetchResponse({
    environmentId,
    pathname: FILES_OFFICE_VERSIONS_ROUTE_PATH,
    searchParams: { path: source.path, version: version.id },
  });
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = versionFileName(documentName, version.createdAt);
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function formatWhen(iso: string | null): string {
  if (!iso) return "Older version";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function OfficeVersionsDialog({
  open,
  onOpenChange,
  environmentId,
  source,
  documentName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: EnvironmentId | null;
  source: OfficeVersionsSource;
  documentName: string;
}) {
  const versions = useQuery({
    queryKey: ["office", "versions", environmentId, source],
    queryFn: () => listOfficeVersions(environmentId!, source),
    enabled: open && environmentId !== null,
    staleTime: 0,
  });
  const explainer =
    source.kind === "cloud"
      ? "Every save keeps the version it replaced — the last 10, in Cloud storage."
      : "Saves made through share links keep the version they replaced — the last 20 per link.";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md" data-testid="office-versions-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <HistoryIcon className="size-5" />
            Versions
          </DialogTitle>
          <DialogDescription>{explainer}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-1.5">
          {versions.isPending ? (
            <div className="flex justify-center py-6">
              <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : versions.isError ? (
            <p className="text-sm text-destructive">
              {versions.error instanceof Error ? versions.error.message : "Couldn't list versions."}
            </p>
          ) : versions.data.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">No older versions yet.</p>
          ) : (
            versions.data.map((version) => (
              <div
                key={version.id}
                className="flex items-center gap-3 rounded-lg border border-border px-3 py-2"
                data-testid="office-version-row"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{formatWhen(version.createdAt)}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatFileSize(version.size)}
                  </div>
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    void downloadVersion(environmentId!, source, version, documentName).catch(
                      (error: unknown) =>
                        toastManager.add({
                          type: "error",
                          title: "Couldn't download this version",
                          description: error instanceof Error ? error.message : String(error),
                        }),
                    )
                  }
                >
                  <DownloadIcon className="size-3.5" />
                  Download
                </Button>
              </div>
            ))
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
