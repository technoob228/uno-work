/**
 * The 0.0.81 sidebar on mock data, reshaped by the three variants:
 *
 * - A (new chat / project): the header of the chat list and the list shape;
 * - B (assistant): the Uno row on top (B1), assistant chats in Pinned (B2),
 *   or no assistant at all (B3);
 * - C (Inbox): an Inbox row that opens a page (C1), a bell next to the
 *   wordmark (C2), or just a counter on Home (C3).
 *
 * In every variant a row is highlighted only when its screen is open, and
 * nothing replaces the chat list — the 0.0.80 "Home and Inbox both grey,
 * chats gone" bug has no place to happen.
 */
import {
  BellIcon,
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  CloudIcon,
  FolderGit2Icon,
  FolderOpenIcon,
  FolderTreeIcon,
  GithubIcon,
  HouseIcon,
  InboxIcon,
  LayoutGridIcon,
  LayoutTemplateIcon,
  MessagesSquareIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
} from "lucide-react";
import { useState, type ComponentType } from "react";

import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/utils";
import { ASSISTANT_ID, HOME_PROJECT_ID, type Thread } from "../data";
import { CountBadge, ProjectGlyph, TelegramGlyph, ThreadDot, rowActive, rowBase, rowIdle, statusLabel } from "../parts/bits";
import { BellPanel } from "../parts/BellPanel";
import { useInboxCounts, useProto } from "../store";

export function Sidebar() {
  const screen = useProto((s) => s.screen);
  const go = useProto((s) => s.go);
  const toast = useProto((s) => s.toast);
  const inboxVariant = useProto((s) => s.inboxVariant);
  const assistantVariant = useProto((s) => s.assistantVariant);
  const newVariant = useProto((s) => s.newVariant);
  const { unread, needsYou } = useInboxCounts();

  return (
    <aside className="flex h-full w-[264px] shrink-0 flex-col border-r border-border bg-[color-mix(in_oklab,var(--background)_96%,var(--foreground))]">
      <div className="flex h-[52px] items-center gap-2 px-4">
        <button type="button" onClick={() => go({ kind: "home" })} className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="grid size-5 shrink-0 place-items-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground">U</span>
          <span className="truncate text-sm font-semibold tracking-tight">Uno Work</span>
          <span className="shrink-0 rounded-full bg-primary/12 px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-[0.18em] text-primary">
            Alpha
          </span>
        </button>
        {inboxVariant === "c2" ? <Bell unread={unread} needsYou={needsYou} /> : null}
      </div>

      <div className="flex flex-col gap-0.5 px-2">
        <ComputerSwitcher />
        {assistantVariant === "b1" ? <UnoRow /> : null}
        <button
          type="button"
          onClick={() => go({ kind: "home" })}
          className={cn(rowBase, "h-9", screen.kind === "home" ? rowActive : rowIdle)}
          aria-current={screen.kind === "home" ? "page" : undefined}
        >
          <HouseIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate font-medium">Home</span>
          {inboxVariant === "c3" ? (
            <>
              {needsYou > 0 ? <span className="text-[11px] text-warning">{needsYou} need you</span> : null}
              <CountBadge unread={unread} needsYou={needsYou} />
            </>
          ) : (
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="size-1.5 rounded-full bg-success" /> On
            </span>
          )}
        </button>
        {inboxVariant === "c1" ? (
          <button
            type="button"
            onClick={() => go({ kind: "inbox" })}
            className={cn(rowBase, "h-9", screen.kind === "inbox" ? rowActive : rowIdle)}
            aria-current={screen.kind === "inbox" ? "page" : undefined}
          >
            <InboxIcon className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate font-medium">Inbox</span>
            {needsYou > 0 ? <span className="text-[11px] text-warning">{needsYou} need you</span> : null}
            <CountBadge unread={unread} needsYou={needsYou} />
          </button>
        ) : null}
        <button type="button" onClick={() => toast("My Uno is not part of this prototype")} className={cn(rowBase, "h-9", rowIdle)}>
          <LayoutGridIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate font-medium">My Uno</span>
        </button>
        <ModeSwitch />
      </div>

      <Pinned />

      <div className="flex min-h-0 flex-1 flex-col border-t border-border/50 px-2 pt-1.5">
        {newVariant === "a1" ? <HeaderA1 /> : newVariant === "a2" ? <HeaderPlain /> : <HeaderPlain grouped />}
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">{newVariant === "a3" ? <GroupedList /> : <FlatList />}</div>
      </div>

      <div className="flex items-center gap-0.5 border-t border-border/60 px-2 py-1.5">
        <button
          type="button"
          aria-label="Settings"
          title="Settings"
          onClick={() =>
            assistantVariant === "b3" ? go({ kind: "settings-telegram" }) : toast("Settings is not part of this prototype")
          }
          className={cn(
            "inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground [&_svg]:size-4",
            screen.kind === "settings-telegram" && "bg-sidebar-row-active text-foreground",
          )}
        >
          <SettingsIcon />
        </button>
        <span className="ml-auto pr-1 text-[10px] text-muted-foreground/70">0.0.81 · prototype</span>
      </div>
    </aside>
  );
}

