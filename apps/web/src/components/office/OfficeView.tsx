import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CloudIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  HistoryIcon,
  Loader2Icon,
  PresentationIcon,
  SaveIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { FILESYSTEM_READ_FILE_HARD_MAX_BYTES } from "@t3tools/contracts";

import { isElectron } from "../../env";
import { useFeatureFlag } from "../../hooks/useFeatureFlags";
import { ShareDialog } from "../files/ShareDialog";
import { filesApi, filesQueryKeys, filesStatQueryOptions } from "../files/filesApi";
import { readEnvironmentApi } from "../../environmentApi";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useStore } from "../../store";
import { Button } from "../ui/button";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { base64ToBytes } from "./officeBytes";
import {
  createOfficeEditor,
  isOfficeEngineInstalled,
  type OfficeEditorHandle,
} from "./officeEngine";
import {
  officeDocumentType,
  officeExtension,
  officeFileName,
  officeSaveTarget,
  type OfficeDocumentType,
} from "./officeFormats";
import { writeOfficeBytes } from "./officeSave";
import { OfficeVersionsDialog } from "./OfficeVersionsDialog";
import {
  fetchOfficeEngineStatus,
  installProgressLabel,
  requestOfficeEngineInstall,
} from "./officeInstall";
import { normalizeXlsxForEngine } from "./normalizeXlsx";
import { blankExtensionFor, blankOfficeFile, isZipArchive } from "./officeBlank";
import {
  cloudDocumentFolder,
  openCloudDocument,
  saveCloudDocument,
  type OfficeCloudRef,
} from "./officeCloud";
import { OfficeDocsChrome, type DocsSaveStatus } from "./OfficeDocsChrome";
import type { DocsShell } from "./officeDocsShell";

/** Docs shell autosave: this long after the last edit. */
const DOCS_AUTOSAVE_MS = 3_000;
/**
 * Cloud documents autosave only after a longer pause: every cloud save keeps
 * the previous copy in `.versions` (last 10), so saving every few seconds
 * would push the useful older copies out within a minute of typing.
 */
const DOCS_CLOUD_AUTOSAVE_MS = 30_000;

/** OOXML/ODF formats are zip archives; anything else under that name is broken. */
const ARCHIVE_FORMATS = new Set([
  "docx",
  "xlsx",
  "pptx",
  "odt",
  "ods",
  "odp",
  "dotx",
  "xltx",
  "xlsm",
  "potx",
  "ppsx",
]);
const KIND_NAME: Record<OfficeDocumentType, string> = {
  word: "Word document",
  cell: "spreadsheet",
  slide: "presentation",
};

const TYPE_ICON: Record<OfficeDocumentType, typeof FileTextIcon> = {
  word: FileTextIcon,
  cell: FileSpreadsheetIcon,
  slide: PresentationIcon,
};

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: Date }
  | { kind: "error"; message: string }
  /** Someone saved a newer version in the cloud; `mine` is what wasn't saved. */
  | { kind: "conflict"; mine: Uint8Array };

/** What the page knows about a Cloud document it opened. */
interface CloudSession {
  version: string | null;
  writable: boolean;
  stagingDir: string;
}

