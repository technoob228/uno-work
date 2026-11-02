/**
 * Pull requests in Dev mode: every open pull request of this person's projects,
 * sorted by what can merge or what waits on them; opening one reads it inside
 * Work. Pull requests live on GitHub and GitLab; this page reads and acts on
 * them through the services the person connected.
 */
import { isAssistantProjectId, type PullRequestInvolvement } from "@t3tools/contracts";
import type { PullRequestListState } from "@t3tools/contracts";
import { useQueries } from "@tanstack/react-query";
import { Link, Navigate, useNavigate } from "@tanstack/react-router";
import { ExternalLinkIcon, GitPullRequestIcon, ListFilterIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useDevMode } from "../../devMode";
import { cn } from "../../lib/utils";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { SidebarShowButton } from "../sidebar/SidebarShowButton";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { PullRequestDetail } from "./PullRequestDetail";
import { PullRequestChecksMark, PullRequestStateIcon } from "./pullRequestPresentation";
import {
  type EnvironmentPullRequestEntry,
  filterPullRequestsByInvolvement,
  groupPullRequestsByInvolvement,
  INVOLVEMENTS,
  LIST_STATES,
  matchesPullRequestQuery,
  mergePullRequestLists,
  pullRequestBlocker,
  pullRequestEntryKey,
  type PullRequestListSort,
  SORT_LABELS,
  sortPullRequestGroups,
} from "./pullRequestList.logic";
import { pullRequestListQuery } from "./pullRequestQueries";

export interface PullRequestsSearch {
  readonly env?: string;
  readonly project?: string;
  readonly repo?: string;
  readonly n?: number;
  readonly tab?: string;
}