function Bell({ unread, needsYou }: { unread: number; needsYou: number }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Notifications"
            className={cn(
              "relative inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-foreground",
              open && "bg-sidebar-row-active text-foreground",
            )}
          >
            <BellIcon className="size-4" />
            {unread > 0 ? (
              <CountBadge unread={unread} needsYou={needsYou} className="absolute -top-0.5 -right-0.5 min-w-4 px-0.5 text-[9px] leading-4" />
            ) : null}
          </button>
        }
      />
      <PopoverPopup side="bottom" align="start" sideOffset={6} className="w-[400px] p-0 [&>div]:p-0">
        <BellPanel onNavigate={() => setOpen(false)} />
      </PopoverPopup>
    </Popover>
  );
}

function ComputerSwitcher() {
  return (
    <div className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5">
      <span className="size-2 rounded-full bg-success" />
      <CloudIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">misha-work</span>
        <span className="block truncate text-[11px] text-muted-foreground">Cloud computer · Plus</span>
      </span>
      <ChevronsUpDownIcon className="size-3.5 text-muted-foreground" />
    </div>
  );
}

/** B1: the one assistant, always first, above Home. */
function UnoRow() {
  const screen = useProto((s) => s.screen);
  const go = useProto((s) => s.go);
  const uno = useProto((s) => s.threads.find((t) => t.id === ASSISTANT_ID));
  const active = screen.kind === "chat" && screen.threadId === ASSISTANT_ID;
  if (!uno) return null;
  return (
    <button
      type="button"
      onClick={() => go({ kind: "chat", threadId: ASSISTANT_ID })}
      className={cn(rowBase, "h-10", active ? rowActive : rowIdle)}
    >
      <span className="relative grid size-6 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary to-violet-500 text-[10px] font-bold text-white">
        U
        <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-success ring-2 ring-background" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">Uno</span>
        <span className="block truncate text-[10.5px] text-muted-foreground">Your assistant · always on</span>
      </span>
      {(uno.connectors ?? []).includes("telegram") ? <TelegramGlyph /> : null}
      {uno.unseen && !active ? <span className="size-1.5 rounded-full bg-primary" /> : null}
    </button>
  );
}

const MODES: ReadonlyArray<{ label: string; Icon: ComponentType<{ className?: string }> }> = [
  { label: "Chats", Icon: MessagesSquareIcon },
  { label: "Files", Icon: FolderTreeIcon },
  { label: "Apps", Icon: LayoutGridIcon },
];

