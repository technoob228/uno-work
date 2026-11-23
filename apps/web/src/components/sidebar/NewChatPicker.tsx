/**
 * New chat → a small picker on the button itself (Misha 20.11, T53): the
 * computer on top, the folders below, the one used last already highlighted.
 * Enter or one click and the chat is open there — no stop on a start screen
 * to pick the folder and the computer first. As in Codex and Claude Code:
 * the place is chosen at the button, the chat opens ready to type.
 *
 * Keys: type to search the folders, ↑/↓ to move, Enter to start, Tab / ⇧Tab
 * for the next computer, Esc to close. ⇧-click on the button skips the picker
 * (a new chat in the open chat's folder, as before). ⌘N opens the picker on
 * the button that is on screen; with no button on screen it starts the chat
 * at once where the picker would.
 *
 * What the picker doesn't list (assistants, cloning, uploads) stays on the new
 * chat itself: its "What should we do in [folder ▾] on [computer ▾]?" still
 * moves the chat anywhere.
 */
import { scopeProjectRef } from "@t3tools/client-runtime";
import { isAssistantProjectId, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { FolderIcon, FolderOpenIcon, HouseIcon, SearchIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";

import { useActiveMachine } from "../../hooks/useActiveMachine";
import {
  HOME_FOLDER_TITLE,
  useChatOnComputer,
  useHomeFolderPath,
} from "../../hooks/useFolderChats";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useSwitchEnvironment } from "../../hooks/useSwitchEnvironment";
import { cn } from "../../lib/utils";
import { normalizeProjectPathForComparison } from "../../lib/projectPaths";
import { currentStaleBundlePage, switchReloadUrl } from "../../staleBundle";
import { readStaleBundleMachine } from "../../staleBundleMachine";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../../store";
import { ChatInFolderDialog } from "../computer/ChatInFolderDialog";
import { useRecentFolders } from "../computer/FolderChipMenu";
import { groupSwitcherMachines } from "../SidebarEnvSwitcher.logic";
import { STATUS_DOT_CLASS, useSwitcherMachines } from "../computerSwitcher/useComputerSwitcher";
import { MACHINE_KIND_ICON } from "../machineKindIcons";
import { ProjectFavicon } from "../ProjectFavicon";
import { Kbd } from "../ui/kbd";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { useSidebar } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  type NewChatFolder,
  type NewChatTarget,
  defaultNewChatComputer,
  defaultNewChatFolderIndex,
  filterNewChatFolders,
  moveHighlight,
  nextConnectedComputer,
  readLastNewChatTarget,
  writeLastNewChatTarget,
} from "./newChatPicker.logic";
import { registerNewChatPickerOpener } from "./newChatPickerStore";

/** A function that never changes identity and always runs the latest `fn`. */
function useLatestCallback<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: Args) => ref.current(...args), []);
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The computers in the computer menu's order, connected or not. */
function useNewChatComputers() {
  const machines = useSwitcherMachines();
  return useMemo(() => {
    const ordered = groupSwitcherMachines(machines).flatMap((group) => group.items);
    return ordered.map((machine) => ({
      id: machine.id as string,
      name: machine.name,
      connected: machine.connectionState === "connected",
      kind: machine.kind,
      connectionState: machine.connectionState,
    }));
  }, [machines]);
}

/** The folder of the chat the person wrote in last (not an assistant's). */
function useLastChatTarget(): NewChatTarget | null {
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  return useMemo(() => {
    let best: { at: string; environmentId: string; projectId: ProjectId } | null = null;
    for (const thread of threads) {
      if (thread.archivedAt !== null || thread.latestUserMessageAt === null) continue;
      if (isAssistantProjectId(thread.projectId)) continue;
      if (best === null || thread.latestUserMessageAt > best.at) {
        best = {
          at: thread.latestUserMessageAt,
          environmentId: thread.environmentId,
          projectId: thread.projectId,
        };
      }
    }
    if (best === null) return null;
    const project = projects.find(
      (item) => item.environmentId === best.environmentId && item.id === best.projectId,
    );
    return project ? { environmentId: best.environmentId, cwd: project.cwd } : null;
  }, [projects, threads]);
}

interface StartableFolder extends NewChatFolder {
  readonly projectId: ProjectId | null;
}

