import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { memo, type ReactNode, useRef, useState } from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import {
  CodeIcon,
  DiffIcon,
  EllipsisIcon,
  MonitorSmartphoneIcon,
  PlusIcon,
  PanelRightIcon,
  SquarePenIcon,
  TerminalSquareIcon,
} from "lucide-react";
import { selectEnvironmentState, useStore } from "../../store";
import { useGoHome } from "../../navigation/useGoHome";
import { UnoFace } from "../sidebar/SidebarDParts";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  ScriptIcon,
} from "../ProjectScriptsControl";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Toggle } from "../ui/toggle";
import { SidebarTrigger, useSidebar } from "../ui/sidebar";
import { useSidebarDRailVisible } from "../sidebar/sidebarDState";
import { OpenInMenuItems, OpenInPicker } from "./OpenInPicker";
import { useHeaderOverflow } from "./useHeaderOverflow";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { usePreviewPane } from "../preview/PreviewPaneContext";
import { toggleDevMode, useDevMode } from "../../devMode";
import { CONTINUE_ON_MACHINE_COPY } from "../../continueOnMachineCopy";
import { isElectron } from "../../env";
import { ContinueOnMachineDialog } from "../ContinueOnMachineDialog";
import { DraftFolderChip } from "./DraftFolderChip";
import { cn } from "../../lib/utils";
import { AssistantChatHeaderActions, AssistantChatHeadline } from "./AssistantChatHeaderActions";
import { ComputerChip } from "../computer/home/ComputerChip";
import { ChatDoneButton } from "./ChatDoneButton";
import { ChatAutomationsButton } from "../automations/ChatAutomations";
import { useAssistantChat } from "../../assistant/useAssistantChat";
import { TeammateChatHeadline } from "../assistants/TeammateChatHeadline";
import { AssistantModeChip, UnoModeChip } from "../assistants/PersonaMode";
import { useTeammateOfThread } from "../assistants/useAssistantTeam";
import {
  ASSISTANT_CHAT_NAME,
  ASSISTANT_VALUE_LINE,
  assistantConversationLabel,
  isFromAssistant,
} from "../../assistant/assistantChat.logic";
import { useAssistantConversations } from "../../assistant/useAssistantConversations";

/** Leaves without a "⋯" entry: no action, and the sidebar names it. */
const HEADER_FOLD_SILENT = ["project"] as const;
/**
 * What leaves the header first when it gets narrow (into "⋯"): the project's
 * name (it's in the sidebar too), then the rarer tools. Read/Done, the
 * computer, Git and Panel always stay; Read/Done fold to their icons.
 */
const HEADER_FOLD_ORDER = [
  "project",
  "startedByUno",
  "continue",
  "openIn",
  "scripts",
  "diff",
  "devMode",
  "terminal",
] as const;
type HeaderFoldId = (typeof HEADER_FOLD_ORDER)[number];

/** A header item that can leave for "⋯"; folded, it stays mounted, hidden. */
function Foldable(props: {
  readonly id: HeaderFoldId;
  readonly folded: ReadonlySet<string>;
  readonly children: ReactNode;
}) {
  return (
    <div
      data-header-item={props.id}
      className={cn(
        "flex shrink-0 items-center gap-2 empty:hidden",
        props.folded.has(props.id) && "hidden",
      )}
    >
      {props.children}
    </div>
  );
}