export function parsePullRequestsSearch(search: Record<string, unknown>): PullRequestsSearch {
  const text = (value: unknown) =>
    typeof value === "string" && value.length > 0 ? value : undefined;
  const n = typeof search.n === "number" && search.n > 0 ? search.n : undefined;
  const env = text(search.env);
  const project = text(search.project);
  const repo = text(search.repo);
  const tab = text(search.tab);
  return {
    ...(env !== undefined ? { env } : {}),
    ...(project !== undefined ? { project } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(n !== undefined ? { n } : {}),
    ...(tab !== undefined ? { tab } : {}),
  };
}

function Segments<Value extends string>(props: {
  readonly label: string;
  readonly value: Value;
  readonly options: ReadonlyArray<{ readonly value: Value; readonly label: string }>;
  readonly onChange: (value: Value) => void;
}) {
  return (
    <div role="radiogroup" aria-label={props.label} className="flex items-center gap-0.5">
      {props.options.map((option) => (
        <Button
          key={option.value}
          size="xs"
          role="radio"
          aria-checked={option.value === props.value}
          variant={option.value === props.value ? "secondary" : "ghost"}
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

function ListRow(props: { readonly entry: EnvironmentPullRequestEntry }) {
  const { entry } = props;
  const navigate = useNavigate();
  const blocker = pullRequestBlocker(entry);
  return (
    <div
      className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
      data-testid="pull-request-row"
      data-number={entry.number}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
        onClick={() =>
          void navigate({
            to: "/pull-requests",
            search: {
              env: entry.environmentId,
              project: entry.projectId,
              repo: entry.repository,
              n: entry.number,
            },
          })
        }
      >
        <PullRequestStateIcon
          state={entry.state}
          isDraft={entry.isDraft}
          className="size-4 shrink-0"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{entry.title}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {entry.repository} #{entry.number}
            {entry.author ? ` · ${entry.author.login}` : ""}
          </span>
        </span>
        {blocker !== null ? (
          <span
            className={cn(
              "hidden shrink-0 text-xs sm:block",
              blocker === "Conflicts" || blocker === "Checks failed"
                ? "text-red-600 dark:text-red-400"
                : "text-muted-foreground",
            )}
          >
            {blocker}
          </span>
        ) : null}
        <PullRequestChecksMark state={entry.checksState} />
        <span className="hidden shrink-0 text-xs tabular-nums sm:block">
          <span className="text-emerald-600">+{entry.additions}</span>{" "}
          <span className="text-red-600">-{entry.deletions}</span>
        </span>
      </button>
      <a
        href={entry.url}
        target="_blank"
        rel="noreferrer noopener"
        aria-label="Open on the site"
        className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      >
        <ExternalLinkIcon className="size-3.5" />
      </a>
    </div>
  );
}

const SORTS = Object.keys(SORT_LABELS) as ReadonlyArray<PullRequestListSort>;

function PullRequestList() {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const environmentIds = useMemo(
    () => [
      ...new Set(
        projects
          .filter((project) => !isAssistantProjectId(project.id))
          .map((project) => project.environmentId),
      ),
    ],
    [projects],
  );
  const [state, setState] = useState<PullRequestListState>("open");
  const [involvement, setInvolvement] = useState<PullRequestInvolvement>("all");
  const [sort, setSort] = useState<PullRequestListSort>("ready");
  const [search, setSearch] = useState("");

  const lists = useQueries({
    queries: environmentIds.map((environmentId) =>
      pullRequestListQuery(environmentId, { state, involvement }),
    ),
    combine: (results) => ({
      loaded: results.flatMap((result, index) =>
        result.data ? [{ environmentId: environmentIds[index]!, data: result.data }] : [],
      ),
      loading: results.some((result) => result.isLoading),
      failure: results.find((result) => result.error)?.error ?? null,
    }),
  });

  const merged = useMemo(() => mergePullRequestLists(lists.loaded), [lists.loaded]);
  const groups = useMemo(() => {
    const narrowed = filterPullRequestsByInvolvement(
      merged.entries,
      merged.viewers,
      involvement,
    ).filter((entry) => matchesPullRequestQuery(entry, search));
    return sortPullRequestGroups(
      groupPullRequestsByInvolvement(narrowed, merged.viewers),
      sort,
      search,
      involvement,
    );
  }, [merged, involvement, search, sort]);
  const disconnected = merged.providers.filter((provider) => !provider.configured);
  const rows = groups.reduce((total, group) => total + group.entries.length, 0);

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-1.5 sm:px-5">
        <Segments label="State" value={state} options={LIST_STATES} onChange={setState} />
        <Segments
          label="Involvement"
          value={involvement}
          options={INVOLVEMENTS}
          onChange={setInvolvement}
        />
        <Menu>
          <MenuTrigger
            render={<Button size="xs" variant="ghost" />}
            data-testid="pull-request-sort"
          >
            <ListFilterIcon />
            {SORT_LABELS[sort]}
          </MenuTrigger>
          <MenuPopup align="start">
            {SORTS.map((option) => (
              <MenuItem key={option} onClick={() => setSort(option)}>
                {SORT_LABELS[option]}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
        <Input
          size="sm"
          className="ml-auto w-44"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search"
          aria-label="Search pull requests"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-2 sm:px-3">
        {disconnected.map((provider) => (
          <p
            key={`${provider.kind}:${provider.host}`}
            className="px-2 pb-2 text-sm text-muted-foreground"
            data-testid="pull-request-provider-note"
          >
            {provider.detail}{" "}
            {provider.detail?.includes("Settings") ? (
              <Link to="/settings/source-control" className="underline">
                Open
              </Link>
            ) : null}
          </p>
        ))}
        {lists.loading && rows === 0 ? (
          <div className="flex flex-col gap-2 px-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : null}
        {!lists.loading && lists.failure !== null && rows === 0 ? (
          <p className="px-2 text-sm text-muted-foreground">{lists.failure.message}</p>
        ) : null}
        {!lists.loading && lists.failure === null && rows === 0 && disconnected.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground" data-testid="pull-requests-empty">
            {merged.providers.length === 0
              ? "No project here has a hosted repository yet."
              : "No pull requests."}
          </p>
        ) : null}
        {groups.map((group) => (
          <section key={group.key} className="mb-3">
            {groups.length > 1 ? (
              <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">
                {group.label} {group.entries.length}
              </h2>
            ) : null}
            {group.entries.map((entry) => (
              <ListRow key={pullRequestEntryKey(entry)} entry={entry} />
            ))}
          </section>
        ))}
        {merged.truncated ? (
          <p className="px-2 text-xs text-muted-foreground">Showing the latest.</p>
        ) : null}
      </div>
    </>
  );
}

export function PullRequestsView(props: { readonly search: PullRequestsSearch }) {
  const devMode = useDevMode();
  const { env, project, repo, n, tab } = props.search;
  // Off Dev mode the address leads nowhere: nobody else sees this page.
  if (!devMode) return <Navigate to="/" replace />;
  const opened =
    env !== undefined && project !== undefined && repo !== undefined && n !== undefined;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
        data-testid="pull-requests-view"
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 sm:px-5">
          <SidebarShowButton />
          <GitPullRequestIcon className="size-4 text-muted-foreground" />
          <h1 className="text-sm font-medium">Pull requests</h1>
        </header>
        {opened ? (
          <PullRequestDetail
            environmentId={env}
            reference={{
              projectId: project as never,
              repository: repo as never,
              number: n as never,
            }}
            tab={tab ?? "summary"}
          />
        ) : (
          <PullRequestList />
        )}
      </div>
    </SidebarInset>
  );
}
