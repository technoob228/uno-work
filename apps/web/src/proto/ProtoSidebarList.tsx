/**
 * Sidebar prototype (w0115, NOT FOR MERGE), iteration 2: the chat list of
 * variants G and C, between the Uno row and the Done shelf of the real
 * sidebar. Rows are the real sidebar rows (`renderRow`); this file decides
 * grouping, filters and the "project · computer" line under the title.
 *
 * - A visible "Group by" button above the chats: none / project / computer /
 *   computer then project, plus a project and a computer filter. Remembered.
 * - Each chat says what the list doesn't: its project if not grouped by
 *   project, its computer if not grouped by computer (and only with 2+).
 * - One project on two computers (same repository / shared Uno folder) is one
 *   project: its chats from both computers sit together.
 */
import {
  ChevronDownIcon,
  CloudIcon,
  FolderIcon,
  HomeIcon,
  LaptopIcon,
  PlusIcon,
  SlidersHorizontalIcon,
  XIcon,
} from "lucide-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { openNewProject } from "../navigation/newProjectStore";
import { useStore } from "../store";
import type { Project, SidebarThreadSummary } from "../types";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { Button } from "../components/ui/button";
import {
  isHomeProject,
  logicalKeyOf,
  MACHINE_ORDER,
  machineKind,
  machineLabel,
  NO_PROJECT,
  NO_PROJECT_KEY,
  placeParts,
  type PlaceParts,
} from "./protoPlace";
import { effectiveGroupBy, GROUP_BY, useProtoStore, type ProtoGroupBy } from "./protoState";

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
  /** Projects in scope (every computer in (Б)), the assistant's left out. */
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

/** A project row shows a dot when a chat in it waits or works — "Your turn" stays on the chats. */
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
  /** Computers it is on, in MACHINE_ORDER. */
  readonly computers: string[];
}

const threadKey = (thread: Pick<SidebarThreadSummary, "environmentId" | "projectId">) =>
  `${thread.environmentId}:${thread.projectId}`;

