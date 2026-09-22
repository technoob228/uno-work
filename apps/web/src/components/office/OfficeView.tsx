import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FileSpreadsheetIcon,
  FileTextIcon,
  Loader2Icon,
  PresentationIcon,
  SaveIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { FILESYSTEM_READ_FILE_HARD_MAX_BYTES } from "@t3tools/contracts";

import { isElectron } from "../../env";
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
import {
  fetchOfficeEngineStatus,
  installProgressLabel,
  requestOfficeEngineInstall,
} from "./officeInstall";
import { normalizeXlsxForEngine } from "./normalizeXlsx";

const TYPE_ICON: Record<OfficeDocumentType, typeof FileTextIcon> = {
  word: FileTextIcon,
  cell: FileSpreadsheetIcon,
  slide: PresentationIcon,
};

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: Date }
  | { kind: "error"; message: string };

export function OfficeView({ path }: { path: string }) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const environmentId = activeEnvironmentId ?? primaryEnvironmentId;
  const queryClient = useQueryClient();

  const documentType = officeDocumentType(path);
  const saveTarget = officeSaveTarget(path);
  const fileName = officeFileName(path);
  const Icon = documentType ? TYPE_ICON[documentType] : FileTextIcon;

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
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const saveRef = useRef<() => Promise<void>>(async () => {});

  const save = useCallback(async () => {
    const editor = editorRef.current;
    const api = environmentId ? readEnvironmentApi(environmentId) : undefined;
    if (!editor || !api || !saveTarget) return;
    setSaveState({ kind: "saving" });
    try {
      const bytes = await editor.exportBytes(saveTarget.extension);
      await writeOfficeBytes((input) => api.projects.writeFile(input), saveTarget.path, bytes);
      setDirty(false);
      setSaveState({ kind: "saved", at: new Date() });
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
      setSaveState({ kind: "error", message });
      toastManager.add({ type: "error", title: "Couldn't save", description: message });
    }
  }, [environmentId, path, queryClient, saveTarget]);
  saveRef.current = save;

  const bytes = fileQuery.data;
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !bytes || !documentType || engineQuery.data !== true) return;
    let cancelled = false;
    setEditorReady(false);
    setEditorError(null);
    setDirty(false);
    void createOfficeEditor({
      container,
      bytes,
      fileName,
      fileType: officeExtension(path),
      documentType,
      onReady: () => {
        if (!cancelled) setEditorReady(true);
      },
      onDirtyChange: (value) => {
        if (!cancelled) setDirty(value);
      },
      onError: (message) => {
        if (!cancelled) setEditorError(message);
      },
      onSaveRequest: () => void saveRef.current(),
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
  }, [bytes, documentType, engineQuery.data, fileName, path]);

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
        : editorError
          ? { title: "Office couldn't open this document", body: editorError }
          : null;

  const loading = !blocking && (engineQuery.isPending || fileQuery.isPending || !editorReady);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <header className="border-b border-border px-3 py-2">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium text-foreground" title={path}>
              {fileName}
            </span>
            <span
              className="shrink-0 text-xs text-muted-foreground"
              data-testid="office-save-state"
            >
              {saveState.kind === "saving"
                ? "Saving…"
                : saveState.kind === "error"
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
                onClick={() => void save()}
                disabled={!editorReady || saveState.kind === "saving"}
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
        <div className="relative min-h-0 flex-1">
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
              </div>
            </div>
          ) : loading ? (
            <div className="absolute inset-0 flex items-center justify-center bg-background/80">
              <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : null}
        </div>
      </div>
    </SidebarInset>
  );
}
