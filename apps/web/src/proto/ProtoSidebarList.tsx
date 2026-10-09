/**
 * The chat list of the multi-computer sidebar (variants G and C), between
 * the Uno row and the Done shelf of the real sidebar. Rows are the real
 * sidebar rows (`renderRow`); this file decides grouping, the computer
 * filter and the "project · computer" line under the title.
 *
 * Sidebar v2 (Misha 09.10 ~22:00):
 * - all computers together by default;
 * - group by any of status / computer / project, in the order picked
 *   (chatGrouping.ts); none = one list, newest first;
 * - show all computers, one, or the ones picked;
 * - the setting is a quiet sliders icon next to "Chats", not a "View" button.
 * - Each chat says what the groups above it don't: its project, its computer.
 * - One project on two computers (same repository / shared Uno folder) is one
 *   project: its chats from both computers sit together.
 */
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleDashedIcon,
  CircleIcon,
  CloudIcon,
  FolderIcon,
  HomeIcon,
  LaptopIcon,
  PlusIcon,
  SlidersHorizontalIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { openNewProject } from "../navigation/newProjectStore";
import { useStore } from "../store";
import type { Project, SidebarThreadSummary } from "../types";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import {
  isHomeProject,
  logicalKeyOf,
  machineOrder,
  machineKind,
  machineLabel,
  NO_PROJECT,
  NO_PROJECT_KEY,
  placeParts,
  type PlaceParts,
} from "./protoPlace";
import { useComputerNames } from "./computerNames";
import {
  chatStatusOf,
  effectiveLevels,
  GROUP_LEVELS,
  groupChats,
  levelsLabel,
  moveLevel,
  STATUS_NAME,
  toggleComputer,
  toggleLevel,
  type ChatGroupNode,
  type ChatStatus,
  type GroupLevel,
} from "./chatGrouping";
import { useProtoStore } from "./protoState";

type Mark = "approval" | "input" | "your-turn" | "failed" | "working" | null;

export interface ProtoRowOptions {
  readonly nested?: boolean;
  readonly subtitle?: ReactNode;
  /** A Done / Snoozed chat: the sidebar's own history row. */
  readonly section?: "settled" | "snoozed";
}

interface ProtoSidebarListProps {
  /** Live chats (not Done / Snoozed, not under Uno), newest activity first. */
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
  /** Projects in scope (every computer when joined), the assistant's left out. */
  readonly projects: ReadonlyArray<Project>;
  /** Done and Snoozed chats (one "Done" shelf without Dev mode). */
  readonly doneThreads: ReadonlyArray<SidebarThreadSummary>;
  readonly renderRow: (thread: SidebarThreadSummary, options: ProtoRowOptions) => ReactNode;
  readonly markOf: (thread: SidebarThreadSummary) => Mark;
  readonly renderMark: (mark: Mark) => ReactNode;
  readonly onNewChatIn: (project: Project) => void;
}

const URGENT: Record<Exclude<Mark, null>, number> = {
  approval: 0,
  input: 0,
  "your-turn": 1,
  failed: 2,
  working: 3,
};

/** A folded group shows a dot when a chat in it waits or works — "Your turn" stays on the chats. */
function mostUrgent(marks: ReadonlyArray<Mark>): Mark {
  let best: Mark = null;
  for (const mark of marks) {
    if (mark === null || mark === "your-turn") continue;
    if (best === null || URGENT[mark] < URGENT[best]) best = mark;
  }
  return best;
}

// ── One project across computers ─────────────────────────────────────────

interface LogicalProject {
  readonly key: string;
  readonly name: string;
  readonly home: boolean;
  /** The folders — one per computer it is on. */
  readonly members: Project[];
  /** Computers it is on, in machineOrder(). */
  readonly computers: string[];
}

const threadKey = (thread: Pick<SidebarThreadSummary, "environmentId" | "projectId">) =>
  `${thread.environmentId}:${thread.projectId}`;
const chatKey = (thread: Pick<SidebarThreadSummary, "environmentId" | "id">) =>
  `${thread.environmentId}:${thread.id}`;