function useLogicalProjects(
  projects: ReadonlyArray<Project>,
  threads: ReadonlyArray<SidebarThreadSummary>,
) {
  return useMemo(() => {
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
        computers: MACHINE_ORDER.filter((id) =>
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
    for (const project of projects) projectOf.set(`${project.environmentId}:${project.id}`, project);
    return {
      list,
      byKey: new Map(list.map((entry) => [entry.key, entry])),
      logicalKeyOfThread: (thread: SidebarThreadSummary) =>
        logicalOf.get(threadKey(thread)) ?? NO_PROJECT_KEY,
      projectOfThread: (thread: SidebarThreadSummary) => projectOf.get(threadKey(thread)) ?? null,
    };
  }, [projects, threads]);
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
    <span className="inline-flex min-w-0 items-center gap-2.5 text-xs leading-4 text-sidebar-foreground/75">
      {parts.project ? (
        <span className="inline-flex min-w-0 items-center gap-1">
          <FolderIcon className="size-3 shrink-0 opacity-70" />
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
        ? props.chats.map((thread) =>
            props.renderRow(thread, {
              section: thread.settledOverride === "settled" ? "settled" : "snoozed",
            }),
          )
        : null}
    </>
  );
}

function EmptyLine(props: { text: string; onNewChat?: () => void; nested?: boolean }) {
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
  count: number;
  folded: boolean;
  onToggle: () => void;
  onNewChat?: (() => void) | undefined;
  mark?: Mark;
  renderMark?: (mark: Mark) => ReactNode;
  level?: 0 | 1;
  testId?: string;
}) {
  return (
    <li
      className={cn(
        "group/proto-group flex list-none items-center gap-0.5",
        props.level === 1 ? "" : "mt-2",
      )}
      data-testid={props.testId}
    >
      <button
        type="button"
        onClick={props.onToggle}
        aria-expanded={!props.folded}
        className={cn(
          "flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md pr-2 text-left outline-hidden transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring",
          props.level === 1
            ? "h-7 pl-4 text-[13px] text-sidebar-foreground/90"
            : "h-8 pl-2.5 text-sm font-medium text-foreground",
        )}
      >
        <span
          className={cn(
            "inline-flex shrink-0 text-muted-foreground",
            props.level === 1 ? "[&_svg]:size-3.5" : "[&_svg]:size-4",
          )}
        >
          {props.icon}
        </span>
        <span
          className="min-w-0 shrink-0 truncate"
          style={{ maxWidth: props.aside ? "62%" : undefined }}
        >
          {props.label}
        </span>
        {props.aside ? (
          <span className="min-w-0 shrink truncate text-xs font-normal text-sidebar-foreground/70">
            {props.aside}
          </span>
        ) : null}
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5">
          {props.folded && props.mark && props.renderMark ? props.renderMark(props.mark) : null}
          <span className="text-xs font-normal text-muted-foreground tabular-nums">
            {props.count > 0 ? props.count : ""}
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

// ── The "Group by" button ────────────────────────────────────────────────

function Segmented<T extends string>(props: {
  label: string;
  value: T;
  options: ReadonlyArray<{ id: T; name: string; icon?: ReactNode }>;
  onChange: (value: T) => void;
  testId: string;
  wrap?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{props.label}</span>
      <div
        role="radiogroup"
        aria-label={props.label}
        data-testid={props.testId}
        className={cn("flex gap-1", props.wrap ? "flex-wrap" : "flex-col")}
      >
        {props.options.map((option) => {
          const on = option.id === props.value;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => props.onChange(option.id)}
              className={cn(
                "inline-flex min-h-8 cursor-pointer items-center gap-2 rounded-lg border px-2.5 text-left text-sm transition-colors [&_svg]:size-3.5 [&_svg]:shrink-0",
                on
                  ? "border-foreground/80 bg-foreground/5 font-medium text-foreground"
                  : "border-border text-sidebar-foreground/85 hover:bg-accent hover:text-foreground",
                !props.wrap && "w-full",
              )}
            >
              {option.icon}
              <span className="min-w-0 truncate">{option.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ViewButton(props: {
  projects: ReadonlyArray<LogicalProject>;
  computers: ReadonlyArray<string>;
  multi: boolean;
}) {
  const groupBy = useProtoStore((state) => state.groupBy);
  const projectFilter = useProtoStore((state) => state.project);
  const computerFilter = useProtoStore((state) => state.computer);
  const setGroupBy = useProtoStore((state) => state.setGroupBy);
  const setProjectFilter = useProtoStore((state) => state.setProjectFilter);
  const setComputerFilter = useProtoStore((state) => state.setComputerFilter);
  const effective = effectiveGroupBy(groupBy, props.multi);
  const current = GROUP_BY.find((item) => item.id === effective)!;
  const narrowed = projectFilter !== null || (props.multi && computerFilter !== null);
  return (
    <Popover>
      <PopoverTrigger
        data-testid="proto-view-button"
        className={cn(
          "-my-1 inline-flex h-7 max-w-[11rem] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-background/70 px-2 text-xs font-medium text-sidebar-foreground outline-hidden transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-sidebar-row-hover",
        )}
        aria-label={`Group and filter chats — now: ${current.short}`}
      >
        <SlidersHorizontalIcon className="size-3.5 shrink-0" />
        <span className="truncate">{current.short}</span>
        {narrowed ? (
          <span className="size-1.5 shrink-0 rounded-full bg-foreground" aria-label="filtered" />
        ) : null}
        <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverPopup
        side="bottom"
        align="end"
        className="w-[min(18rem,calc(100vw-1.5rem))]"
        data-testid="proto-view-popup"
      >
        <div className="flex flex-col gap-4">
          <Segmented
            label="Group chats by"
            value={effective}
            options={GROUP_BY.filter((item) => props.multi || !item.multi).map((item) => ({
              id: item.id,
              name: item.name,
            }))}
            onChange={(value: ProtoGroupBy) => setGroupBy(value)}
            testId="proto-groupby"
          />
          <Segmented
            label="Show projects"
            value={projectFilter ?? "all"}
            wrap
            options={[
              { id: "all", name: "All" },
              ...props.projects
                .filter((project) => !project.home)
                .map((project) => ({
                  id: project.key,
                  name: project.name,
                  icon: <FolderIcon />,
                })),
              { id: NO_PROJECT_KEY, name: NO_PROJECT, icon: <HomeIcon /> },
            ]}
            onChange={(value) => setProjectFilter(value === "all" ? null : value)}
            testId="proto-filter-project"
          />
          {props.multi ? (
            <Segmented
              label="Show computers"
              value={computerFilter ?? "all"}
              wrap
              options={[
                { id: "all", name: "All" },
                ...props.computers.map((id) => ({
                  id,
                  name: machineLabel(id),
                  icon: <ComputerIcon environmentId={id} />,
                })),
              ]}
              onChange={(value) => setComputerFilter(value === "all" ? null : value)}
              testId="proto-filter-computer"
            />
          ) : null}
          <p className="text-xs leading-snug text-muted-foreground">
            A project on several computers (a shared folder) is one project here.
          </p>
          <Button size="sm" variant="outline" className="self-start" onClick={() => openNewProject()}>
            <PlusIcon />
            New project
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** What the list is narrowed to, each with ✕. */
function FilterChips(props: { multi: boolean; projects: Map<string, LogicalProject> }) {
  const projectFilter = useProtoStore((state) => state.project);
  const computerFilter = useProtoStore((state) => state.computer);
  const setProjectFilter = useProtoStore((state) => state.setProjectFilter);
  const setComputerFilter = useProtoStore((state) => state.setComputerFilter);
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
  if (props.multi && computerFilter !== null) {
    chips.push({
      key: "c",
      icon: <ComputerIcon environmentId={computerFilter} />,
      label: machineLabel(computerFilter),
      clear: () => setComputerFilter(null),
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
  const groupBy = useProtoStore((state) => state.groupBy);
  const projectFilter = useProtoStore((state) => state.project);
  const computerFilterRaw = useProtoStore((state) => state.computer);
  const setProjectFilter = useProtoStore((state) => state.setProjectFilter);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setFolded((keys) => {
      const next = new Set(keys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const logical = useLogicalProjects(props.projects, props.threads);
  const computers = useMemo(
    () =>
      MACHINE_ORDER.filter((id) => props.projects.some((project) => project.environmentId === id)),
    [props.projects],
  );
  // Computer names only with 2+ computers in view; (А) is always one.
  const multi = mode === "all" && computers.length >= 2;
  const computerFilter = multi ? computerFilterRaw : null;
  const effective = effectiveGroupBy(groupBy, multi);

  // Looking at one project in (Б) makes a computer it is on the active one, so
  // "New chat" and the computer chip on Home start there.
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const setActiveEnvironmentId = useStore((state) => state.setActiveEnvironmentId);
  useEffect(() => {
    if (mode !== "all") return;
    const target =
      computerFilter ??
      (projectFilter && projectFilter !== NO_PROJECT_KEY
        ? (() => {
            const computersOf = logical.byKey.get(projectFilter)?.computers ?? [];
            return computersOf.includes(activeEnvironmentId ?? "") ? null : (computersOf[0] ?? null);
          })()
        : null);
    if (target && activeEnvironmentId !== target) {
      setActiveEnvironmentId(target as EnvironmentId);
    }
  }, [activeEnvironmentId, computerFilter, logical, mode, projectFilter, setActiveEnvironmentId]);

  const passes = (thread: SidebarThreadSummary) =>
    (projectFilter === null || logical.logicalKeyOfThread(thread) === projectFilter) &&
    (computerFilter === null || thread.environmentId === computerFilter);
  const visible = props.threads.filter(passes);
  const visibleDone = props.doneThreads.filter(passes);

  /** A member folder to start a chat in: the active computer's, else the first. */
  const memberFor = (entry: LogicalProject, environmentId?: string) =>
    entry.members.find((member) => member.environmentId === (environmentId ?? activeEnvironmentId)) ??
    entry.members[0]!;
  const homeOf = (environmentId: string) =>
    props.projects.find(
      (project) => project.environmentId === environmentId && isHomeProject(project),
    ) ?? null;

  const row = (
    thread: SidebarThreadSummary,
    show: { project: boolean; computer: boolean },
    nested = false,
  ) => {
    const parts = placeParts({
      environmentId: thread.environmentId,
      project: logical.projectOfThread(thread),
      showProject: show.project && projectFilter === null,
      showComputer: show.computer && multi && computerFilter === null,
    });
    return props.renderRow(thread, {
      nested,
      subtitle: parts.project || parts.computer ? <PlaceLine parts={parts} /> : null,
    });
  };

  const projectsInView = logical.list.filter(
    (entry) =>
      (projectFilter === null || entry.key === projectFilter) &&
      (computerFilter === null || entry.computers.includes(computerFilter)),
  );

  // ── The list body by grouping ─────────────────────────────────────────
  let body: ReactNode;
  if (effective === "none") {
    body = (
      <>
        {visible.length === 0 ? <EmptyLine text="No chats here yet." /> : null}
        {visible.map((thread) => row(thread, { project: true, computer: true }))}
        {projectFilter !== null || computerFilter !== null || groupBy !== "none" ? (
          <DoneFold chats={visibleDone} renderRow={props.renderRow} />
        ) : null}
      </>
    );
  } else if (effective === "project") {
    body = projectsInView.map((entry) => {
      const key = `p:${entry.key}`;
      const chats = visible.filter((thread) => logical.logicalKeyOfThread(thread) === entry.key);
      const done = visibleDone.filter((thread) => logical.logicalKeyOfThread(thread) === entry.key);
      if (entry.home && chats.length === 0 && done.length === 0) return null;
      const isFolded = folded.has(key);
      // A project on 2+ computers: say so on the header, and each chat says its computer.
      const joinedHere = entry.computers.length > 1;
      return (
        <li key={key} className="list-none">
          <ul role="list" className="flex flex-col gap-px">
            <GroupHeader
              icon={entry.home ? <HomeIcon /> : <FolderIcon />}
              label={entry.name}
              aside={multi && computerFilter === null && !entry.home ? computersText(entry.computers) : null}
              count={chats.length}
              folded={isFolded}
              onToggle={() => toggle(key)}
              onNewChat={entry.home ? undefined : () => props.onNewChatIn(memberFor(entry))}
              mark={mostUrgent(chats.map(props.markOf))}
              renderMark={props.renderMark}
              testId="proto-group-project"
            />
            {isFolded ? null : (
              <>
                {chats.length === 0 && done.length === 0 ? (
                  <EmptyLine
                    nested
                    text="No chats yet."
                    onNewChat={() => props.onNewChatIn(memberFor(entry))}
                  />
                ) : null}
                {chats.map((thread) =>
                  row(thread, { project: false, computer: entry.home || joinedHere }, true),
                )}
                <DoneFold chats={done} nested renderRow={props.renderRow} />
              </>
            )}
          </ul>
        </li>
      );
    });
  } else {
    // By computer (then, optionally, by project inside it).
    const computersInView = computers.filter(
      (id) =>
        (computerFilter === null || id === computerFilter) &&
        (projectFilter === null ||
          (logical.byKey.get(projectFilter)?.computers.includes(id) ?? false)),
    );
    body = computersInView.map((environmentId) => {
      const key = `c:${environmentId}`;
      const chats = visible.filter((thread) => thread.environmentId === environmentId);
      const done = visibleDone.filter((thread) => thread.environmentId === environmentId);
      const isFolded = folded.has(key);
      const home = homeOf(environmentId);
      let inner: ReactNode;
      if (effective === "computer") {
        inner = (
          <>
            {chats.length === 0 ? <EmptyLine nested text="No chats here yet." /> : null}
            {chats.map((thread) => row(thread, { project: true, computer: false }, true))}
            <DoneFold chats={done} nested renderRow={props.renderRow} />
          </>
        );
      } else {
        inner = projectsInView
          .filter((entry) => entry.computers.includes(environmentId))
          .map((entry) => {
            const subKey = `${key}:${entry.key}`;
            const subChats = chats.filter(
              (thread) => logical.logicalKeyOfThread(thread) === entry.key,
            );
            const subDone = done.filter(
              (thread) => logical.logicalKeyOfThread(thread) === entry.key,
            );
            if (entry.home && subChats.length === 0 && subDone.length === 0) return null;
            const subFolded = folded.has(subKey);
            return (
              <li key={subKey} className="list-none">
                <ul role="list" className="flex flex-col gap-px">
                  <GroupHeader
                    level={1}
                    icon={entry.home ? <HomeIcon /> : <FolderIcon />}
                    label={entry.name}
                    count={subChats.length}
                    folded={subFolded}
                    onToggle={() => toggle(subKey)}
                    onNewChat={() => props.onNewChatIn(memberFor(entry, environmentId))}
                    mark={mostUrgent(subChats.map(props.markOf))}
                    renderMark={props.renderMark}
                  />
                  {subFolded ? null : (
                    <>
                      {subChats.length === 0 && subDone.length === 0 ? (
                        <EmptyLine nested text="No chats yet." />
                      ) : null}
                      {subChats.map((thread) =>
                        props.renderRow(thread, { nested: true, subtitle: null }),
                      )}
                      <DoneFold chats={subDone} nested renderRow={props.renderRow} />
                    </>
                  )}
                </ul>
              </li>
            );
          });
      }
      return (
        <li key={key} className="list-none">
          <ul role="list" className="flex flex-col gap-px">
            <GroupHeader
              icon={<ComputerIcon environmentId={environmentId} />}
              label={machineLabel(environmentId)}
              count={chats.length}
              folded={isFolded}
              onToggle={() => toggle(key)}
              onNewChat={home ? () => props.onNewChatIn(home) : undefined}
              mark={mostUrgent(chats.map(props.markOf))}
              renderMark={props.renderMark}
              testId="proto-group-computer"
            />
            {isFolded ? null : inner}
          </ul>
        </li>
      );
    });
  }

  const header = (
    <>
      <li className="flex list-none items-center gap-2 px-2.5 pt-3 pb-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-sidebar-muted-foreground/70">
          Chats
        </span>
        <ViewButton projects={logical.list} computers={computers} multi={multi} />
      </li>
      <FilterChips multi={multi} projects={logical.byKey} />
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
                    {chats.length === 0 ? "" : chats.length}
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

  // ── G: one list with the Group by button ──────────────────────────────
  return (
    <>
      {header}
      {body}
      {effective === "project" ? (
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
