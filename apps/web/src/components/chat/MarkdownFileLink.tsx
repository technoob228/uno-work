/**
 * A file named in an agent's answer, as a chip inside the text: its type's
 * icon and name; a click opens it in the right panel, on the computer the chat
 * runs on (not the one on screen). Folders open in the panel's Files.
 */
import type { EnvironmentId, FilesEntryKind } from "@t3tools/contracts";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { openInPreferredEditor } from "../../editorPreferences";
import { isPrimaryEnvironmentId } from "../../environments/http/target";
import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { resolvePathLinkTarget } from "../../terminal-links";
import { computerFileTab } from "../../navigation/useOpenComputerFile";
import { dirname } from "../files/fileTypes";
import { usePanelFilesStore } from "../files/filesPanelTab";
import { makeFilesTabFile, usePreviewPane } from "../preview/PreviewPaneContext";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useFileMention } from "./fileMentionStore";
import { VscodeEntryIcon } from "./VscodeEntryIcon";

/** What a chip needs to know about the answer it sits in. */
export interface FileMentionContextValue {
  readonly environmentId: EnvironmentId | undefined;
  readonly cwd: string | undefined;
  /** An answer still being written: no chips yet, its words are still changing. */
  readonly isStreaming: boolean;
  readonly theme: "light" | "dark";
}

export const FileMentionContext = createContext<FileMentionContextValue>({
  environmentId: undefined,
  cwd: undefined,
  isStreaming: false,
  theme: "light",
});

function positionLabel(line: number | undefined, column: number | undefined): string | null {
  if (line === undefined) return null;
  return column === undefined ? `L${line}` : `L${line}:C${column}`;
}

function copyPath(value: string, title: string) {
  if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `Failed to copy ${title.toLowerCase()}`,
        description: "Clipboard API unavailable.",
      }),
    );
    return;
  }
  void navigator.clipboard.writeText(value).then(
    () => toastManager.add({ type: "success", title: `${title} copied`, description: value }),
    (error) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Failed to copy ${title.toLowerCase()}`,
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      ),
  );
}

/** Opens what a chip names in the right panel, beside the chat. */
function useOpenInPanel(environmentId: EnvironmentId | undefined) {
  const preview = usePreviewPane();
  return useCallback(
    (path: string, kind: FilesEntryKind) => {
      const environment = environmentId ?? preview.currentChatEnvironmentId ?? undefined;
      if (!environment) return;
      if (kind === "file") {
        preview.openFile(computerFileTab(path, environment));
        return;
      }
      const tab = makeFilesTabFile(environment, preview.currentChatThreadId);
      usePanelFilesStore.getState().setPlace(tab.id, { path });
      preview.openFile(tab);
    },
    [environmentId, preview],
  );
}

interface MarkdownFileLinkProps {
  /** Where it really is, or, before the computer has answered, as written. */
  readonly path: string;
  readonly kind: FilesEntryKind;
  readonly label: string;
  readonly href: string;
  readonly className?: string | undefined;
}

export const MarkdownFileLink = memo(function MarkdownFileLink({
  path,
  kind,
  label,
  href,
  className,
}: MarkdownFileLinkProps) {
  const { environmentId, theme } = useContext(FileMentionContext);
  const openInPanel = useOpenInPanel(environmentId);

  const handleContextMenu = useCallback(
    async (event: ReactMouseEvent<HTMLAnchorElement>) => {
      const api = readLocalApi();
      if (!api?.contextMenu) return;
      event.preventDefault();
      event.stopPropagation();
      // The editor is on this device: of no use for another computer's file.
      const onThisDevice = environmentId ? isPrimaryEnvironmentId(environmentId) : false;
      const clicked = await api.contextMenu.show(
        [
          { id: "open" as const, label: "Open beside the chat" },
          ...(kind === "file" ? [{ id: "folder" as const, label: "Show in Files" }] : []),
          ...(onThisDevice ? [{ id: "editor" as const, label: "Open in editor" }] : []),
          { id: "copy" as const, label: "Copy full path" },
        ],
        { x: event.clientX, y: event.clientY },
      );
      if (clicked === "open") openInPanel(path, kind);
      if (clicked === "folder") openInPanel(dirname(path), "directory");
      if (clicked === "copy") copyPath(path, "Full path");
      if (clicked === "editor") {
        void openInPreferredEditor(api, path).catch((error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Unable to open file",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        });
      }
    },
    [environmentId, kind, openInPanel, path],
  );

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={href}
            className={cn("chat-markdown-file-link", className)}
            data-testid="chat-file-chip"
            data-file-kind={kind}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openInPanel(path, kind);
            }}
            onContextMenu={handleContextMenu}
          >
            <VscodeEntryIcon
              pathValue={path}
              kind={kind}
              theme={theme}
              className="chat-markdown-file-link-icon size-3.5 shrink-0"
            />
            <span className="chat-markdown-file-link-label truncate">{label}</span>
          </a>
        }
      />
      <TooltipPopup
        side="top"
        className="max-w-[min(40rem,calc(100vw-2rem))] font-mono text-[11px] leading-tight"
      >
        <div className="markdown-file-link-tooltip-scroll overflow-x-auto whitespace-nowrap">
          {path}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
});

/**
 * The `<file-mention>` element of an answer (remarkFileMentions): a chip when
 * the computer has the file, what the agent wrote when it hasn't. A sure
 * mention is a chip before the answer comes, so the text doesn't jump for the
 * common case; a bare name waits, it's as often not a file at all.
 */
export function FileMention({
  path,
  line,
  column,
  strong,
  link,
  label,
  className,
  children,
}: {
  path?: string;
  line?: string;
  column?: string;
  strong?: string;
  /** The agent wrote a link to this file itself; the rest is spotted in its text. */
  link?: boolean;
  label?: string;
  className?: string;
  children?: ReactNode;
}) {
  const { environmentId, cwd, isStreaming } = useContext(FileMentionContext);
  const mention = path ?? "";
  const state = useFileMention(environmentId, cwd, mention, !isStreaming);
  const lineNumber = line ? Number.parseInt(line, 10) : undefined;
  const columnNumber = column ? Number.parseInt(column, 10) : undefined;
  const position = positionLabel(lineNumber, columnNumber);
  const name = label ?? mention;
  const text = position ? `${name} · ${position}` : name;

  // Spotted paths mean something only on a computer (not in a settings guide, say).
  if (!mention || (!environmentId && !link)) return <>{children}</>;
  if (state?.status === "found") {
    return (
      <MarkdownFileLink
        path={state.path}
        kind={state.kind}
        label={text}
        href={state.path}
        className={className}
      />
    );
  }
  const unanswered = state === null || state.status === "unknown";
  if (strong === "true" && unanswered && !isStreaming) {
    // `~/…` is expanded by whoever reads it, on the chat's computer.
    const relative = !/^(?:\/|~\/|[A-Za-z]:[\\/])/.test(mention);
    const written = relative && cwd ? resolvePathLinkTarget(mention, cwd) : mention;
    return (
      <MarkdownFileLink
        path={written}
        kind={mention.endsWith("/") ? "directory" : "file"}
        label={text}
        href={mention}
        className={className}
      />
    );
  }
  return <>{children}</>;
}
