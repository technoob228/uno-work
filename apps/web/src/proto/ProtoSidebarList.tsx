/**
 * Sidebar prototype (w0115, NOT FOR MERGE): the chat list of variants A, B,
 * C and E, between the Uno row and the Done shelf of the real sidebar. Rows
 * are the real sidebar rows (`renderRow`); this file only decides order,
 * filter and the line under the title.
 */
import {
  CheckIcon,
  ChevronDownIcon,
  FolderIcon,
  HomeIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { openNewProject } from "../navigation/newProjectStore";
import { useStore } from "../store";
import type { Project, SidebarThreadSummary } from "../types";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../components/ui/menu";
import { Button } from "../components/ui/button";
import { isHomeProject, machineLabel, placeLabel, projectKeyOf } from "./protoPlace";
import { useProtoStore } from "./protoState";

/** Chats in the Home folder, said the way people say it (critics 1–2: "Home folder" reads technical). */
export const NO_PROJECT = "No project";

type Mark = "approval" | "input" | "your-turn" | "failed" | "working" | null;

export interface ProtoRowOptions {
  readonly nested?: boolean;
  readonly subtitle?: string | null;
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

interface ProjectEntry {
  readonly key: string;
  readonly project: Project;
  readonly home: boolean;
  readonly chats: SidebarThreadSummary[];
}

function useProjectEntries(
  projects: ReadonlyArray<Project>,
  threads: ReadonlyArray<SidebarThreadSummary>,
): ProjectEntry[] {
  return useMemo(() => {
    const byKey = new Map<string, ProjectEntry>();
    for (const project of projects) {
      byKey.set(projectKeyOf(project), {
        key: projectKeyOf(project),
        project,
        home: isHomeProject(project),
        chats: [],
      });
    }
    for (const thread of threads) {
      byKey.get(`${thread.environmentId}:${thread.projectId}`)?.chats.push(thread);
    }
    // Worked in last first; empty projects after, by name.
    const order = [...threads].map((thread) => `${thread.environmentId}:${thread.projectId}`);
    return [...byKey.values()].toSorted((a, b) => {
      const ai = order.indexOf(a.key);
      const bi = order.indexOf(b.key);
      if (ai === -1 && bi === -1) return a.project.name.localeCompare(b.project.name);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }, [projects, threads]);
}

/** The words for the current filter. */
function filterLabel(
  filter: string | null,
  machineFilter: string | null,
  entries: ProjectEntry[],
  joined = false,
) {
  if (machineFilter) return `Everything on ${machineLabel(machineFilter)}`;
  if (filter === null) return "All projects";
  if (filter === "home") return NO_PROJECT;
  const entry = entries.find((candidate) => candidate.key === filter);
  if (!entry) return "All projects";
  const name = entry.home ? NO_PROJECT : entry.project.name;
  return joined ? `${name} · ${machineLabel(entry.project.environmentId)}` : name;
}

function applyFilter(
  threads: ReadonlyArray<SidebarThreadSummary>,
  entries: ProjectEntry[],
  filter: string | null,
  machineFilter: string | null,
): SidebarThreadSummary[] {
  if (machineFilter) return threads.filter((thread) => thread.environmentId === machineFilter);
  if (filter === null) return [...threads];
  if (filter === "home") {
    const homes = new Set(entries.filter((entry) => entry.home).map((entry) => entry.key));
    return threads.filter((thread) => homes.has(`${thread.environmentId}:${thread.projectId}`));
  }
  return threads.filter((thread) => `${thread.environmentId}:${thread.projectId}` === filter);
}

// ── The "All chats ▾" filter (A, B) ──────────────────────────────────────

/**
 * One flat list: "No project" (every Home folder), then the projects, each with
 * its computer in (Б). No per-computer groups and no "Everything on …" (critic 2:
 * the menu was too busy).
 */
function ProjectMenuItems(props: {
  entries: ProjectEntry[];
  joined: boolean;
  filter: string | null;
  onPick: (key: string | null) => void;
}) {
  const homeCount = props.entries
    .filter((entry) => entry.home)
    .reduce((sum, entry) => sum + entry.chats.length, 0);
  return (
    <MenuGroup>
      <MenuGroupLabel>Projects</MenuGroupLabel>
      {props.entries
        .filter((entry) => !entry.home)
        .map((entry) => (
          <MenuItem
            key={entry.key}
            onClick={() => props.onPick(entry.key)}
            data-testid="proto-filter-project"
          >
            <FolderIcon />
            <span className="min-w-0 flex-1 truncate">
              {entry.project.name}
              {props.joined ? (
                <span className="ml-1.5 text-xs text-muted-foreground">
                  {machineLabel(entry.project.environmentId)}
                </span>
              ) : null}
            </span>
            <span className="ml-3 text-xs text-muted-foreground tabular-nums">
              {entry.chats.length === 0 ? "empty" : entry.chats.length}
            </span>
            {props.filter === entry.key ? <CheckIcon className="text-foreground" /> : null}
          </MenuItem>
        ))}
      <MenuItem onClick={() => props.onPick("home")} data-testid="proto-filter-home">
        <HomeIcon />
        <span className="min-w-0 flex-1 truncate">{NO_PROJECT}</span>
        <span className="ml-3 text-xs text-muted-foreground tabular-nums">{homeCount}</span>
        {props.filter === "home" ? <CheckIcon className="text-foreground" /> : null}
      </MenuItem>
    </MenuGroup>
  );
}

function FilterMenu(props: {
  entries: ProjectEntry[];
  total: number;
  withGroupToggle: boolean;
}) {
  const filter = useProtoStore((state) => state.filter);
  const machineFilter = useProtoStore((state) => state.machineFilter);
  const setFilter = useProtoStore((state) => state.setFilter);
  const grouped = useProtoStore((state) => state.grouped);
  const setGrouped = useProtoStore((state) => state.setGrouped);
  const joined = useProtoStore((state) => state.mode) === "all";
  const label = filterLabel(filter, machineFilter, props.entries, joined);
  const narrowed = filter !== null || machineFilter !== null;
  return (
    <li className="list-none px-0.5 pt-2 pb-1">
      <div className="flex items-center gap-1">
        <Menu>
          <MenuTrigger
            className={cn(
              "flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg border border-border/80 bg-background/60 px-2.5 text-left text-sm outline-hidden transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-sidebar-row-hover",
              narrowed ? "text-foreground" : "text-sidebar-foreground/90",
            )}
            data-testid="proto-filter"
          >
            {narrowed ? (
              <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </MenuTrigger>
          <MenuPopup align="start" className="min-w-64" data-testid="proto-filter-menu">
            <MenuItem onClick={() => setFilter(null)}>
              <span className="min-w-0 flex-1">All projects</span>
              <span className="ml-3 text-xs text-muted-foreground tabular-nums">{props.total}</span>
              {!narrowed ? <CheckIcon className="text-foreground" /> : null}
            </MenuItem>
            <MenuSeparator />
            <ProjectMenuItems
              entries={props.entries}
              joined={joined}
              filter={filter}
              onPick={(key) => setFilter(key)}
            />
            <MenuSeparator />
            <MenuItem onClick={() => openNewProject()} data-testid="proto-new-project">
              <PlusIcon />
              New project…
            </MenuItem>
            {props.withGroupToggle ? (
              <>
                <MenuSeparator />
                <MenuItem
                  onClick={() => setGrouped(!grouped)}
                  data-testid="proto-group-toggle"
                  closeOnClick={false}
                >
                  <span
                    className={cn(
                      "flex size-4 items-center justify-center rounded border",
                      grouped ? "border-primary bg-primary text-primary-foreground" : "border-border",
                    )}
                  >
                    {grouped ? <CheckIcon className="size-3" /> : null}
                  </span>
                  Group by project
                </MenuItem>
              </>
            ) : null}
          </MenuPopup>
        </Menu>
        {narrowed ? (
          <button
            type="button"
            aria-label="Show all chats"
            title="Show all chats"
            onClick={() => setFilter(null)}
            className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground"
          >
            <XIcon className="size-4" />
          </button>
        ) : null}
      </div>
    </li>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────────

/** 0.0.114: Done chats fold into one "Done · N" row — here, inside the project in view. */
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
          <CheckIcon className="size-3.5" />
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

function SectionLabel(props: { label: string; action?: ReactNode }) {
  return (
    <li className="flex list-none items-center px-2.5 pt-3 pb-1 text-xs font-medium text-sidebar-muted-foreground/70">
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.action}
    </li>
  );
}

function EmptyProject(props: { entry: ProjectEntry; onNewChat: () => void; nested?: boolean }) {
  return (
    <li
      className={cn(
        "flex list-none flex-col items-start gap-2 py-2 pr-2 text-xs text-muted-foreground",
        props.nested ? "pl-8" : "pl-2.5",
      )}
      data-testid="proto-empty-project"
    >
      <span>No chats in {props.entry.project.name} yet.</span>
      <Button size="xs" variant="outline" onClick={props.onNewChat}>
        <PlusIcon className="-mx-0.5 size-3" />
        New chat here
      </Button>
    </li>
  );
}

function ProjectRow(props: {
  entry: ProjectEntry;
  active: boolean;
  mark: Mark;
  renderMark: (mark: Mark) => ReactNode;
  joined: boolean;
  onClick: () => void;
  trailing?: ReactNode;
  folded?: boolean;
}) {
  const { entry } = props;
  return (
    <li className="group/project list-none" data-testid="proto-project-row">
      <button
        type="button"
        onClick={props.onClick}
        aria-pressed={props.active}
        className={cn(
          "flex h-8 w-full cursor-pointer items-center gap-2 rounded-md pr-2 pl-2.5 text-left text-sm outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          props.active
            ? "bg-sidebar-row-active text-foreground"
            : "text-sidebar-foreground/90 hover:bg-sidebar-row-hover",
        )}
      >
        {entry.home ? (
          <HomeIcon className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate">
          {entry.home ? NO_PROJECT : entry.project.name}
          {props.joined ? (
            <span className="ml-1.5 text-xs text-muted-foreground">
              {machineLabel(entry.project.environmentId)}
            </span>
          ) : null}
        </span>
        {props.trailing ?? (
          <span className="inline-flex shrink-0 items-center gap-1.5">
            {props.mark ? props.renderMark(props.mark) : null}
            <span className="text-xs text-muted-foreground tabular-nums">
              {entry.chats.length === 0 ? "" : entry.chats.length}
            </span>
          </span>
        )}
      </button>
    </li>
  );
}

// ── The list ─────────────────────────────────────────────────────────────

export function ProtoSidebarList(props: ProtoSidebarListProps) {
  const variant = useProtoStore((state) => state.variant);
  const joined = useProtoStore((state) => state.mode) === "all";
  const mode = useProtoStore((state) => state.mode);
  const filter = useProtoStore((state) => state.filter);
  const machineFilter = useProtoStore((state) => state.machineFilter);
  const setFilter = useProtoStore((state) => state.setFilter);
  const grouped = useProtoStore((state) => state.grouped);
  const [foldedKeys, setFoldedKeys] = useState<ReadonlySet<string>>(new Set());

  const entries = useProjectEntries(props.projects, props.threads);
  // (Б): looking at a project makes its computer the active one, so "New chat"
  // and the computer chip on Home start there (critic 2: "Cloud" while in brand-kit).
  const setActiveEnvironmentId = useStore((state) => state.setActiveEnvironmentId);
  useEffect(() => {
    if (!joined || filter === null || filter === "home") return;
    const environmentId = filter.split(":")[0] ?? "";
    if (environmentId && useStore.getState().activeEnvironmentId !== environmentId) {
      setActiveEnvironmentId(environmentId as EnvironmentId);
    }
  }, [filter, joined, setActiveEnvironmentId]);
  const entryByKey = useMemo(() => new Map(entries.map((entry) => [entry.key, entry])), [entries]);
  const visible = applyFilter(props.threads, entries, filter, machineFilter);
  const filteredEntry = filter && filter !== "home" ? (entryByKey.get(filter) ?? null) : null;

  const subtitleOf = (thread: SidebarThreadSummary, hideFolder: boolean) =>
    placeLabel({
      mode,
      environmentId: thread.environmentId,
      project: entryByKey.get(`${thread.environmentId}:${thread.projectId}`)?.project ?? null,
      hideFolder,
    });

  const flatRows = (rows: ReadonlyArray<SidebarThreadSummary>) =>
    rows.map((thread) =>
      props.renderRow(thread, {
        subtitle: subtitleOf(thread, filter !== null && filter !== "home"),
      }),
    );

  const doneInView = applyFilter(props.doneThreads, entries, filter, machineFilter);
  const doneFold =
    filter !== null || machineFilter !== null ? (
      <DoneFold chats={doneInView} renderRow={props.renderRow} />
    ) : null;
  const doneOf = (entry: ProjectEntry) =>
    props.doneThreads.filter(
      (thread) => `${thread.environmentId}:${thread.projectId}` === entry.key,
    );

  const emptyFiltered =
    filteredEntry && visible.length === 0 ? (
      <EmptyProject entry={filteredEntry} onNewChat={() => props.onNewChatIn(filteredEntry.project)} />
    ) : null;

  // ── B, grouped: projects as folding groups, empty ones included ──────
  if (variant === "B" && grouped && filter === null && machineFilter === null) {
    const homeChats = entries.filter((entry) => entry.home).flatMap((entry) => entry.chats);
    const projectEntries = entries.filter((entry) => !entry.home);
    return (
      <>
        <FilterMenu entries={entries} total={props.threads.length} withGroupToggle />
        {projectEntries.map((entry) => {
          const folded = foldedKeys.has(entry.key);
          return (
            <li key={entry.key} className="list-none">
              <ul role="list" className="flex flex-col gap-px">
                <ProjectRow
                  entry={entry}
                  active={false}
                  joined={joined}
                  mark={folded ? mostUrgent(entry.chats.map(props.markOf)) : null}
                  renderMark={props.renderMark}
                  onClick={() =>
                    setFoldedKeys((keys) => {
                      const next = new Set(keys);
                      if (next.has(entry.key)) next.delete(entry.key);
                      else next.add(entry.key);
                      return next;
                    })
                  }
                  trailing={
                    <ChevronDownIcon
                      className={cn(
                        "size-3.5 shrink-0 text-muted-foreground transition-transform",
                        folded && "-rotate-90",
                      )}
                    />
                  }
                />
                {folded
                  ? null
                  : entry.chats.length === 0 && doneOf(entry).length === 0
                    ? (
                        <EmptyProject
                          entry={entry}
                          nested
                          onNewChat={() => props.onNewChatIn(entry.project)}
                        />
                      )
                    : entry.chats.map((thread) =>
                        props.renderRow(thread, { nested: true, subtitle: null }),
                      )}
                {folded ? null : (
                  <DoneFold chats={doneOf(entry)} nested renderRow={props.renderRow} />
                )}
              </ul>
            </li>
          );
        })}
        {homeChats.length > 0 ? <SectionLabel label={NO_PROJECT} /> : null}
        {homeChats.map((thread) =>
          props.renderRow(thread, {
            subtitle: joined ? machineLabel(thread.environmentId) : null,
          }),
        )}
        <DoneFold
          chats={entries.filter((entry) => entry.home).flatMap(doneOf)}
          renderRow={props.renderRow}
        />
      </>
    );
  }

  // ── A, B (list): the filter on top, one list ─────────────────────────
  if (variant === "A" || variant === "B") {
    return (
      <>
        <FilterMenu entries={entries} total={props.threads.length} withGroupToggle={variant === "B"} />
        {emptyFiltered}
        {flatRows(visible)}
        {doneFold}
      </>
    );
  }

  // ── C: projects on top, click = filter ───────────────────────────────
  if (variant === "C") {
    const shown = entries.filter((entry) => !entry.home).slice(0, 5);
    return (
      <>
        <SectionLabel label="Projects" />
        {shown.map((entry) => (
          <ProjectRow
            key={entry.key}
            entry={entry}
            active={filter === entry.key}
            joined={joined}
            mark={mostUrgent(entry.chats.map(props.markOf))}
            renderMark={props.renderMark}
            onClick={() => setFilter(filter === entry.key ? null : entry.key)}
          />
        ))}
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
        <SectionLabel
          label={filteredEntry ? `Chats in ${filteredEntry.project.name}` : "Chats"}
          action={
            filteredEntry ? (
              <button
                type="button"
                onClick={() => setFilter(null)}
                className="-my-1 inline-flex cursor-pointer items-center gap-0.5 rounded-md px-1 text-xs text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground"
              >
                <XIcon className="size-3" />
                All
              </button>
            ) : null
          }
        />
        {emptyFiltered}
        {flatRows(visible)}
        {doneFold}
      </>
    );
  }

  // ── E: only chats; projects live on their page ───────────────────────
  return (
    <>
      {filter !== null ? (
        <li className="list-none px-0.5 pt-2 pb-1">
          <button
            type="button"
            onClick={() => setFilter(null)}
            className="inline-flex h-7 max-w-full cursor-pointer items-center gap-1.5 rounded-full border border-border/80 bg-background/60 pr-2 pl-2.5 text-xs font-medium text-foreground hover:bg-sidebar-row-hover"
            data-testid="proto-filter-chip"
          >
            <FolderIcon className="size-3.5 text-muted-foreground" />
            <span className="truncate">{filterLabel(filter, null, entries, joined)}</span>
            <XIcon className="size-3.5 text-muted-foreground" />
          </button>
        </li>
      ) : (
        <SectionLabel label="Chats" />
      )}
      {emptyFiltered}
      {flatRows(visible)}
      {doneFold}
    </>
  );
}