function useLogicalProjects(
  projects: ReadonlyArray<Project>,
  threads: ReadonlyArray<SidebarThreadSummary>,
) {
  // Names, kinds and Home folders of the computers: the keys below depend on them.
  const names = useComputerNames((state) => state.byId);
  return useMemo(() => {
    void names;
    const byKey = new Map<string, { name: string; home: boolean; members: Project[] }>();
    const logicalOf = new Map<string, string>();
    for (const project of projects) {
      const key = logicalKeyOf(project);
      logicalOf.set(`${project.environmentId}:${project.id}`, key);
      const home = key === NO_PROJECT_KEY;
      const entry = byKey.get(key) ?? { name: home ? NO_PROJECT : project.name, home, members: [] };
      entry.members.push(project);
      byKey.set(key, entry);
    }
    // Worked in last first; empty projects after, by name; No project last.
    const order: string[] = [];
    for (const thread of threads) {
      const key = logicalOf.get(threadKey(thread));
      if (key && !order.includes(key)) order.push(key);
    }
    const list: LogicalProject[] = [...byKey.entries()]
      .map(([key, entry]) => ({
        key,
        name: entry.name,
        home: entry.home,
        members: entry.members,
        computers: machineOrder().filter((id) =>
          entry.members.some((member) => member.environmentId === id),
        ),
      }))
      .toSorted((a, b) => {
        if (a.home !== b.home) return a.home ? 1 : -1;
        const ai = order.indexOf(a.key);
        const bi = order.indexOf(b.key);
        if (ai === -1 && bi === -1) return a.name.localeCompare(b.name);
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      });
    const projectOf = new Map<string, Project>();
    for (const project of projects)
      projectOf.set(`${project.environmentId}:${project.id}`, project);
    return {
      list,
      byKey: new Map(list.map((entry) => [entry.key, entry])),
      logicalKeyOfThread: (thread: SidebarThreadSummary) =>
        logicalOf.get(threadKey(thread)) ?? NO_PROJECT_KEY,
      projectOfThread: (thread: SidebarThreadSummary) => projectOf.get(threadKey(thread)) ?? null,
    };
  }, [names, projects, threads]);
}

// ── Small pieces ─────────────────────────────────────────────────────────

function ComputerIcon({ environmentId, className }: { environmentId: string; className?: string }) {
  return machineKind(environmentId) === "uno_box" ? (
    <CloudIcon className={className} />
  ) : (
    <LaptopIcon className={className} />
  );
}

/** "▢ brand-kit  ☁ Cloud" under a chat title — readable, not small grey. */
function PlaceLine({ parts }: { parts: PlaceParts }) {
  if (!parts.project && !parts.computer) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-2.5 text-xs leading-4 text-sidebar-foreground/85">
      {parts.project ? (
        <span className="inline-flex min-w-0 items-center gap-1">
          {parts.project === NO_PROJECT ? (
            <HomeIcon className="size-3 shrink-0 opacity-70" />
          ) : (
            <FolderIcon className="size-3 shrink-0 opacity-70" />
          )}
          <span className="truncate">{parts.project}</span>
        </span>
      ) : null}
      {parts.computer ? (
        <span className="inline-flex shrink-0 items-center gap-1">
          {parts.computerKind === "uno_box" ? (
            <CloudIcon className="size-3 shrink-0 opacity-70" />
          ) : (
            <LaptopIcon className="size-3 shrink-0 opacity-70" />
          )}
          {parts.computer}
        </span>
      ) : null}
    </span>
  );
}

/** "Cloud + MacBook" — where a project lives. */
function computersText(computers: ReadonlyArray<string>): string {
  return computers.map(machineLabel).join(" + ");
}