/** The home folder first, then every folder chatted in there, newest first. */
function useStartableFolders(environmentId: string | null): ReadonlyArray<StartableFolder> {
  const env = environmentId as EnvironmentId | null;
  const home = useHomeFolderPath(env);
  const recent = useRecentFolders(env, home);
  return useMemo(() => {
    // Until the computer says where its home is, its "Home folder" project
    // would show twice: it is the first row already.
    const homeProject = recent.find((project) => project.name === HOME_FOLDER_TITLE);
    return [
      {
        key: "home",
        name: HOME_FOLDER_TITLE,
        cwd: home ?? homeProject?.cwd ?? null,
        projectId: null,
      },
      ...recent
        .filter((project) => project.name !== HOME_FOLDER_TITLE)
        .map((project) => ({
          key: `project:${project.id}`,
          name: project.name,
          cwd: project.cwd,
          projectId: project.id,
        })),
    ];
  }, [home, recent]);
}

/** Starts the chat where the picker says and remembers the choice. */
function useStartNewChat() {
  const { handleNewThread } = useNewThreadHandler();
  const { chatIn } = useChatOnComputer();
  const switchEnvironment = useSwitchEnvironment();
  const { isMobile, setOpenMobile } = useSidebar();
  const run = async (environmentId: string, folder: StartableFolder | { cwd: string }) => {
    const env = environmentId as EnvironmentId;
    if (isMobile) setOpenMobile(false);
    writeLastNewChatTarget({ environmentId, cwd: folder.cwd });
    // Another Uno Work version in the browser: that computer's own page.
    if (switchReloadUrl(currentStaleBundlePage(), readStaleBundleMachine(env))) {
      switchEnvironment(env);
      return;
    }
    try {
      if ("projectId" in folder && folder.projectId !== null) {
        await handleNewThread(scopeProjectRef(env, folder.projectId), { envMode: "local" });
      } else {
        const home = "key" in folder && folder.key === "home";
        await chatIn(env, home ? null : folder.cwd);
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't start the chat",
        description: errorText(error),
      });
    }
  };
  return useLatestCallback(run);
}

/**
 * ⌘N with no picker button on screen (sidebar hidden, another layout): the
 * chat starts at once where the picker would have highlighted.
 */
export function useStartNewChatAtDefault(): () => Promise<boolean> {
  const computers = useNewChatComputers();
  const lastChat = useLastChatTarget();
  const { environmentId: activeEnvironmentId } = useActiveMachine();
  const start = useStartNewChat();
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const run = async () => {
    const last = readLastNewChatTarget();
    const environmentId = defaultNewChatComputer({
      computers,
      last,
      lastChat,
      activeEnvironmentId,
    });
    if (environmentId === null) return false;
    const target = [last, lastChat].find((item) => item?.environmentId === environmentId);
    const project =
      target?.cwd != null
        ? projects.find(
            (item) =>
              item.environmentId === environmentId &&
              !isAssistantProjectId(item.id) &&
              normalizeProjectPathForComparison(item.cwd) ===
                normalizeProjectPathForComparison(target.cwd!),
          )
        : undefined;
    await start(
      environmentId,
      project
        ? {
            key: `project:${project.id}`,
            name: project.name,
            cwd: project.cwd,
            projectId: project.id,
          }
        : { key: "home", name: HOME_FOLDER_TITLE, cwd: null, projectId: null },
    );
    return true;
  };
  return useLatestCallback(run);
}