const HEADER_ICON_BUTTON_CLASS =
  "inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-md border border-input px-[calc(--spacing(1)-1px)] text-muted-foreground shadow-xs/5 hover:bg-accent hover:text-foreground sm:h-6 sm:min-w-6";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  /** The project's folder; a new chat shows it as the folder chip. */
  activeProjectCwd?: string | undefined;
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
  /** The person's shortcut for the right panel; null — none bound. */
  panelToggleShortcutLabel: string | null;
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
  activeProjectCwd,
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
  panelToggleShortcutLabel,
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
  // Sidebar D's rail counts as the sidebar: no extra "show sidebar" button.
  const railD = useSidebarDRailVisible();
  const sidebarVisible = isMobile ? openMobile : open || railD;
  const {
    open: previewOpen,
    toggleOpen: togglePreview,
    unseenCount: previewUnseenCount,
  } = usePreviewPane();
  // Агент открыл что-то, пока панель этого чата закрыта человеком.
  const previewHasNew = !previewOpen && previewUnseenCount > 0;
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
  });
  // THE assistant chat: named "Uno" whatever its stored title, no project
  // badge (the assistant is the chat, not a project), Connect ▾ + settings.
  const { chat: assistantChat, open: openAssistantChat } = useAssistantChat();
  const goHome = useGoHome();
  // Sidebar D: a chat Uno started says so in its header, one click to Uno.
  const startedByUno = useStore((state) => {
    if (draftId) return false;
    const summary = selectEnvironmentState(state, activeThreadEnvironmentId)
      .sidebarThreadSummaryById[activeThreadId];
    return summary ? isFromAssistant(summary, assistantChat?.id ?? null) : false;
  });
  const assistantConversations = useAssistantConversations().conversations;
  const isMainAssistantChat =
    !draftId &&
    assistantChat !== null &&
    assistantChat.id === activeThreadId &&
    assistantChat.environmentId === activeThreadEnvironmentId;
  // Any conversation with Uno (0.0.85) gets Uno's header: its engine, Connect,
  // New conversation. The main one is just "Uno".
  const assistantConversation = draftId
    ? null
    : (assistantConversations.find(
        (thread) =>
          thread.id === activeThreadId && thread.environmentId === activeThreadEnvironmentId,
      ) ?? null);
  // A teammate's chat (Ada, Builder…) gets its own face, not Uno's (16.10).
  const teammate = useTeammateOfThread(activeThreadEnvironmentId, activeThreadId);
  const isAssistantChat =
    teammate === null && (isMainAssistantChat || assistantConversation !== null);
  const title = isMainAssistantChat
    ? ASSISTANT_CHAT_NAME
    : assistantConversation
      ? `${ASSISTANT_CHAT_NAME} · ${assistantConversationLabel(assistantConversation)}`
      : activeThreadTitle;
  const [continueDialogOpen, setContinueDialogOpen] = useState(false);
  // A draft has nothing to carry yet: no files were touched, no history exists.
  // Desktop app only (Misha 11.10): Uno Work in the browser is one cloud
  // computer's window — "continue on another machine" doesn't belong there.
  const canContinueOnMachine = isElectron && Boolean(activeProjectName) && !draftId;
  const { rootRef, folded, menuNeeded } = useHeaderOverflow(HEADER_FOLD_ORDER, HEADER_FOLD_SILENT);
  const addActionRef = useRef<(() => void) | null>(null);
  const isFolded = (id: HeaderFoldId) => folded.has(id);

  return (
    <div ref={rootRef} className="@container/header-actions flex min-w-0 flex-1 items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        {!sidebarVisible && (
          <TooltipProvider delay={0} closeDelay={0}>
            <Tooltip>
              <TooltipTrigger render={<SidebarTrigger className="size-7 shrink-0" />} />
              <TooltipPopup side="bottom">Show sidebar</TooltipPopup>
            </Tooltip>
          </TooltipProvider>
        )}
        {teammate && !devMode ? (
          <TeammateChatHeadline member={teammate} title={activeThreadTitle} />
        ) : isAssistantChat && !devMode ? (
          // Sidebar D: Uno's face, name and where it answers; its settings are
          // the chips on the right (AssistantChatHeaderActions).
          <AssistantChatHeadline environmentId={activeThreadEnvironmentId} title={title} />
        ) : (
          <h2
            className={cn(
              "truncate text-sm font-medium text-foreground",
              // Uno's name never gives way to the value line next to it. A
              // chat's title keeps room for a few words even on a phone: it
              // used to shrink into an empty pill next to the buttons.
              isAssistantChat ? "min-w-0 max-w-[45%] shrink-0" : "min-w-16 shrink",
            )}
            title={title}
          >
            {title}
          </h2>
        )}
        {isAssistantChat && !devMode ? null : isAssistantChat ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Badge
                    variant="outline"
                    className="shrink-0 border-primary/30 text-primary"
                    data-testid="uno-always-on"
                  />
                }
              >
                Always on
              </TooltipTrigger>
              <TooltipPopup side="bottom" className="max-w-72">
                {ASSISTANT_VALUE_LINE}
              </TooltipPopup>
            </Tooltip>
            <span
              className="hidden min-w-0 flex-1 basis-0 truncate text-xs text-muted-foreground @5xl/header-actions:inline"
              data-testid="uno-value-line"
            >
              Talks to you in Telegram or Slack, starts and watches other chats for you.
            </span>
          </>
        ) : draftId && activeProjectName && activeProjectCwd ? (
          <DraftFolderChip
            environmentId={activeThreadEnvironmentId}
            draftId={draftId}
            projectName={activeProjectName}
            projectCwd={activeProjectCwd}
          />
        ) : activeProjectName && !isMobile ? (
          // A phone has no room for it: squeezed, it was an empty pill. Short
          // of room it leaves whole (it's in the sidebar), never as "H.".
          <Foldable id="project" folded={folded}>
            <Badge variant="outline" className="max-w-40 overflow-hidden" title={activeProjectName}>
              <span className="min-w-0 truncate">{activeProjectName}</span>
            </Badge>
          </Foldable>
        ) : null}
        {startedByUno && !isAssistantChat ? (
          <Foldable id="startedByUno" folded={folded}>
            <button
              type="button"
              onClick={() => void openAssistantChat()}
              title="Open Uno's chat"
              data-testid="chat-started-by-uno"
              className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full bg-primary/10 py-0.5 pr-2 pl-0.5 text-xs font-medium text-primary hover:bg-primary/15"
            >
              <UnoFace className="size-4" />
              Started by Uno
            </button>
          </Foldable>
        ) : null}
        {isMobile ? null : (
          <Foldable id="devMode" folded={folded}>
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
                <TooltipPopup side="bottom">
                  {devMode ? "Dev mode: on" : "Dev mode: off"}
                </TooltipPopup>
              </Tooltip>
            </TooltipProvider>
          </Foldable>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3">
        {isMobile ? (
          // Phone: the menu slides in from the left, the pencil sits on the right.
          <button
            type="button"
            onClick={goHome}
            aria-label="New chat"
            data-testid="chat-header-new-chat"
            className={HEADER_ICON_BUTTON_CLASS}
          >
            <SquarePenIcon className="size-3.5" />
          </button>
        ) : null}
        {draftId ? null : (
          <ChatDoneButton
            environmentId={activeThreadEnvironmentId}
            threadId={activeThreadId}
            compact={isMobile}
          />
        )}
        {/* Variant D: its mode at the top of its chat — Uno's or the persona's own. */}
        {teammate ? (
          <AssistantModeChip member={teammate} />
        ) : isAssistantChat ? (
          <UnoModeChip environmentId={activeThreadEnvironmentId} />
        ) : null}
        {/* S5 29.10: the chat's automations (a clock; nothing where they aren't on). */}
        {draftId ? null : (
          <ChatAutomationsButton
            environmentId={activeThreadEnvironmentId}
            threadId={activeThreadId}
          />
        )}
        {/* Which computer, and switching to another, from any chat (0.0.96). */}
        <ComputerChip />
        {isAssistantChat ? (
          <AssistantChatHeaderActions environmentId={activeThreadEnvironmentId} />
        ) : null}
        {devMode && activeProjectScripts && (
          <Foldable id="scripts" folded={folded}>
            <ProjectScriptsControl
              scripts={activeProjectScripts}
              keybindings={keybindings}
              preferredScriptId={preferredScriptId}
              onRunScript={onRunProjectScript}
              onAddScript={onAddProjectScript}
              onUpdateScript={onUpdateProjectScript}
              onDeleteScript={onDeleteProjectScript}
              addActionRef={addActionRef}
            />
          </Foldable>
        )}
        {devMode && showOpenInPicker && (
          <Foldable id="openIn" folded={folded}>
            <OpenInPicker
              keybindings={keybindings}
              availableEditors={availableEditors}
              openInCwd={openInCwd}
            />
          </Foldable>
        )}
        {/* With a folder, the Git control's own "Initialize Git" says it. */}
        {devMode && activeProjectName && !isGitRepo && !gitCwd && (
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
        {/* Terminal is always one click away (it's not a developer-only tool);
            a phone keeps the room for the chat's title instead. */}
        {isMobile ? null : (
          <Foldable id="terminal" folded={folded}>
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
                  ? "Terminal is unavailable until this chat has an active project."
                  : terminalToggleShortcutLabel
                    ? `Toggle terminal drawer (${terminalToggleShortcutLabel})`
                    : "Toggle terminal drawer"}
              </TooltipPopup>
            </Tooltip>
          </Foldable>
        )}
        {devMode && (
          <Foldable id="diff" folded={folded}>
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
          </Foldable>
        )}
        {canContinueOnMachine && !isMobile && (
          <Foldable id="continue" folded={folded}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => setContinueDialogOpen(true)}
                    aria-label={CONTINUE_ON_MACHINE_COPY.action}
                    className={HEADER_ICON_BUTTON_CLASS}
                  >
                    <MonitorSmartphoneIcon className="size-3" />
                  </button>
                }
              />
              <TooltipPopup side="bottom">{CONTINUE_ON_MACHINE_COPY.action}</TooltipPopup>
            </Tooltip>
          </Foldable>
        )}
        {canContinueOnMachine && (
          <ContinueOnMachineDialog
            threadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
            open={continueDialogOpen}
            onOpenChange={setContinueDialogOpen}
          />
        )}
        {menuNeeded ? (
          <Menu>
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label="More"
                  title="More"
                  data-header-more=""
                  data-testid="chat-header-more"
                  className={HEADER_ICON_BUTTON_CLASS}
                />
              }
            >
              <EllipsisIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-48">
              {isFolded("startedByUno") && startedByUno && !isAssistantChat ? (
                <MenuItem onClick={() => void openAssistantChat()}>
                  <UnoFace className="size-4" />
                  Started by Uno — open Uno's chat
                </MenuItem>
              ) : null}
              {isFolded("terminal") && !isMobile ? (
                <MenuCheckboxItem
                  checked={terminalOpen}
                  onCheckedChange={onToggleTerminal}
                  disabled={!terminalAvailable}
                >
                  Terminal
                  {terminalToggleShortcutLabel ? ` (${terminalToggleShortcutLabel})` : ""}
                </MenuCheckboxItem>
              ) : null}
              {isFolded("diff") && devMode ? (
                <MenuCheckboxItem
                  checked={diffOpen}
                  onCheckedChange={onToggleDiff}
                  disabled={!isGitRepo && !diffOpen}
                >
                  Diff panel{diffToggleShortcutLabel ? ` (${diffToggleShortcutLabel})` : ""}
                </MenuCheckboxItem>
              ) : null}
              {isFolded("devMode") && !isMobile ? (
                <MenuCheckboxItem checked={devMode} onCheckedChange={() => toggleDevMode()}>
                  Dev mode
                </MenuCheckboxItem>
              ) : null}
              {isFolded("scripts") && devMode && activeProjectScripts ? (
                <>
                  <MenuSeparator />
                  <MenuGroup>
                    <MenuGroupLabel>Actions</MenuGroupLabel>
                    {activeProjectScripts.map((script) => (
                      <MenuItem key={script.id} onClick={() => onRunProjectScript(script)}>
                        <ScriptIcon icon={script.icon} className="size-4" />
                        <span className="truncate">{script.name}</span>
                      </MenuItem>
                    ))}
                    <MenuItem onClick={() => addActionRef.current?.()}>
                      <PlusIcon className="size-4" />
                      Add action…
                    </MenuItem>
                  </MenuGroup>
                </>
              ) : null}
              {isFolded("openIn") && devMode && showOpenInPicker ? (
                <>
                  <MenuSeparator />
                  <OpenInMenuItems availableEditors={availableEditors} openInCwd={openInCwd} />
                </>
              ) : null}
              {isFolded("continue") && canContinueOnMachine && !isMobile ? (
                <>
                  <MenuSeparator />
                  <MenuItem onClick={() => setContinueDialogOpen(true)}>
                    <MonitorSmartphoneIcon className="size-4" />
                    {CONTINUE_ON_MACHINE_COPY.action}
                  </MenuItem>
                </>
              ) : null}
            </MenuPopup>
          </Menu>
        ) : null}
        {/* One Panel button (plan 22): an empty panel opens its launcher —
            Browser, Files, Terminal, Changes, Apps, Sites. */}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={togglePreview}
                aria-label={previewHasNew ? "Panel: new in panel" : "Panel"}
                aria-pressed={previewOpen}
                data-testid="preview-panel-toggle"
                className={cn(
                  HEADER_ICON_BUTTON_CLASS,
                  "relative gap-1",
                  previewOpen && "border-primary/40 bg-primary/15 text-primary",
                )}
              >
                <PanelRightIcon className="size-3" />
                <span className="hidden pr-0.5 text-xs @3xl/header-actions:inline">Panel</span>
                {previewHasNew ? (
                  <span
                    aria-hidden
                    data-testid="preview-panel-new-badge"
                    className="absolute -right-1 -top-1 size-2 rounded-full bg-primary ring-2 ring-background"
                  />
                ) : null}
              </button>
            }
          />
          <TooltipPopup side="bottom">
            {previewHasNew
              ? previewUnseenCount === 1
                ? "New in panel"
                : `${previewUnseenCount} new in panel`
              : panelToggleShortcutLabel
                ? `Panel ${panelToggleShortcutLabel}`
                : "Panel"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
});
