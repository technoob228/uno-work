import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { memo } from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import {
  CodeIcon,
  DiffIcon,
  FolderIcon,
  GlobeIcon,
  PanelRightIcon,
  TerminalSquareIcon,
} from "lucide-react";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { Toggle } from "../ui/toggle";
import { SidebarTrigger, useSidebar } from "../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { usePreviewPane } from "../preview/PreviewPaneContext";
import { toggleDevMode, useDevMode } from "../../devMode";

const HEADER_ICON_BUTTON_CLASS =
  "inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-md border border-input px-[calc(--spacing(1)-1px)] text-muted-foreground shadow-xs/5 hover:bg-accent hover:text-foreground sm:h-6 sm:min-w-6";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  isGitRepo: boolean;
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalToggleShortcutLabel: string | null;
  diffToggleShortcutLabel: string | null;
  gitCwd: string | null;
  diffOpen: boolean;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onToggleTerminal: () => void;
  onToggleDiff: () => void;
}

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    Boolean(input.activeProjectName) &&
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeThreadTitle,
  activeProjectName,
  isGitRepo,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  terminalAvailable,
  terminalOpen,
  terminalToggleShortcutLabel,
  diffToggleShortcutLabel,
  gitCwd,
  diffOpen,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onToggleTerminal,
  onToggleDiff,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const devMode = useDevMode();
  const { isMobile, open, openMobile } = useSidebar();
  const sidebarVisible = isMobile ? openMobile : open;
  const {
    open: previewOpen,
    files: previewFiles,
    toggleOpen: togglePreview,
    openBrowser,
    openUrl,
  } = usePreviewPane();
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
  });

  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        {!sidebarVisible && (
          <TooltipProvider delay={0} closeDelay={0}>
            <Tooltip>
              <TooltipTrigger render={<SidebarTrigger className="size-7 shrink-0" />} />
              <TooltipPopup side="bottom">Show sidebar</TooltipPopup>
            </Tooltip>
          </TooltipProvider>
        )}
        <h2
          className="min-w-0 shrink truncate text-sm font-medium text-foreground"
          title={activeThreadTitle}
        >
          {activeThreadTitle}
        </h2>
        {activeProjectName && (
          <Badge variant="outline" className="min-w-0 shrink overflow-hidden">
            <span className="min-w-0 truncate">{activeProjectName}</span>
          </Badge>
        )}
        <TooltipProvider delay={0} closeDelay={0}>
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  className="shrink-0 data-[pressed]:border-primary/40 data-[pressed]:bg-primary/15 data-[pressed]:text-primary"
                  pressed={devMode}
                  onPressedChange={() => toggleDevMode()}
                  aria-label="Toggle dev mode"
                  variant="outline"
                  size="xs"
                >
                  <CodeIcon className="size-3" />
                </Toggle>
              }
            />
            <TooltipPopup side="bottom">{devMode ? "Dev mode: on" : "Dev mode: off"}</TooltipPopup>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3">
        {devMode && activeProjectScripts && (
          <ProjectScriptsControl
            scripts={activeProjectScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        )}
        {devMode && showOpenInPicker && (
          <OpenInPicker
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
          />
        )}
        {devMode && activeProjectName && !isGitRepo && (
          <Badge variant="outline" className="shrink-0 text-[10px] text-amber-700">
            No Git
          </Badge>
        )}
        {devMode && activeProjectName && (
          <GitActionsControl
            gitCwd={gitCwd}
            activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
            {...(draftId ? { draftId } : {})}
          />
        )}
        {devMode && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  className="shrink-0"
                  pressed={terminalOpen}
                  onPressedChange={onToggleTerminal}
                  aria-label="Toggle terminal drawer"
                  variant="outline"
                  size="xs"
                  disabled={!terminalAvailable}
                >
                  <TerminalSquareIcon className="size-3" />
                </Toggle>
              }
            />
            <TooltipPopup side="bottom">
              {!terminalAvailable
                ? "Terminal is unavailable until this thread has an active project."
                : terminalToggleShortcutLabel
                  ? `Toggle terminal drawer (${terminalToggleShortcutLabel})`
                  : "Toggle terminal drawer"}
            </TooltipPopup>
          </Tooltip>
        )}
        {devMode && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  className="shrink-0"
                  pressed={diffOpen}
                  onPressedChange={onToggleDiff}
                  aria-label="Toggle diff panel"
                  variant="outline"
                  size="xs"
                  disabled={!isGitRepo && !diffOpen}
                >
                  <DiffIcon className="size-3" />
                </Toggle>
              }
            />
            <TooltipPopup side="bottom">
              {!isGitRepo && !diffOpen
                ? "Diff panel is unavailable because this project is not a git repository."
                : diffToggleShortcutLabel
                  ? `Toggle diff panel (${diffToggleShortcutLabel})`
                  : "Toggle diff panel"}
            </TooltipPopup>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() =>
                  openBrowser({
                    environmentId: activeThreadEnvironmentId,
                    startPath: gitCwd ?? openInCwd ?? null,
                  })
                }
                aria-label="Browse files"
                className={HEADER_ICON_BUTTON_CLASS}
              >
                <FolderIcon className="size-3" />
              </button>
            }
          />
          <TooltipPopup side="bottom">Открыть файловый браузер</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => openUrl()}
                aria-label="Открыть браузер"
                className={HEADER_ICON_BUTTON_CLASS}
              >
                <GlobeIcon className="size-3" />
              </button>
            }
          />
          <TooltipPopup side="bottom">Открыть браузер</TooltipPopup>
        </Tooltip>
        {previewFiles.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={togglePreview}
                  aria-label="Toggle preview pane"
                  aria-pressed={previewOpen}
                  className={HEADER_ICON_BUTTON_CLASS}
                >
                  <PanelRightIcon className="size-3" />
                </button>
              }
            />
            <TooltipPopup side="bottom">Переключить панель превью</TooltipPopup>
          </Tooltip>
        )}
      </div>
    </div>
  );
});