function NewChatPickerPanel({
  onClose,
  onAnotherFolder,
}: {
  onClose: () => void;
  /** "Another folder…" — the folder dialog for this computer (owned by the button). */
  onAnotherFolder: (environmentId: string) => void;
}) {
  const computers = useNewChatComputers();
  const lastChat = useLastChatTarget();
  const { environmentId: activeEnvironmentId } = useActiveMachine();
  const last = useMemo(() => readLastNewChatTarget(), []);
  const [computerId, setComputerId] = useState<string | null>(() =>
    defaultNewChatComputer({ computers, last, lastChat, activeEnvironmentId }),
  );
  // The computers answer a moment after the page opens: settle on one then.
  useEffect(() => {
    if (computerId !== null) return;
    setComputerId(defaultNewChatComputer({ computers, last, lastChat, activeEnvironmentId }));
  }, [activeEnvironmentId, computerId, computers, last, lastChat]);
  const folders = useStartableFolders(computerId);
  const [query, setQuery] = useState("");
  const shown = filterNewChatFolders(folders, query);
  const defaultIndex = defaultNewChatFolderIndex({
    environmentId: computerId,
    folders,
    last,
    lastChat,
  });
  // null — follow the default (the folders load after the picker opens).
  const [picked, setPicked] = useState<number | null>(null);
  const highlighted = Math.min(
    picked ?? (query.trim().length > 0 ? 0 : defaultIndex),
    Math.max(shown.length - 1, 0),
  );
  const start = useStartNewChat();
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${highlighted}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  const go = (folder: StartableFolder | undefined) => {
    if (!folder || computerId === null) return;
    onClose();
    void start(computerId, folder);
  };
  const switchComputer = (id: string | null) => {
    if (id === null || id === computerId) return;
    setComputerId(id);
    setPicked(null);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setPicked(moveHighlight(highlighted, shown.length, event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      go(shown[highlighted]);
      return;
    }
    if (event.key === "Tab" && computers.filter((c) => c.connected).length > 1) {
      event.preventDefault();
      switchComputer(nextConnectedComputer(computers, computerId, event.shiftKey ? -1 : 1));
    }
  };

  const several = computers.length > 1;
  const current = computers.find((computer) => computer.id === computerId) ?? null;

  return (
    <div className="flex w-full flex-col" data-testid="new-chat-picker">
      <div className="flex min-w-0 flex-wrap items-center gap-1 px-2 pt-2 pb-1.5">
        <span className="mr-0.5 shrink-0 text-xs text-muted-foreground">On</span>
        {several ? (
          computers.map((computer) => {
            const Icon = MACHINE_KIND_ICON[computer.kind];
            const selected = computer.id === computerId;
            return (
              <button
                key={computer.id}
                type="button"
                disabled={!computer.connected}
                aria-pressed={selected}
                title={computer.connected ? computer.name : `${computer.name} — not connected`}
                onClick={() => switchComputer(computer.id)}
                data-testid="new-chat-picker-computer"
                className={cn(
                  "inline-flex h-6 min-w-0 max-w-40 cursor-pointer items-center gap-1.5 rounded-md border px-1.5 text-xs outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-45",
                  selected
                    ? "border-border bg-accent font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    STATUS_DOT_CLASS[computer.connectionState],
                  )}
                />
                <Icon className="size-3.5 shrink-0" />
                <span className="truncate">{computer.name}</span>
              </button>
            );
          })
        ) : (
          <span className="truncate text-xs font-medium">{current?.name ?? "This computer"}</span>
        )}
      </div>
      <div className="flex items-center gap-2 border-y border-border/60 px-2.5">
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          // biome-ignore lint/a11y/noAutofocus: the picker opens to be typed in.
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPicked(null);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search folders…"
          aria-label="Search folders"
          aria-controls="new-chat-picker-folders"
          aria-activedescendant={shown[highlighted] ? `new-chat-folder-${highlighted}` : undefined}
          data-testid="new-chat-picker-search"
          className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-hidden placeholder:text-muted-foreground/70"
        />
      </div>
      <ul
        ref={listRef}
        id="new-chat-picker-folders"
        role="listbox"
        aria-label="Folders"
        className="max-h-64 overflow-y-auto p-1"
      >
        {shown.length === 0 ? (
          <li className="px-2 py-1.5 text-xs text-muted-foreground">No matching folders.</li>
        ) : (
          shown.map((folder, index) => {
            const on = index === highlighted;
            return (
              <li
                key={folder.key}
                id={`new-chat-folder-${index}`}
                role="option"
                aria-selected={on}
                data-index={index}
                data-testid={`new-chat-picker-folder-${folder.key.replace(/[:]/g, "-")}`}
                onMouseMove={() => {
                  if (!on) setPicked(index);
                }}
                onClick={() => go(folder)}
                className={cn(
                  "flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-sm",
                  on && "bg-accent text-foreground",
                )}
              >
                {folder.key === "home" ? (
                  <HouseIcon className="size-4 shrink-0 text-muted-foreground" />
                ) : computerId !== null && folder.cwd ? (
                  <ProjectFavicon
                    environmentId={computerId as EnvironmentId}
                    cwd={folder.cwd}
                    className="size-4 shrink-0"
                  />
                ) : (
                  <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                {on ? <Kbd className="h-4.5 min-w-4.5 text-[10px]">↵</Kbd> : null}
              </li>
            );
          })
        )}
      </ul>
      <div className="border-t border-border/60 p-1">
        <button
          type="button"
          onClick={() => {
            if (computerId !== null) onAnotherFolder(computerId);
          }}
          disabled={computerId === null}
          className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          data-testid="new-chat-picker-another-folder"
        >
          <FolderOpenIcon className="size-4 shrink-0" />
          Another folder…
        </button>
      </div>
      <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-border/60 px-2.5 py-1.5 text-[11px] text-muted-foreground">
        <span>↵ start</span>
        <span>↑↓ folder</span>
        {computers.filter((c) => c.connected).length > 1 ? <span>Tab computer</span> : null}
      </p>
    </div>
  );
}

/** "Another folder…": the folder dialog on the picker's computer, then the chat there. */
function AnotherFolderDialog({
  environmentId,
  onClose,
}: {
  environmentId: string;
  onClose: () => void;
}) {
  const start = useStartNewChat();
  return (
    <ChatInFolderDialog
      environmentId={environmentId as EnvironmentId}
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Work in a folder"
      description="Uno works with the files in the folder you pick."
      actionLabel={(name) => `Work in ${name}`}
      actionIcon={<FolderIcon />}
      onStart={async (cwd) => {
        await start(environmentId, { cwd });
        onClose();
      }}
    />
  );
}

/**
 * A New chat button with the picker on it. `children` — the button's icon
 * and words; the button keeps its place's look (`className`).
 */
export function NewChatPickerButton({
  label = "New chat",
  tooltip,
  testId,
  className,
  side = "bottom",
  align = "end",
  onShiftClick,
  onOpenChange,
  children,
}: {
  label?: string;
  tooltip: string;
  testId: string;
  className: string;
  side?: "bottom" | "right" | "top";
  align?: "start" | "center" | "end";
  /** ⇧-click: the old way, straight into a chat (the open chat's folder). */
  onShiftClick?: (event: ReactMouseEvent) => void;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };
  const triggerRef = useRef<HTMLButtonElement>(null);
  // "Another folder…": the popover closes, the folder dialog stays (its own state).
  const [folderOn, setFolderOn] = useState<string | null>(null);
  const setOpenRef = useRef(setOpen);
  setOpenRef.current = setOpen;

  // ⌘N opens the picker on the button the person can see.
  useEffect(
    () =>
      registerNewChatPickerOpener(() => {
        const el = triggerRef.current;
        if (!el) return false;
        const box = el.getBoundingClientRect();
        const onScreen =
          box.width > 0 && box.right > 0 && box.left < window.innerWidth && box.bottom > 0;
        if (!onScreen) return false;
        setOpenRef.current(true);
        return true;
      }),
    [],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip disabled={open}>
        <TooltipTrigger
          render={
            <PopoverTrigger
              ref={triggerRef}
              aria-label={label}
              data-testid={testId}
              className={className}
              onClick={(event) => {
                if (!event.shiftKey || !onShiftClick) return;
                (
                  event as typeof event & { preventBaseUIHandler?: () => void }
                ).preventBaseUIHandler?.();
                onShiftClick(event);
              }}
            />
          }
        >
          {children}
        </TooltipTrigger>
        <TooltipPopup side={side === "right" ? "right" : "top"}>{tooltip}</TooltipPopup>
      </Tooltip>
      <PopoverPopup side={side} align={align} className="w-80 [&_[data-slot=popover-viewport]]:p-0">
        <NewChatPickerPanel
          onClose={() => setOpen(false)}
          onAnotherFolder={(environmentId) => {
            setOpen(false);
            setFolderOn(environmentId);
          }}
        />
      </PopoverPopup>
      {folderOn !== null ? (
        <AnotherFolderDialog environmentId={folderOn} onClose={() => setFolderOn(null)} />
      ) : null}
    </Popover>
  );
}