function downloadBytes(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * `path` is a file on the computer — or, with `cloud`, the object key of a
 * document in Cloud storage (names and formats come from it the same way).
 */
export function OfficeView({ path, cloud }: { path: string; cloud?: OfficeCloudRef }) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const environmentId = activeEnvironmentId ?? primaryEnvironmentId;
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const documentType = officeDocumentType(path);
  const cloudSessionRef = useRef<CloudSession | null>(null);
  const [cloudWritable, setCloudWritable] = useState(true);
  // A Cloud document saves back only in its own format (no "save as .docx" next to it).
  const localSaveTarget = officeSaveTarget(path);
  const saveTarget = cloud
    ? localSaveTarget?.path === path && cloudWritable
      ? localSaveTarget
      : null
    : localSaveTarget;
  const fileName = officeFileName(path);
  const Icon = documentType ? TYPE_ICON[documentType] : FileTextIcon;
  // Our own Google-Docs-like toolbar instead of the ribbon (Labs, Word only).
  const docsShellFlag = useFeatureFlag("officeDocsShell");
  const docsShell = docsShellFlag && documentType === "word";
  const [shell, setShell] = useState<DocsShell | null>(null);
  const [shareOpen, setShareOpen] = useState(false);

  const engineQuery = useQuery({
    queryKey: ["officeEngineInstalled"],
    queryFn: () => isOfficeEngineInstalled(),
    staleTime: 60_000,
  });

  // The engine is served by the daemon behind this page, so it is installed
  // there (not on whichever computer the file lives on).
  const canInstallEngine = !isElectron && primaryEnvironmentId !== null;
  const installStatusQuery = useQuery({
    queryKey: ["officeEngineInstallStatus", primaryEnvironmentId],
    enabled: canInstallEngine && engineQuery.data === false,
    queryFn: () => fetchOfficeEngineStatus(primaryEnvironmentId!),
    refetchInterval: (query) => (query.state.data?.state === "installing" ? 1500 : false),
  });
  const installMutation = useMutation({
    mutationFn: () => requestOfficeEngineInstall(primaryEnvironmentId!),
    onSuccess: (status) => {
      queryClient.setQueryData(["officeEngineInstallStatus", primaryEnvironmentId], status);
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Couldn't install Office",
        description: error instanceof Error ? error.message : String(error),
      });
    },
  });
  const installStatus = installStatusQuery.data;
  useEffect(() => {
    if (installStatus?.installed) {
      void queryClient.invalidateQueries({ queryKey: ["officeEngineInstalled"] });
    }
  }, [installStatus?.installed, queryClient]);
  const installing = installMutation.isPending || installStatus?.state === "installing";

  const fileQuery = useQuery({
    queryKey: ["officeFile", environmentId, path],
    enabled: Boolean(documentType && environmentId),
    staleTime: Infinity,
    gcTime: 0,
    queryFn: async () => {
      const api = environmentId ? readEnvironmentApi(environmentId) : undefined;
      if (!api) throw new Error("This computer is not connected right now.");
      if (cloud) {
        const opened = await openCloudDocument(api, cloud);
        cloudSessionRef.current = {
          version: opened.version,
          writable: opened.writable,
          stagingDir: opened.stagingDir,
        };
        setCloudWritable(opened.writable);
        return officeExtension(path) === "xlsx"
          ? await normalizeXlsxForEngine(opened.bytes)
          : opened.bytes;
      }
      const result = await api.filesystem.readFile({
        path,
        maxBytes: FILESYSTEM_READ_FILE_HARD_MAX_BYTES,
      });
      if (result.truncated) {
        throw new Error(
          `The file is larger than ${Math.round(FILESYSTEM_READ_FILE_HARD_MAX_BYTES / 1024 / 1024)} MB — download it and open it in Word/Excel/PowerPoint.`,
        );
      }
      // rtf/fods — текстовые форматы, демон отдаёт их как utf8.
      const raw =
        result.encoding === "base64"
          ? base64ToBytes(result.content)
          : new TextEncoder().encode(result.content);
      return officeExtension(path) === "xlsx" ? await normalizeXlsxForEngine(raw) : raw;
    },
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<OfficeEditorHandle | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  /** Bumped on every "the document changed", so a save knows if it missed edits. */
  const editsRef = useRef(0);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const [versionsOpen, setVersionsOpen] = useState(false);
  /** Edit count when the last save failed: autosave waits for a new edit. */
  const failedAtEditsRef = useRef<number | null>(null);
  const [editCount, setEditCount] = useState(0);
  const saveRef = useRef<() => Promise<void>>(async () => {});

  const savingRef = useRef(false);
  const save = useCallback(
    async (options: { force?: boolean; bytes?: Uint8Array } = {}) => {
      const editor = editorRef.current;
      const api = environmentId ? readEnvironmentApi(environmentId) : undefined;
      if (!editor || !api || !saveTarget || savingRef.current) return;
      savingRef.current = true;
      setSaveState({ kind: "saving" });
      // In the Docs shell, mark the document clean before taking the snapshot:
      // an edit made while this save runs sets it dirty again and gets its own
      // autosave, instead of being wiped by a late "saved".
      if (docsShell) editor.markSaved();
      const editsAtStart = editsRef.current;
      const markSavedAfter = () => {
        // Edits typed while saving aren't in this file: stay dirty for them.
        if (editsRef.current === editsAtStart) setDirty(false);
        failedAtEditsRef.current = null;
        setSaveState({ kind: "saved", at: new Date() });
      };
      try {
        const bytes = options.bytes ?? (await editor.exportBytes(saveTarget.extension));
        const session = cloudSessionRef.current;
        if (cloud && session) {
          const result = await saveCloudDocument({
            api,
            ref: cloud,
            bytes,
            baseVersion: session.version,
            stagingDir: session.stagingDir,
            force: options.force === true,
          });
          if (result.kind === "conflict") {
            if (docsShell) setDirty(true);
            setSaveState({ kind: "conflict", mine: bytes });
            return;
          }
          session.version = result.version;
          if (!docsShell) editor.markSaved();
          markSavedAfter();
          void queryClient.invalidateQueries({ queryKey: ["files", "cloud"] });
          return;
        }
        await writeOfficeBytes((input) => api.projects.writeFile(input), saveTarget.path, bytes);
        markSavedAfter();
        if (saveTarget.path !== path) {
          toastManager.add({
            type: "success",
            title: "Saved as a new file",
            description: officeFileName(saveTarget.path),
          });
        }
        void queryClient.invalidateQueries({ queryKey: ["previewReadFile"] });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (docsShell) setDirty(true);
        failedAtEditsRef.current = editsRef.current;
        setSaveState({ kind: "error", message });
        toastManager.add({ type: "error", title: "Couldn't save", description: message });
      } finally {
        savingRef.current = false;
      }
    },
    [cloud, docsShell, environmentId, path, queryClient, saveTarget],
  );
  saveRef.current = save;

  const loadedBytes = fileQuery.data;
  // A text file (or an empty one) wearing a .pptx/.docx/.xlsx name: the engine
  // would spin forever on it, so say what it is and offer a blank document.
  const notADocument =
    loadedBytes !== undefined &&
    ARCHIVE_FORMATS.has(officeExtension(path)) &&
    !isZipArchive(loadedBytes);
  const bytes = notADocument ? undefined : loadedBytes;
  const blankKind = blankExtensionFor(path);
  const replaceWithBlank = useMutation({
    mutationFn: async () => {
      const api = environmentId ? readEnvironmentApi(environmentId) : undefined;
      if (!api || !blankKind) throw new Error("This computer is not connected right now.");
      const blank = await blankOfficeFile(blankKind);
      await writeOfficeBytes((input) => api.projects.writeFile(input), path, blank);
    },
    onSuccess: () => void fileQuery.refetch(),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Couldn't make a blank document",
        description: error instanceof Error ? error.message : String(error),
      }),
  });
  const readOnly = saveTarget === null;
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !bytes || !documentType || engineQuery.data !== true) return;
    let cancelled = false;
    setEditorReady(false);
    setEditorError(null);
    setDirty(false);
    setShell(null);
    void createOfficeEditor({
      container,
      bytes,
      fileName,
      fileType: officeExtension(path),
      documentType,
      readOnly,
      onReady: () => {
        if (!cancelled) setEditorReady(true);
      },
      onDirtyChange: (value) => {
        if (cancelled) return;
        if (value) {
          editsRef.current += 1;
          setEditCount(editsRef.current);
        }
        setDirty(value);
      },
      onError: (message) => {
        if (!cancelled) setEditorError(message);
      },
      onSaveRequest: () => void saveRef.current(),
      docsShell,
      onShell: (value) => {
        if (!cancelled) setShell(value);
      },
    })
      .then((editor) => {
        if (cancelled) editor.destroy();
        else editorRef.current = editor;
      })
      .catch((error: unknown) => {
        if (!cancelled) setEditorError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
      editorRef.current?.destroy();
      editorRef.current = null;
    };
  }, [bytes, docsShell, documentType, engineQuery.data, fileName, path, readOnly]);

  // Docs shell saves on its own, like Google Docs: a few seconds after the
  // last edit, into the same file. (Old .doc files would become a new .docx
  // on every autosave, so those keep the explicit Save.)
  const autosave = docsShell && saveTarget?.path === path;
  useEffect(() => {
    if (!autosave || !dirty || !editorReady) return;
    // A conflict waits for the person's choice; a failed save waits for the
    // next edit (or an explicit save), so it doesn't retry in a loop.
    if (saveState.kind === "saving" || saveState.kind === "conflict") return;
    if (saveState.kind === "error" && failedAtEditsRef.current === editCount) return;
    const timer = window.setTimeout(
      () => void saveRef.current(),
      cloud ? DOCS_CLOUD_AUTOSAVE_MS : DOCS_AUTOSAVE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [autosave, cloud, dirty, editCount, editorReady, saveState.kind]);

  const statQuery = useQuery({
    ...filesStatQueryOptions(environmentId, path),
    enabled: docsShell && !cloud && environmentId !== null && shareOpen,
  });
  useEffect(() => {
    if (!shareOpen || !statQuery.isError) return;
    setShareOpen(false);
    toastManager.add({
      type: "error",
      title: "Couldn't share this file",
      description:
        statQuery.error instanceof Error ? statQuery.error.message : String(statQuery.error),
    });
  }, [shareOpen, statQuery.error, statQuery.isError]);
  const goToFiles = useCallback(
    (target: string) => {
      if (cloud) {
        const prefix = cloudDocumentFolder(cloud.key);
        void navigate({
          to: "/files",
          search: { cloud: "1", bucket: cloud.bucketId, ...(prefix ? { prefix } : {}) },
        });
        return;
      }
      const folder = target.slice(0, Math.max(target.lastIndexOf("/"), 1));
      void navigate({ to: "/files", search: { path: folder, file: target } });
    },
    [cloud, navigate],
  );
  const rename = useCallback(
    async (newName: string) => {
      if (!environmentId) return;
      try {
        if (dirty) await saveRef.current();
        const entry = await filesApi(environmentId).rename({ path, newName, onConflict: "fail" });
        void queryClient.invalidateQueries({ queryKey: filesQueryKeys.all });
        void navigate({ to: "/office", search: { path: entry.path }, replace: true });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Couldn't rename",
          description: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    [dirty, environmentId, navigate, path, queryClient],
  );
  const download = useCallback(
    (format: "docx" | "pdf" | "odt") => {
      const editor = editorRef.current;
      if (!editor) return;
      const base = fileName.replace(/\.[^.]+$/, "");
      editor.downloadAs(format, `${base}.${format}`).catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: "Couldn't download",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    },
    [fileName],
  );
  const docsStatus: DocsSaveStatus =
    saveState.kind === "saving"
      ? { kind: "saving" }
      : saveState.kind === "error"
        ? saveState
        : saveState.kind === "conflict"
          ? { kind: "error", message: "A newer version was saved in Cloud storage." }
          : dirty
            ? { kind: "edited" }
            : saveState.kind === "saved"
              ? saveState
              : { kind: "idle" };

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const blocking = !documentType
    ? {
        title: "This file can't be opened in Office",
        body: "Office opens Word, Excel and PowerPoint files (docx, xlsx, pptx and older doc/xls/ppt).",
      }
    : engineQuery.data === false
      ? isElectron
        ? {
            title: "Office opens on your cloud computer",
            body: "In the desktop app, open this file with Word, Pages or Numbers on your Mac. To edit it in the browser, switch to a cloud computer and open it in Files there.",
          }
        : {
            title: "Office isn't installed on this computer yet",
            body:
              installStatus?.state === "error" && installStatus.error
                ? `The last install failed: ${installStatus.error}`
                : "Word, Excel and PowerPoint files open right here once Office is installed. It's a one-time ~320 MB download.",
            action: "install" as const,
          }
      : fileQuery.isError
        ? {
            title: "Couldn't open the file",
            body:
              fileQuery.error instanceof Error ? fileQuery.error.message : String(fileQuery.error),
          }
        : notADocument && documentType
          ? {
              title: `This isn't a real ${KIND_NAME[documentType]}`,
              body:
                loadedBytes && loadedBytes.length > 0
                  ? `It's ${loadedBytes.length} bytes of plain text saved with a .${officeExtension(path)} name, so Office can't open it. You can replace it with a blank ${KIND_NAME[documentType]} — the text in it will be lost.`
                  : `The file is empty. Start a blank ${KIND_NAME[documentType]} in it.`,
              action: "blank" as const,
            }
          : editorError
            ? { title: "Office couldn't open this document", body: editorError }
            : null;

  const loading = !blocking && (engineQuery.isPending || fileQuery.isPending || !editorReady);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        {docsShell ? (
          <OfficeDocsChrome
            fileName={fileName}
            shell={shell}
            status={docsStatus}
            canSave={editorReady && saveTarget !== null && saveState.kind !== "saving"}
            onBack={() => goToFiles(path)}
            onSave={() => void save()}
            onDownload={download}
            onShowInFiles={() => goToFiles(path)}
            onVersions={documentType ? () => setVersionsOpen(true) : undefined}
            cloud={cloud ? { writable: cloudWritable } : undefined}
            onShare={environmentId && !cloud ? () => setShareOpen(true) : undefined}
            onRename={autosave && environmentId && !cloud ? rename : undefined}
          />
        ) : (
          <header className="border-b border-border px-3 py-2">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="size-7 shrink-0 md:hidden" />
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Back to Files"
                onClick={() => {
                  if (cloud) {
                    const prefix = cloudDocumentFolder(cloud.key);
                    void navigate({
                      to: "/files",
                      search: { cloud: "1", bucket: cloud.bucketId, ...(prefix ? { prefix } : {}) },
                    });
                    return;
                  }
                  const folder = path.slice(0, Math.max(path.lastIndexOf("/"), 1));
                  void navigate({ to: "/files", search: { path: folder, file: path } });
                }}
              >
                <ArrowLeftIcon />
              </Button>
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate text-sm font-medium text-foreground" title={path}>
                {fileName}
              </span>
              {cloud ? (
                <span
                  className="flex shrink-0 items-center gap-1 rounded-full bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-700 dark:text-sky-300"
                  title="Opened from Cloud storage and saved back there. Older copies are kept in the .versions folder next to it."
                  data-testid="office-cloud-badge"
                >
                  <CloudIcon className="size-3" />
                  {cloudWritable ? "Cloud storage" : "Cloud storage · read-only"}
                </span>
              ) : null}
              <span
                className="shrink-0 text-xs text-muted-foreground"
                data-testid="office-save-state"
              >
                {saveState.kind === "saving"
                  ? "Saving…"
                  : saveState.kind === "error" || saveState.kind === "conflict"
                    ? "Not saved"
                    : dirty
                      ? "Unsaved changes"
                      : saveState.kind === "saved"
                        ? `Saved ${saveState.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                        : null}
              </span>
              <div className="ml-auto flex items-center gap-1">
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setVersionsOpen(true)}
                  disabled={!documentType}
                  data-testid="office-versions"
                >
                  <HistoryIcon className="size-3.5" />
                  Versions
                </Button>
                <Button
                  size="xs"
                  onClick={() => void save()}
                  disabled={!editorReady || !saveTarget || saveState.kind === "saving"}
                  data-testid="office-save"
                >
                  {saveState.kind === "saving" ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <SaveIcon className="size-3.5" />
                  )}
                  Save
                </Button>
              </div>
            </div>
          </header>
        )}
        {saveState.kind === "conflict" ? (
          <div
            className="flex flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm"
            data-testid="office-conflict"
          >
            <span className="min-w-0 flex-1 text-foreground">
              Someone saved a newer version of this document in Cloud storage after you opened it.
              Your edits aren't saved yet — nothing was overwritten.
            </span>
            <Button
              size="xs"
              variant="outline"
              onClick={() => downloadBytes(saveState.mine, fileName)}
            >
              Download my version
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                if (
                  window.confirm(
                    "Replace the document in Cloud storage with your version? The newer one will be kept as an older copy in .versions.",
                  )
                ) {
                  void save({ force: true, bytes: saveState.mine });
                }
              }}
            >
              Replace with my version
            </Button>
            <Button
              size="xs"
              onClick={() => {
                if (window.confirm("Reload? Your unsaved edits will be lost.")) {
                  setDirty(false);
                  setSaveState({ kind: "idle" });
                  void fileQuery.refetch();
                }
              }}
            >
              Reload the latest
            </Button>
          </div>
        ) : null}
        <div
          className={
            docsShell ? "relative min-h-0 flex-1 border-t border-border" : "relative min-h-0 flex-1"
          }
        >
          <div ref={containerRef} className="absolute inset-0" data-testid="office-editor" />
          {blocking ? (
            <div className="absolute inset-0 flex items-center justify-center bg-background p-6">
              <div className="max-w-md space-y-2 text-center">
                <p className="text-sm font-medium text-foreground">{blocking.title}</p>
                <p className="text-sm text-muted-foreground">{blocking.body}</p>
                {"action" in blocking && blocking.action === "install" && canInstallEngine ? (
                  <div className="pt-2">
                    <Button
                      size="sm"
                      onClick={() => installMutation.mutate()}
                      disabled={installing}
                      data-testid="office-install"
                    >
                      {installing ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                      {installing ? installProgressLabel(installStatus) : "Install Office"}
                    </Button>
                  </div>
                ) : null}
                {"action" in blocking && blocking.action === "blank" && blankKind && !cloud ? (
                  <div className="pt-2">
                    <Button
                      size="sm"
                      onClick={() => replaceWithBlank.mutate()}
                      disabled={replaceWithBlank.isPending}
                      data-testid="office-make-blank"
                    >
                      {replaceWithBlank.isPending ? (
                        <Loader2Icon className="size-3.5 animate-spin" />
                      ) : null}
                      {`Make it a blank ${documentType ? KIND_NAME[documentType] : "document"}`}
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>
          ) : loading ? (
            <div className="absolute inset-0 flex items-center justify-center bg-background/80">
              <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : null}
        </div>
      </div>
      <OfficeVersionsDialog
        open={versionsOpen}
        onOpenChange={setVersionsOpen}
        environmentId={environmentId}
        source={cloud ? { kind: "cloud", ref: cloud } : { kind: "computer", path }}
        documentName={fileName}
      />
      {docsShell && !cloud ? (
        <ShareDialog
          open={shareOpen && statQuery.data !== undefined}
          environmentId={environmentId}
          entry={shareOpen ? (statQuery.data ?? null) : null}
          onOpenChange={setShareOpen}
        />
      ) : null}
    </SidebarInset>
  );
}