/** 0.0.115: Done chats fold into one "Done · N" row — here, inside the group in view. */
function DoneFold(props: {
  chats: ReadonlyArray<SidebarThreadSummary>;
  nested?: boolean;
  renderRow: ProtoSidebarListProps["renderRow"];
  /** Done chats say where they are too (critic 4). */
  subtitleOf?: (thread: SidebarThreadSummary) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (props.chats.length === 0) return null;
  return (
    <>
      <li className="list-none">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          data-testid="proto-done-fold"
          className={cn(
            "flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md pr-2 text-left text-xs text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground",
            props.nested ? "pl-8" : "pl-2.5",
          )}
        >
          Done · {props.chats.length}
          <ChevronDownIcon className={cn("size-3 transition-transform", !open && "-rotate-90")} />
        </button>
      </li>
      {open
        ? props.chats.map((thread) => doneRow(thread, props.renderRow, props.subtitleOf))
        : null}
    </>
  );
}

function doneRow(
  thread: SidebarThreadSummary,
  renderRow: ProtoSidebarListProps["renderRow"],
  subtitleOf?: (thread: SidebarThreadSummary) => ReactNode,
) {
  return renderRow(thread, {
    section: thread.settledOverride === "settled" ? "settled" : "snoozed",
    subtitle: subtitleOf?.(thread) ?? null,
  });
}

function EmptyLine(props: {
  text: string;
  onNewChat?: (() => void) | undefined;
  nested?: boolean;
}) {
  return (
    <li
      className={cn(
        "flex list-none items-center gap-2 py-1.5 pr-2 text-xs text-muted-foreground",
        props.nested ? "pl-8" : "pl-2.5",
      )}
      data-testid="proto-empty-project"
    >
      <span className="min-w-0 flex-1 truncate">{props.text}</span>
      {props.onNewChat ? (
        <Button size="xs" variant="outline" onClick={props.onNewChat}>
          <PlusIcon className="-mx-0.5 size-3" />
          New chat
        </Button>
      ) : null}
    </li>
  );
}

/** A group's title row: folds the group; "+" starts a chat there. */
function GroupHeader(props: {
  icon: ReactNode;
  label: string;
  aside?: string | null;
  /** An empty project: a quieter label. */
  quiet?: boolean;
  /** The aside on its own line (a project on 2+ computers — never cut). */
  asideBelow?: boolean;
  count: number | string;
  folded: boolean;
  onToggle: () => void;
  onNewChat?: (() => void) | undefined;
  mark?: Mark;
  renderMark?: (mark: Mark) => ReactNode;
  /** 0 = top level; deeper groups step in. */
  depth: number;
  testId?: string;
  level: GroupLevel;
}) {
  const top = props.depth === 0;
  return (
    <li
      className={cn("group/proto-group flex list-none items-center gap-0.5", top ? "mt-2" : "")}
      data-testid={props.testId}
      data-group-level={props.level}
      data-group-depth={props.depth}
    >
      <button
        type="button"
        onClick={props.onToggle}
        aria-expanded={!props.folded}
        style={top ? undefined : { paddingLeft: `${0.625 + props.depth * 0.5}rem` }}
        className={cn(
          "flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md pr-2 text-left outline-hidden transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring",
          top
            ? "min-h-8 pl-2.5 text-sm font-medium text-foreground"
            : "h-7 text-[13px] text-sidebar-foreground/90",
          props.quiet && "font-normal text-sidebar-foreground/70",
        )}
      >
        <span
          className={cn(
            "inline-flex shrink-0 items-center justify-center text-muted-foreground",
            top ? "size-4 [&_svg]:size-4" : "size-3.5 [&_svg]:size-3.5",
          )}
        >
          {props.icon}
        </span>
        {props.aside && props.asideBelow ? (
          <span className="flex min-w-0 flex-col py-1">
            <span className="min-w-0 truncate">{props.label}</span>
            <span className="min-w-0 truncate text-xs font-normal text-sidebar-foreground/75">
              {props.aside}
            </span>
          </span>
        ) : (
          <>
            <span
              className="min-w-0 shrink-0 truncate"
              style={{ maxWidth: props.aside ? "62%" : undefined }}
            >
              {props.label}
            </span>
            {props.aside ? (
              <span className="min-w-0 shrink truncate text-xs font-normal text-sidebar-foreground/75">
                {props.aside}
              </span>
            ) : null}
          </>
        )}
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5">
          {props.folded && props.mark && props.renderMark ? props.renderMark(props.mark) : null}
          <span className="text-xs font-normal text-muted-foreground tabular-nums">
            {props.count === 0 ? "" : props.count}
          </span>
          <ChevronDownIcon
            className={cn(
              "size-3.5 text-muted-foreground transition-transform",
              props.folded && "-rotate-90",
            )}
          />
        </span>
      </button>
      {props.onNewChat ? (
        <button
          type="button"
          onClick={props.onNewChat}
          aria-label={`New chat in ${props.label}`}
          title={`New chat in ${props.label}`}
          className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-sidebar-row-hover hover:text-foreground focus-visible:opacity-100 group-hover/proto-group:opacity-100 max-md:opacity-100"
        >
          <PlusIcon className="size-3.5" />
        </button>
      ) : (
        <span className="size-7 shrink-0" aria-hidden />
      )}
    </li>
  );
}

/** The icon of a status group: the same marks the rows show. */
function StatusIcon(props: { status: ChatStatus; renderMark: (mark: Mark) => ReactNode }) {
  switch (props.status) {
    case "needs-you":
      return <>{props.renderMark("approval")}</>;
    case "failed":
      return <>{props.renderMark("failed")}</>;
    case "your-turn":
      return <span aria-hidden className="size-2 rounded-full bg-emerald-500" />;
    case "working":
      return <CircleDashedIcon className="text-sky-500" />;
    case "done":
      return <CheckIcon />;
    default:
      return <CircleIcon className="opacity-60" />;
  }
}

// ── The sliders icon: group levels and the computer filter ──────────────

const LEVEL_ICON: Record<GroupLevel, ReactNode> = {
  status: <CircleDashedIcon />,
  computer: <LaptopIcon />,
  project: <FolderIcon />,
};

function MenuLabel(props: { children: ReactNode }) {
  return <p className="px-1 pb-1 text-xs font-medium text-muted-foreground">{props.children}</p>;
}

function ViewMenu(props: {
  /** Computers with chats or folders in view (2+ = the filter shows). */
  computers: ReadonlyArray<string>;
  /** The levels that apply now (Computer drops out with one computer in view). */
  effective: ReadonlyArray<GroupLevel>;
  filtered: boolean;
}) {
  const levels = useProtoStore((state) => state.levels);
  const setLevels = useProtoStore((state) => state.setLevels);
  const picked = useProtoStore((state) => state.computers);
  const setComputers = useProtoStore((state) => state.setComputers);
  const multi = props.computers.length >= 2;
  // Ticked levels in their order, then the others.
  const rows = [
    ...levels,
    ...GROUP_LEVELS.map((item) => item.id).filter((id) => !levels.includes(id)),
  ];
  const summary = `Grouped: ${levelsLabel(props.effective)}${props.filtered ? " · some computers" : ""}`;
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              data-testid="proto-view-button"
              aria-label={`Group and filter chats — ${summary}`}
              className="relative -my-1 inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-hidden transition-colors hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-sidebar-row-hover data-[popup-open]:text-foreground"
            />
          }
        >
          <SlidersHorizontalIcon className="size-3.5" />
          {props.filtered ? (
            <span
              aria-hidden
              className="absolute top-1 right-1 size-1.5 rounded-full bg-primary"
              data-testid="proto-view-filtered"
            />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="bottom">{summary}</TooltipPopup>
      </Tooltip>
      <PopoverPopup
        side="bottom"
        align="end"
        className="w-[min(16rem,calc(100vw-1.5rem))]"
        data-testid="proto-view-popup"
      >
        <div className="-mx-1 -my-1 flex max-h-[calc(var(--available-height)-2.5rem)] flex-col gap-3 overflow-y-auto">
          <div data-testid="proto-levels">
            <MenuLabel>Group chats by</MenuLabel>
            <ul className="flex flex-col">
              {rows.map((id) => {
                const on = levels.includes(id);
                const index = levels.indexOf(id);
                const unavailable = id === "computer" && !multi;
                const name = GROUP_LEVELS.find((item) => item.id === id)!.name;
                return (
                  <li
                    key={id}
                    className="flex h-8 items-center gap-1 rounded-md pr-0.5 hover:bg-accent/60"
                    data-testid={`proto-level-${id}`}
                  >
                    <label
                      className={cn(
                        "flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-1.5 text-sm [&_svg]:size-3.5 [&_svg]:shrink-0",
                        unavailable && "cursor-default opacity-60",
                      )}
                    >
                      <Checkbox
                        checked={on}
                        disabled={unavailable}
                        onCheckedChange={() => setLevels(toggleLevel(levels, id))}
                        aria-label={`Group by ${name}`}
                      />
                      <span className="text-muted-foreground">{LEVEL_ICON[id]}</span>
                      <span className="min-w-0 truncate">{name}</span>
                      {on && levels.length > 1 ? (
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {index + 1}
                        </span>
                      ) : null}
                      {unavailable ? (
                        <span className="truncate text-xs text-muted-foreground">
                          with 2+ computers
                        </span>
                      ) : null}
                    </label>
                    {on && levels.length > 1 ? (
                      <>
                        <button
                          type="button"
                          disabled={index === 0}
                          onClick={() => setLevels(moveLevel(levels, id, -1))}
                          aria-label={`Move ${name} up`}
                          className="inline-flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
                        >
                          <ArrowUpIcon className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={index === levels.length - 1}
                          onClick={() => setLevels(moveLevel(levels, id, 1))}
                          aria-label={`Move ${name} down`}
                          className="inline-flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
                        >
                          <ArrowDownIcon className="size-3.5" />
                        </button>
                      </>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <p className="px-1 pt-1 text-xs text-muted-foreground" data-testid="proto-levels-label">
              {props.effective.length === 0
                ? "Nothing ticked: one list, newest first."
                : `Now: ${levelsLabel(props.effective)}`}
            </p>
          </div>
          {multi ? (
            <div data-testid="proto-filter-computer" className="border-t border-border/70 pt-3">
              <MenuLabel>Show chats from</MenuLabel>
              <ul className="flex flex-col">
                <li className="flex h-8 items-center rounded-md hover:bg-accent/60">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-1.5 text-sm">
                    <Checkbox
                      checked={picked === null}
                      onCheckedChange={() => setComputers(null)}
                      aria-label="All computers"
                    />
                    All computers
                  </label>
                </li>
                {props.computers.map((id) => {
                  const on = picked === null || picked.includes(id);
                  const solo = picked !== null && picked.length === 1 && picked[0] === id;
                  return (
                    <li
                      key={id}
                      className="group/computer flex h-8 items-center gap-1 rounded-md pr-0.5 hover:bg-accent/60"
                    >
                      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-1.5 text-sm [&_svg]:size-3.5 [&_svg]:shrink-0">
                        <Checkbox
                          checked={on}
                          onCheckedChange={() =>
                            setComputers(toggleComputer(picked, id, props.computers))
                          }
                          aria-label={machineLabel(id)}
                        />
                        <span className="text-muted-foreground">
                          <ComputerIcon environmentId={id} />
                        </span>
                        <span className="min-w-0 truncate">{machineLabel(id)}</span>
                      </label>
                      {solo ? null : (
                        <button
                          type="button"
                          onClick={() => setComputers([id])}
                          aria-label={`Only ${machineLabel(id)}`}
                          className="h-6 shrink-0 cursor-pointer rounded px-1.5 text-xs text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/computer:opacity-100 max-md:opacity-100"
                        >
                          Only
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              <p className="px-1 pt-1 text-xs leading-snug text-muted-foreground">
                A project on several computers (same git repository) is one project.
              </p>
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** What the list is narrowed to, each with ✕. */
function FilterChips(props: {
  picked: ReadonlyArray<string> | null;
  projects: Map<string, LogicalProject>;
}) {
  const projectFilter = useProtoStore((state) => state.project);
  const setProjectFilter = useProtoStore((state) => state.setProjectFilter);
  const setComputers = useProtoStore((state) => state.setComputers);
  const chips: Array<{ key: string; icon: ReactNode; label: string; clear: () => void }> = [];
  if (projectFilter !== null) {
    const entry = props.projects.get(projectFilter);
    chips.push({
      key: "p",
      icon: projectFilter === NO_PROJECT_KEY ? <HomeIcon /> : <FolderIcon />,
      label: entry?.name ?? (projectFilter === NO_PROJECT_KEY ? NO_PROJECT : "Project"),
      clear: () => setProjectFilter(null),
    });
  }
  if (props.picked !== null) {
    chips.push({
      key: "c",
      icon:
        props.picked.length === 1 ? (
          <ComputerIcon environmentId={props.picked[0]!} />
        ) : (
          <LaptopIcon />
        ),
      label: props.picked.map(machineLabel).join(", "),
      clear: () => setComputers(null),
    });
  }
  if (chips.length === 0) return null;
  return (
    <li className="flex list-none flex-wrap gap-1 px-2 pb-1" data-testid="proto-filter-chips">
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          onClick={chip.clear}
          aria-label={`Show all, not only ${chip.label}`}
          className="inline-flex h-7 max-w-full cursor-pointer items-center gap-1.5 rounded-full border border-border bg-background/70 pr-2 pl-2.5 text-xs font-medium text-foreground hover:bg-sidebar-row-hover [&_svg]:size-3.5 [&_svg]:shrink-0"
        >
          <span className="text-muted-foreground">{chip.icon}</span>
          <span className="truncate">Only {chip.label}</span>
          <XIcon className="text-muted-foreground" />
        </button>
      ))}
    </li>
  );
}

// ── The list ─────────────────────────────────────────────────────────────

export function ProtoSidebarList(props: ProtoSidebarListProps) {
  const variant = useProtoStore((state) => state.variant);
  const mode = useProtoStore((state) => state.mode);
  const levels = useProtoStore((state) => state.levels);
  const pickedRaw = useProtoStore((state) => state.computers);
  const projectFilter = useProtoStore((state) => state.project);
  const setProjectFilter = useProtoStore((state) => state.setProjectFilter);
  // Groups whose fold differs from their default (Done and empty groups start folded).
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setFlipped((keys) => {
      const next = new Set(keys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const logical = useLogicalProjects(props.projects, props.threads);
  const machineIds = useComputerNames((state) => state.order);
  const computers = useMemo(
    () => machineIds.filter((id) => props.projects.some((project) => project.environmentId === id)),
    [machineIds, props.projects],
  );
  // Computer names only with 2+ computers in view; (А) is always one.
  const joined = mode === "all" && computers.length >= 2;
  // The pick, without computers that are gone; nothing left = all.
  const pickedKnown = joined ? (pickedRaw?.filter((id) => computers.includes(id)) ?? null) : null;
  const picked = pickedKnown && pickedKnown.length > 0 ? pickedKnown : null;
  const inView = picked ?? computers;
  const multi = joined && inView.length >= 2;
  const effective = effectiveLevels(levels, multi ? inView.length : 1);

  // Filters only change what the list shows — they never switch the computer
  // you work on (critic 3: "Only MacBook" silently made MacBook the active one).
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);

  const passes = (thread: SidebarThreadSummary) =>
    (projectFilter === null || logical.logicalKeyOfThread(thread) === projectFilter) &&
    (picked === null || picked.includes(thread.environmentId));
  const visible = props.threads.filter(passes);
  const visibleDone = props.doneThreads.filter(passes);
  const doneKeys = useMemo(() => new Set(props.doneThreads.map(chatKey)), [props.doneThreads]);
  const isDone = (thread: SidebarThreadSummary) => doneKeys.has(chatKey(thread));

  /** A member folder to start a chat in: on the given computer, else the active one's, else the first. */
  const memberFor = (entry: LogicalProject, environmentId?: string) =>
    entry.members.find(
      (member) => member.environmentId === (environmentId ?? activeEnvironmentId),
    ) ??
    entry.members.find((member) => member.environmentId === activeEnvironmentId) ??
    entry.members[0]!;
  const homeOf = (environmentId: string) =>
    props.projects.find(
      (project) => project.environmentId === environmentId && isHomeProject(project),
    ) ?? null;

  const hasProjects = logical.list.some((entry) => !entry.home);
  const subtitleFor = (thread: SidebarThreadSummary) => {
    const entry = logical.byKey.get(logical.logicalKeyOfThread(thread));
    const byProject = effective.includes("project");
    // Grouped by project: the computer only where it tells chats apart (a
    // project on 2+ computers, or No project, which is on every computer).
    const computerTellsApart = !byProject || !entry || entry.home || entry.computers.length > 1;
    const parts = placeParts({
      environmentId: thread.environmentId,
      project: logical.projectOfThread(thread),
      showProject: !byProject && projectFilter === null,
      showComputer: multi && !effective.includes("computer") && computerTellsApart,
      // "No project" only when there are projects to tell it from (critics 3–4).
      sayNoProject: hasProjects,
    });
    return parts.project || parts.computer ? <PlaceLine parts={parts} /> : null;
  };
  const liveRow = (thread: SidebarThreadSummary, nested: boolean) =>
    props.renderRow(thread, { nested, subtitle: subtitleFor(thread) });
  const anyRow = (thread: SidebarThreadSummary, nested: boolean) =>
    isDone(thread) ? doneRow(thread, props.renderRow, subtitleFor) : liveRow(thread, nested);

  const projectsInView = logical.list.filter(
    (entry) =>
      (projectFilter === null || entry.key === projectFilter) &&
      (picked === null || entry.computers.some((id) => picked.includes(id))),
  );

  const tree = groupChats<SidebarThreadSummary>({
    chats: [...visible, ...visibleDone],
    levels: effective,
    keyOf: {
      status: (thread) => chatStatusOf(props.markOf(thread), isDone(thread)),
      computer: (thread) => thread.environmentId,
      project: (thread) => logical.logicalKeyOfThread(thread),
    },
    orderOf: { computer: inView, project: logical.list.map((entry) => entry.key) },
    seedOf: {
      // Empty groups say where you could start (D's habit): every project in
      // view on top; under a computer, the projects that are on it.
      project: (trail) =>
        projectsInView
          .filter(
            (entry) =>
              !entry.home &&
              (trail.computer === undefined || entry.computers.includes(trail.computer)),
          )
          .map((entry) => entry.key),
      // Every computer in view on top; under a project, the computers it is on.
      computer: (trail) => {
        if (trail.project === undefined) return [...inView];
        const entry = logical.byKey.get(trail.project);
        return entry && !entry.home ? entry.computers.filter((id) => inView.includes(id)) : [];
      },
    },
  });

  const renderNode = (node: ChatGroupNode<SidebarThreadSummary>): ReactNode => {
    const live = node.chats.filter((thread) => !isDone(thread));
    const done = node.chats.filter(isDone);
    const empty = node.chats.length === 0;
    const defaultFolded = empty || (node.level === "status" && node.id === "done");
    const isFolded = defaultFolded !== flipped.has(node.path);
    const mark = node.level === "status" ? null : mostUrgent(live.map(props.markOf));
    let header: ReactNode;
    let onNewChat: (() => void) | undefined;
    if (node.level === "project") {
      const entry = logical.byKey.get(node.id);
      const home = entry?.home ?? node.id === NO_PROJECT_KEY;
      const onComputer = node.trail.computer;
      if (entry) {
        if (home) {
          const homeProject = onComputer ? homeOf(onComputer) : null;
          onNewChat = homeProject ? () => props.onNewChatIn(homeProject) : undefined;
        } else {
          onNewChat = () => props.onNewChatIn(memberFor(entry, onComputer));
        }
      }
      const showWhere = multi && !effective.includes("computer") && !home && entry;
      header = (
        <GroupHeader
          level="project"
          depth={node.depth}
          icon={home ? <HomeIcon /> : <FolderIcon />}
          label={entry?.name ?? (home ? NO_PROJECT : "Project")}
          aside={showWhere ? computersText(entry.computers) : null}
          asideBelow={showWhere ? entry.computers.length > 1 : false}
          count={node.chats.length}
          quiet={empty}
          folded={isFolded}
          onToggle={() => toggle(node.path)}
          onNewChat={onNewChat}
          mark={mark}
          renderMark={props.renderMark}
          testId="proto-group-project"
        />
      );
    } else if (node.level === "computer") {
      const projectKey = node.trail.project;
      const entry = projectKey ? logical.byKey.get(projectKey) : undefined;
      const target = entry && !entry.home ? memberFor(entry, node.id) : homeOf(node.id);
      onNewChat = target ? () => props.onNewChatIn(target) : undefined;
      header = (
        <GroupHeader
          level="computer"
          depth={node.depth}
          icon={<ComputerIcon environmentId={node.id} />}
          label={machineLabel(node.id)}
          count={node.chats.length}
          quiet={empty}
          folded={isFolded}
          onToggle={() => toggle(node.path)}
          onNewChat={onNewChat}
          mark={mark}
          renderMark={props.renderMark}
          testId="proto-group-computer"
        />
      );
    } else {
      const status = node.id as ChatStatus;
      header = (
        <GroupHeader
          level="status"
          depth={node.depth}
          icon={<StatusIcon status={status} renderMark={props.renderMark} />}
          label={STATUS_NAME[status]}
          count={node.chats.length}
          folded={isFolded}
          onToggle={() => toggle(node.path)}
          testId="proto-group-status"
        />
      );
    }
    const byStatus = effective.includes("status");
    let inner: ReactNode = null;
    if (!isFolded) {
      if (empty) {
        inner = <EmptyLine nested text="No chats yet." onNewChat={onNewChat} />;
      } else if (node.children !== null) {
        inner = node.children.map(renderNode);
      } else if (byStatus) {
        // Done is a status group of its own: its chats are listed like the others.
        inner = node.chats.map((thread) => anyRow(thread, true));
      } else {
        inner = (
          <>
            {live.map((thread) => liveRow(thread, true))}
            <DoneFold chats={done} nested renderRow={props.renderRow} subtitleOf={subtitleFor} />
          </>
        );
      }
    }
    return (
      <li key={node.path} className="list-none">
        <ul role="list" className="flex flex-col gap-px">
          {header}
          {inner}
        </ul>
      </li>
    );
  };

  const body: ReactNode =
    tree === null ? (
      <>
        {visible.length === 0 ? <EmptyLine text="No chats here yet." /> : null}
        {visible.map((thread) => liveRow(thread, false))}
        <DoneFold chats={visibleDone} renderRow={props.renderRow} subtitleOf={subtitleFor} />
      </>
    ) : (
      tree.map(renderNode)
    );

  const header = (
    <>
      <li className="flex list-none items-center gap-2 pt-3 pr-0 pb-1.5 pl-2.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-sidebar-muted-foreground/70">
          Chats
        </span>
        <ViewMenu
          computers={joined ? computers : []}
          effective={effective}
          filtered={picked !== null}
        />
      </li>
      <FilterChips picked={picked} projects={logical.byKey} />
    </>
  );

  // ── C: projects as rows above the chats (click = filter) ──────────────
  if (variant === "C") {
    const shown = logical.list.filter((entry) => !entry.home).slice(0, 6);
    return (
      <>
        <li className="flex list-none items-center px-2.5 pt-3 pb-1 text-xs font-medium text-sidebar-muted-foreground/70">
          Projects
        </li>
        {shown.map((entry) => {
          const active = projectFilter === entry.key;
          const chats = props.threads.filter(
            (thread) => logical.logicalKeyOfThread(thread) === entry.key,
          );
          const mark = mostUrgent(chats.map(props.markOf));
          // Done chats count too (critic 3: "brand-kit 3" while it has 5 chats).
          const total =
            chats.length +
            props.doneThreads.filter((thread) => logical.logicalKeyOfThread(thread) === entry.key)
              .length;
          return (
            <li key={entry.key} className="list-none" data-testid="proto-project-row">
              <button
                type="button"
                onClick={() => setProjectFilter(active ? null : entry.key)}
                aria-pressed={active}
                className={cn(
                  "flex h-8 w-full cursor-pointer items-center gap-2 rounded-md pr-2 pl-2.5 text-left text-sm outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "bg-sidebar-row-active text-foreground"
                    : "text-sidebar-foreground/90 hover:bg-sidebar-row-hover",
                )}
              >
                <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate">{entry.name}</span>
                {multi ? (
                  <span className="min-w-0 shrink truncate text-xs text-sidebar-foreground/70">
                    {computersText(entry.computers)}
                  </span>
                ) : null}
                <span className="ml-auto inline-flex shrink-0 items-center gap-1.5">
                  {mark ? props.renderMark(mark) : null}
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {total === 0 ? "" : total}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
        <li className="list-none">
          <button
            type="button"
            onClick={() => openNewProject()}
            data-testid="proto-new-project-row"
            className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md pl-2.5 text-left text-sm text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground"
          >
            <PlusIcon className="size-4" />
            New project
          </button>
        </li>
        {header}
        {body}
      </>
    );
  }

  // ── G: one list with the sliders icon ─────────────────────────────────
  return (
    <>
      {header}
      {body}
      {effective[0] === "project" ? (
        <li className="list-none">
          <button
            type="button"
            onClick={() => openNewProject()}
            data-testid="proto-new-project-row"
            className="mt-1 flex h-8 w-full cursor-pointer items-center gap-2 rounded-md pl-2.5 text-left text-sm text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground"
          >
            <PlusIcon className="size-4" />
            New project
          </button>
        </li>
      ) : null}
    </>
  );
}