function ModeSwitch() {
  const toast = useProto((s) => s.toast);
  return (
    <div className="mt-1 mb-1 grid grid-cols-3 gap-0.5 rounded-lg bg-muted/70 p-0.5">
      {MODES.map(({ label, Icon }, i) => (
        <button
          key={label}
          type="button"
          onClick={() => (i === 0 ? undefined : toast(`${label} is not part of this prototype`))}
          className={cn(
            "flex h-7 items-center justify-center gap-1.5 rounded-md text-xs font-medium",
            i === 0 ? "bg-background text-foreground shadow-xs ring-1 ring-border/60" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="size-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}

function Pinned() {
  const threads = useProto((s) => s.threads);
  const assistantVariant = useProto((s) => s.assistantVariant);
  const pinned = threads.filter((t) => t.pinned && visibleThread(t, assistantVariant) && !(assistantVariant === "b1" && t.id === ASSISTANT_ID));
  return (
    <div className="px-2 pt-2 pb-1">
      <div className="flex items-center px-2 pb-0.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground/80">Pinned</div>
      {pinned.length === 0 ? (
        <p className="px-2 pb-1 text-[11px] leading-snug text-muted-foreground/70">Pin chats, apps, files and links.</p>
      ) : (
        pinned.map((t) => <ThreadRow key={t.id} thread={t} pinnedRow />)
      )}
    </div>
  );
}

export function visibleThread(t: Thread, v: string): boolean {
  if (v === "b3" && t.id === ASSISTANT_ID) return false;
  if (v === "b1" && t.id === ASSISTANT_ID) return false;
  return true;
}

function ThreadRow({ thread, pinnedRow, indent }: { thread: Thread; pinnedRow?: boolean; indent?: boolean }) {
  const screen = useProto((s) => s.screen);
  const go = useProto((s) => s.go);
  const assistantVariant = useProto((s) => s.assistantVariant);
  const active = screen.kind === "chat" && screen.threadId === thread.id;
  const label = statusLabel(thread);
  const fromUno = thread.spawnedBy && assistantVariant !== "b3";
  return (
    <button
      type="button"
      onClick={() => go({ kind: "chat", threadId: thread.id })}
      className={cn(rowBase, indent && "pl-7", active ? rowActive : rowIdle)}
    >
      {thread.assistant && assistantVariant === "b2" ? (
        <BotIcon className="size-3.5 shrink-0 text-primary" />
      ) : pinnedRow ? (
        <PinIcon className="size-3 shrink-0" />
      ) : (
        <ThreadDot thread={thread} />
      )}
      <span className={cn("min-w-0 flex-1 truncate", thread.unseen && "font-medium text-foreground")}>{thread.title}</span>
      {fromUno ? (
        <span title="Started by Uno" className="shrink-0 rounded bg-primary/10 px-1 text-[9px] font-medium text-primary">
          Uno
        </span>
      ) : null}
      {thread.assistant && (thread.connectors ?? []).includes("telegram") && assistantVariant === "b2" ? <TelegramGlyph /> : null}
      <span className={cn("shrink-0 text-[11px]", label.tone)}>{label.text}</span>
    </button>
  );
}

function SearchBox() {
  return (
    <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-sm text-muted-foreground">
      <SearchIcon className="size-4" />
      Search
    </div>
  );
}

/** A1: one "New" split button. Click = a chat in the home folder; ▾ = the rest. */
function HeaderA1() {
  const newChat = useProto((s) => s.newChat);
  const projects = useProto((s) => s.projects);
  const openNewProject = useProto((s) => s.openNewProject);
  return (
    <div className="flex items-center gap-1 px-1 pb-1">
      <SearchBox />
      <div className="flex shrink-0 items-stretch overflow-hidden rounded-md bg-primary text-primary-foreground shadow-xs">
        <button type="button" onClick={() => newChat()} className="flex h-7 items-center gap-1.5 px-2 text-xs font-medium hover:bg-white/10">
          <SquarePenIcon className="size-3.5" /> New
        </button>
        <Menu>
          <MenuTrigger
            render={
              <button type="button" aria-label="More ways to start" className="flex h-7 items-center border-l border-white/20 px-1.5 hover:bg-white/10">
                <ChevronDownIcon className="size-3.5" />
              </button>
            }
          />
          <MenuPopup align="end" className="min-w-64">
            <MenuItem onClick={() => newChat()}>
              <SquarePenIcon />
              <span className="flex-1">New chat</span>
              <span className="text-xs text-muted-foreground">in Home folder</span>
            </MenuItem>
            <MenuGroup>
              <MenuGroupLabel>New chat in a project</MenuGroupLabel>
              {projects
                .filter((p) => p.id !== HOME_PROJECT_ID)
                .map((p) => (
                  <MenuItem key={p.id} onClick={() => newChat(p.id)}>
                    <ProjectGlyph project={p} className="size-4 text-[8px]" />
                    <span className="flex-1">{p.name}</span>
                  </MenuItem>
                ))}
            </MenuGroup>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>New project</MenuGroupLabel>
              <MenuItem onClick={() => openNewProject(true)}>
                <FolderOpenIcon />
                From a folder on this computer
              </MenuItem>
              <MenuItem onClick={() => openNewProject(true)}>
                <PlusIcon />
                Empty project
              </MenuItem>
              <MenuItem onClick={() => openNewProject(true)}>
                <GithubIcon />
                From GitHub
              </MenuItem>
              <MenuItem onClick={() => openNewProject(true)}>
                <LayoutTemplateIcon />
                From a template
              </MenuItem>
            </MenuGroup>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}

/** A2 and A3: only ✎ — a chat in the home folder. No "add project" icon. */
function HeaderPlain({ grouped }: { grouped?: boolean }) {
  const newChat = useProto((s) => s.newChat);
  return (
    <div className="flex items-center gap-1 px-1 pb-1">
      <SearchBox />
      <button
        type="button"
        onClick={() => newChat()}
        title="New chat in your home folder"
        className="inline-flex size-7 items-center justify-center rounded-md bg-sidebar-control-surface text-muted-foreground hover:text-foreground"
      >
        <SquarePenIcon className="size-3.5" />
      </button>
      {grouped ? null : null}
    </div>
  );
}

function FlatList() {
  const threads = useProto((s) => s.threads);
  const assistantVariant = useProto((s) => s.assistantVariant);
  const list = threads.filter((t) => !t.pinned && visibleThread(t, assistantVariant));
  return (
    <ul className="flex flex-col gap-px">
      {list.map((t) => (
        <li key={t.id}>
          <ThreadRow thread={t} />
        </li>
      ))}
    </ul>
  );
}

/** A3: chats grouped under their project; each project has its own +. */
function GroupedList() {
  const threads = useProto((s) => s.threads);
  const projects = useProto((s) => s.projects);
  const screen = useProto((s) => s.screen);
  const go = useProto((s) => s.go);
  const newChat = useProto((s) => s.newChat);
  const assistantVariant = useProto((s) => s.assistantVariant);
  const [closed, setClosed] = useState<ReadonlyArray<string>>([]);
  return (
    <div className="flex flex-col gap-1">
      {projects.map((p) => {
        const list = threads.filter((t) => t.projectId === p.id && !t.pinned && visibleThread(t, assistantVariant));
        const isClosed = closed.includes(p.id);
        const active = screen.kind === "project" && screen.projectId === p.id;
        return (
          <div key={p.id}>
            <div className={cn("group flex h-8 items-center gap-1.5 rounded-lg pr-1 pl-1", active ? rowActive : "hover:bg-sidebar-row-hover")}>
              <button
                type="button"
                onClick={() => setClosed(isClosed ? closed.filter((c) => c !== p.id) : [...closed, p.id])}
                className="grid size-4 place-items-center text-muted-foreground"
              >
                <ChevronRightIcon className={cn("size-3 transition-transform", !isClosed && "rotate-90")} />
              </button>
              <button type="button" onClick={() => go({ kind: "project", projectId: p.id })} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <ProjectGlyph project={p} className="size-4.5" />
                <span className="truncate text-[13px] font-medium text-foreground">{p.name}</span>
                <span className="text-[11px] text-muted-foreground/70">{list.length}</span>
              </button>
              <button
                type="button"
                title={`New chat in ${p.name}`}
                onClick={() => newChat(p.id)}
                className="grid size-6 place-items-center rounded-md text-muted-foreground opacity-60 hover:bg-background hover:text-foreground group-hover:opacity-100"
              >
                <PlusIcon className="size-3.5" />
              </button>
            </div>
            {!isClosed ? (
              <ul className="flex flex-col gap-px">
                {list.slice(0, 4).map((t) => (
                  <li key={t.id}>
                    <ThreadRow thread={t} indent />
                  </li>
                ))}
                {list.length === 0 ? <li className="py-1 pl-8 text-[11px] text-muted-foreground/60">No chats yet</li> : null}
              </ul>
            ) : null}
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => go({ kind: "new-project" })}
        className={cn(rowBase, "mt-1 border border-dashed border-border", screen.kind === "new-project" ? rowActive : rowIdle)}
      >
        <FolderGit2Icon className="size-4" /> New project
      </button>
    </div>
  );
}
