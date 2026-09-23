/**
 * "What's using your computer" — the drill-down behind the processor, memory,
 * disk and network tiles of "This computer". Activity Monitor, in words a
 * person uses: who is busy (an app, a container, a chat's agent, a terminal,
 * the system), what fills the disk, and the buttons that fix it right there —
 * stop it, quit it, clean it, ask Uno, or give the computer more room.
 *
 * Everything is read by this environment's daemon from its own OS; the
 * buttons only name what the daemon found, and it checks again before acting.
 */
import type {
  EnvironmentId,
  ThreadId,
  UnoComputerResources,
  UnoDiskUsage,
  UnoResourceGroup,
  UnoResourceProcess,
} from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  AppWindowIcon,
  ArrowLeftIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  BoxIcon,
  ChevronRightIcon,
  CloudIcon,
  CpuIcon,
  FolderOpenIcon,
  HardDriveIcon,
  MemoryStickIcon,
  MessageSquareIcon,
  MonitorIcon,
  NetworkIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCwIcon,
  SettingsIcon,
  SparklesIcon,
  SquareIcon,
  TerminalIcon,
  TrashIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";

import { cn } from "~/lib/utils";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../../../store";
import { buildThreadRouteParams } from "../../../threadRoutes";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Button } from "../../ui/button";
import { Skeleton } from "../../ui/skeleton";
import { Spinner } from "../../ui/spinner";
import { Meter } from "../computerUi";
import {
  askUnoPrompt,
  breadcrumbs,
  formatBytes,
  formatMb,
  formatPct,
  formatRate,
  matchChat,
  memoryBar,
  memoryPressurePct,
  resourceTips,
  seriesPath,
  type ChatCandidate,
  type ResourceLook,
  type ResourceTip,
} from "./resourceModel";
import {
  diskCleanMutationOptions,
  diskUsageQueryOptions,
  rescanDisk,
  resourceActionMutationOptions,
  resourcesQueryOptions,
} from "./resourceQueries";

const LOOKS: ReadonlyArray<{ look: ResourceLook; label: string; icon: ReactNode }> = [
  { look: "cpu", label: "Processor", icon: <CpuIcon /> },
  { look: "memory", label: "Memory", icon: <MemoryStickIcon /> },
  { look: "disk", label: "Working disk", icon: <HardDriveIcon /> },
  { look: "network", label: "Network", icon: <NetworkIcon /> },
];

const KIND_ICON: Record<UnoResourceGroup["kind"], ReactNode> = {
  app: <AppWindowIcon />,
  docker: <BoxIcon />,
  service: <SettingsIcon />,
  chat: <MessageSquareIcon />,
  terminal: <TerminalIcon />,
  unowork: <SparklesIcon />,
  program: <AppWindowIcon />,
  system: <MonitorIcon />,
};

export interface ResourcesViewProps {
  environmentId: EnvironmentId | null;
  look: ResourceLook;
  onLookChange: (look: ResourceLook) => void;
  onBack: () => void;
  /** Opens "Add memory / cores / disk"; absent when this computer can't grow from here. */
  onResize?: (() => void) | undefined;
  /** Starts a chat with a note already typed. */
  onAskUno: (prompt: string) => void | Promise<void>;
}

export function ResourcesView({
  environmentId,
  look,
  onLookChange,
  onBack,
  onResize,
  onAskUno,
}: ResourcesViewProps) {
  const resourcesQuery = useQuery(resourcesQueryOptions(environmentId));
  const [diskPath, setDiskPath] = useState<string | null>(null);
  const diskQuery = useQuery(diskUsageQueryOptions(environmentId, diskPath, look === "disk"));
  const homeDiskQuery = useQuery(diskUsageQueryOptions(environmentId, null, look === "disk"));
  const resources = resourcesQuery.data ?? null;
  const tips = resources ? resourceTips(resources, homeDiskQuery.data ?? null) : [];
  const [asking, setAsking] = useState(false);

  const ask = async () => {
    setAsking(true);
    try {
      await onAskUno(askUnoPrompt(look, resources, diskQuery.data ?? null));
    } finally {
      setAsking(false);
    }
  };

  const resizeLabel =
    look === "disk" ? "Add disk space" : look === "memory" ? "Add memory" : "Add cores";

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeftIcon />
          This computer
        </Button>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void ask()} disabled={asking}>
            {asking ? <Spinner className="size-3.5" /> : <SparklesIcon />}
            Ask Uno to look
          </Button>
          {onResize ? (
            <Button size="sm" onClick={onResize}>
              <PlusIcon />
              {resizeLabel}
            </Button>
          ) : null}
        </div>
      </div>

      <div>
        <h1 className="text-xl font-semibold tracking-tight">What's using your computer</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Live, updated every few seconds. Click anything to see what's inside and what you can do
          with it.
        </p>
      </div>

      <LookTabs look={look} onLookChange={onLookChange} resources={resources} />

      {tips
        .filter((tip) => tip.look === look)
        .map((tip) => (
          <TipBanner
            key={tip.look}
            tip={tip}
            onResize={tip.suggestResize ? onResize : undefined}
            onAsk={() => void ask()}
          />
        ))}

      {resourcesQuery.isError && !resources ? (
        <p className="rounded-2xl bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          Couldn't read this computer just now. It will try again by itself.
        </p>
      ) : !resources ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-40 w-full rounded-2xl" />
          <Skeleton className="h-64 w-full rounded-2xl" />
        </div>
      ) : look === "cpu" ? (
        <CpuPanel resources={resources} environmentId={environmentId} highlight={tips} />
      ) : look === "memory" ? (
        <MemoryPanel resources={resources} environmentId={environmentId} highlight={tips} />
      ) : look === "disk" ? (
        <DiskPanel
          environmentId={environmentId}
          resources={resources}
          disk={diskQuery.data ?? null}
          loading={diskQuery.isPending}
          error={diskQuery.error instanceof Error ? diskQuery.error.message : null}
          onOpenFolder={setDiskPath}
        />
      ) : (
        <NetworkPanel resources={resources} />
      )}

      {resources && resources.notes.length > 0 ? (
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          {resources.notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function LookTabs({
  look,
  onLookChange,
  resources,
}: {
  look: ResourceLook;
  onLookChange: (look: ResourceLook) => void;
  resources: UnoComputerResources | null;
}) {
  const value = (l: ResourceLook): string => {
    if (!resources) return "…";
    switch (l) {
      case "cpu":
        return resources.cpuPct === null ? "—" : formatPct(resources.cpuPct);
      case "memory":
        return formatPct(memoryPressurePct(resources.memory));
      case "disk": {
        const v = resources.volumes[0];
        return v && v.totalGb > 0 ? formatPct((v.usedGb / v.totalGb) * 100) : "—";
      }
      case "network":
        return resources.netRxBps === null
          ? "—"
          : formatRate((resources.netRxBps ?? 0) + (resources.netTxBps ?? 0));
    }
  };
  return (
    <div
      role="tablist"
      aria-label="What to look at"
      className="grid grid-cols-2 gap-2 sm:grid-cols-4"
    >
      {LOOKS.map((item) => {
        const selected = item.look === look;
        return (
          <button
            key={item.look}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onLookChange(item.look)}
            className={cn(
              "flex items-center gap-3 rounded-2xl px-4 py-3 text-left ring-1 transition-colors outline-hidden focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4",
              selected
                ? "bg-primary/10 text-foreground ring-primary/50"
                : "bg-card/40 text-muted-foreground ring-border/60 hover:bg-accent/50",
            )}
          >
            <span className={cn(selected ? "text-primary" : "text-muted-foreground")}>
              {item.icon}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-xs">{item.label}</span>
              <span className="truncate text-base font-semibold tabular-nums text-foreground">
                {value(item.look)}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function TipBanner({
  tip,
  onResize,
  onAsk,
}: {
  tip: ResourceTip;
  onResize?: (() => void) | undefined;
  onAsk: () => void;
}) {
  return (
    <div
      role="status"
      className="flex flex-col gap-3 rounded-2xl bg-warning/10 px-4 py-3 ring-1 ring-warning/30 sm:flex-row sm:items-center"
    >
      <TriangleAlertIcon className="size-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{tip.title}</p>
        <p className="text-xs text-muted-foreground">{tip.body}</p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button size="xs" variant="outline" onClick={onAsk}>
          <SparklesIcon />
          Ask Uno
        </Button>
        {onResize ? (
          <Button size="xs" onClick={onResize}>
            <PlusIcon />
            {tip.look === "disk"
              ? "Add disk space"
              : tip.look === "memory"
                ? "Add memory"
                : "Add cores"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Card({
  title,
  action,
  children,
  className,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col gap-4 rounded-2xl border border-border/60 bg-card/40 p-5",
        className,
      )}
    >
      {title || action ? (
        <header className="flex items-center gap-2">
          {title ? <h2 className="text-sm font-semibold">{title}</h2> : null}
          {action ? <div className="ml-auto flex items-center gap-1">{action}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

function UsageChart({
  values,
  max,
  stepS,
  label,
  formatMax,
  tone = "primary",
}: {
  values: ReadonlyArray<number | null>;
  max: number;
  stepS: number;
  label: string;
  formatMax: string;
  tone?: "primary" | "info";
}) {
  const W = 600;
  const H = 110;
  const { line, area } = seriesPath(values, W, H, max);
  const minutes = Math.max(1, Math.round((values.length * stepS) / 60));
  return (
    <figure className="flex flex-col gap-1.5" aria-label={label}>
      <div className="relative h-28 w-full overflow-hidden rounded-xl bg-muted/30 ring-1 ring-border/50">
        {line ? (
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className={cn(
              "absolute inset-0 size-full",
              tone === "primary" ? "text-primary" : "text-info",
            )}
          >
            <line
              x1="0"
              x2={W}
              y1={H / 2}
              y2={H / 2}
              className="stroke-border"
              strokeDasharray="4 6"
            />
            <path d={area} className="fill-current opacity-15" />
            <path
              d={line}
              className="fill-none stroke-current"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        ) : (
          <p className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
            The graph fills in over the next minute.
          </p>
        )}
        <span className="absolute top-1.5 right-2 text-[10px] text-muted-foreground tabular-nums">
          {formatMax}
        </span>
      </div>
      <figcaption className="flex justify-between text-[10px] text-muted-foreground">
        <span>{line ? `${minutes} min ago` : ""}</span>
        <span>now</span>
      </figcaption>
    </figure>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function CpuPanel({
  resources,
  environmentId,
  highlight,
}: {
  resources: UnoComputerResources;
  environmentId: EnvironmentId | null;
  highlight: ReadonlyArray<ResourceTip>;
}) {
  return (
    <>
      <Card>
        <div className="grid grid-cols-3 gap-4">
          <Stat
            label="Busy now"
            value={resources.cpuPct === null ? "—" : formatPct(resources.cpuPct)}
          />
          <Stat
            label="Cores"
            value={String(resources.cpuCount)}
            hint="Each core runs one thing at a time"
          />
          <Stat
            label="Waiting in line"
            value={resources.load1 === null ? "—" : resources.load1.toFixed(1)}
            hint={
              resources.load1 !== null && resources.load1 > resources.cpuCount
                ? "More work than cores — things wait"
                : "Less than the cores — no waiting"
            }
          />
        </div>
        <UsageChart
          values={resources.history.map((p) => p.cpuPct)}
          max={100}
          stepS={resources.historyStepS}
          label="Processor over the last minutes"
          formatMax="100%"
        />
      </Card>
      <GroupList
        title="Who's using the processor"
        resources={resources}
        sortBy="cpu"
        environmentId={environmentId}
        highlightId={highlight.find((t) => t.look === "cpu")?.groupId ?? null}
      />
    </>
  );
}

function MemoryPanel({
  resources,
  environmentId,
  highlight,
}: {
  resources: UnoComputerResources;
  environmentId: EnvironmentId | null;
  highlight: ReadonlyArray<ResourceTip>;
}) {
  const m = resources.memory;
  const bar = memoryBar(m);
  return (
    <>
      <Card>
        <div
          className="flex h-4 w-full overflow-hidden rounded-full bg-muted"
          aria-label="How memory is used"
        >
          <div className="h-full bg-primary" style={{ width: `${bar.usedPct}%` }} />
          <div className="h-full bg-info/50" style={{ width: `${bar.cachePct}%` }} />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Legend
            swatch="bg-primary"
            label="Used by programs"
            value={formatMb(m.usedMb)}
            hint="What your apps, chats and the system hold right now."
          />
          <Legend
            swatch="bg-info/50"
            label="Cache"
            value={formatMb(m.cacheMb)}
            hint="Recently used files kept in memory to be fast. Not a problem — it's handed back the moment a program needs it."
          />
          <Legend
            swatch="bg-muted ring-1 ring-border"
            label="Free"
            value={formatMb(m.freeMb)}
            hint={`Programs can still get ${formatMb(m.availableMb)} of ${formatMb(m.totalMb)} (free + cache).`}
          />
        </div>
        {m.swapTotalMb > 0 ? (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              Swap: {formatMb(m.swapUsedMb)} of {formatMb(m.swapTotalMb)}.
            </span>{" "}
            {m.swapUsedMb > 256
              ? "When memory runs out, the computer parks some of it on the disk. The disk is much slower, so a lot of swap means it's time to stop something or add memory."
              : "Disk space the computer can use as extra memory in a pinch. Barely used — good."}
          </p>
        ) : null}
        <UsageChart
          values={resources.history.map((p) => p.memUsedMb)}
          max={m.totalMb}
          stepS={resources.historyStepS}
          label="Memory used over the last minutes"
          formatMax={formatMb(m.totalMb)}
        />
      </Card>
      <GroupList
        title="Who's using memory"
        resources={resources}
        sortBy="memory"
        environmentId={environmentId}
        highlightId={highlight.find((t) => t.look === "memory")?.groupId ?? null}
      />
    </>
  );
}

function Legend({
  swatch,
  label,
  value,
  hint,
}: {
  swatch: string;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="flex gap-2.5">
      <span className={cn("mt-1 size-2.5 shrink-0 rounded-sm", swatch)} aria-hidden />
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-base font-semibold tabular-nums">{value}</p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

function NetworkPanel({ resources }: { resources: UnoComputerResources }) {
  if (resources.netRxBps === null && resources.history.every((p) => p.netRxBps === null)) {
    return (
      <Card>
        <p className="text-sm text-muted-foreground">
          Network use is shown on Uno computers (Linux). This machine doesn't report it here.
        </p>
      </Card>
    );
  }
  const maxRate = Math.max(
    64 * 1024,
    ...resources.history.map((p) => Math.max(p.netRxBps ?? 0, p.netTxBps ?? 0)),
  );
  return (
    <Card>
      <div className="grid grid-cols-2 gap-4">
        <Stat
          label="Coming in"
          value={formatRate(resources.netRxBps)}
          hint="Downloads, pages, updates"
        />
        <Stat
          label="Going out"
          value={formatRate(resources.netTxBps)}
          hint="Uploads, your apps answering"
        />
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <ArrowDownIcon className="size-3.5 text-primary" /> In
      </div>
      <UsageChart
        values={resources.history.map((p) => p.netRxBps)}
        max={maxRate}
        stepS={resources.historyStepS}
        label="Coming in over the last minutes"
        formatMax={formatRate(maxRate)}
      />
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <ArrowUpIcon className="size-3.5 text-info" /> Out
      </div>
      <UsageChart
        values={resources.history.map((p) => p.netTxBps)}
        max={maxRate}
        stepS={resources.historyStepS}
        label="Going out over the last minutes"
        formatMax={formatRate(maxRate)}
        tone="info"
      />
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Who is using it
 * ------------------------------------------------------------------ */

type Confirm =
  | { kind: "process"; groupName: string; process: UnoResourceProcess; forced: boolean }
  | { kind: "group"; group: UnoResourceGroup; action: "stop" | "restart" };

function useChatCandidates(environmentId: EnvironmentId | null): ChatCandidate[] {
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  return useMemo(() => {
    const cwdOfProject = new Map(projects.map((p) => [`${p.environmentId}:${p.id}`, p.cwd]));
    return threads
      .filter((t) => t.environmentId === environmentId && t.archivedAt === null)
      .flatMap((t) => {
        const cwd = t.worktreePath ?? cwdOfProject.get(`${t.environmentId}:${t.projectId}`);
        if (!cwd) return [];
        return [
          {
            id: t.id,
            environmentId: t.environmentId,
            title: t.title,
            cwd,
            active: t.session !== null && t.session.status !== "closed",
            updatedAt: t.updatedAt ?? t.createdAt,
          },
        ];
      });
  }, [environmentId, projects, threads]);
}

function GroupList({
  title,
  resources,
  sortBy,
  environmentId,
  highlightId,
}: {
  title: string;
  resources: UnoComputerResources;
  sortBy: "cpu" | "memory";
  environmentId: EnvironmentId | null;
  highlightId: string | null;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const action = useMutation(resourceActionMutationOptions(environmentId, queryClient));
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [result, setResult] = useState<{ message: string; error: boolean } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const chats = useChatCandidates(environmentId);

  const groups = resources.groups.toSorted((a, b) =>
    sortBy === "cpu" ? b.cpuPct - a.cpuPct || b.memMb - a.memMb : b.memMb - a.memMb,
  );
  const visible = showAll ? groups : groups.slice(0, 12);

  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const run = async (c: Confirm) => {
    setResult(null);
    try {
      const answer =
        c.kind === "process"
          ? await action.mutateAsync({
              kind: "process",
              pid: c.process.pid,
              startToken: c.process.startToken,
              signal: c.forced ? "force" : "quit",
            })
          : await action.mutateAsync({ kind: "group", groupId: c.group.id, action: c.action });
      if (!answer.done && c.kind === "process" && !c.forced) {
        setConfirm({ ...c, forced: true });
        setResult({ message: answer.message, error: true });
        return;
      }
      setConfirm(null);
      setResult({ message: answer.message, error: false });
    } catch (error) {
      setConfirm(null);
      setResult({
        message: error instanceof Error ? error.message : "That didn't work.",
        error: true,
      });
    }
  };

  return (
    <Card
      title={title}
      action={
        <span className="text-xs text-muted-foreground">{resources.processCount} processes</span>
      }
    >
      {result ? (
        <p
          role="status"
          className={cn(
            "sticky top-2 z-10 rounded-xl px-3 py-2 text-xs shadow-sm backdrop-blur",
            result.error ? "bg-destructive/15 text-destructive" : "bg-success/15 text-foreground",
          )}
        >
          {result.message}
        </p>
      ) : null}
      <ul className="flex flex-col divide-y divide-border/60">
        {visible.map((group) => {
          const chat = group.kind === "chat" ? matchChat(group.cwd, chats) : null;
          return (
            <GroupRow
              key={group.id}
              group={group}
              sortBy={sortBy}
              totalMemMb={resources.memory.totalMb}
              open={open.has(group.id)}
              highlighted={group.id === highlightId}
              chatTitle={chat?.title ?? null}
              busy={action.isPending}
              onToggle={() => toggle(group.id)}
              onOpenChat={
                chat
                  ? () =>
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: buildThreadRouteParams({
                          environmentId: chat.environmentId as EnvironmentId,
                          threadId: chat.id as ThreadId,
                        }),
                      })
                  : undefined
              }
              onOpenFolder={
                group.cwd && group.kind !== "chat"
                  ? () => void navigate({ to: "/files", search: { path: group.cwd! } })
                  : undefined
              }
              onGroupAction={(a) => setConfirm({ kind: "group", group, action: a })}
              onQuit={(process) =>
                setConfirm({ kind: "process", groupName: group.name, process, forced: false })
              }
            />
          );
        })}
      </ul>
      {groups.length > visible.length ? (
        <Button size="xs" variant="ghost" onClick={() => setShowAll(true)}>
          Show {groups.length - visible.length} more
        </Button>
      ) : null}

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmTitle(confirm)}</AlertDialogTitle>
            <AlertDialogDescription>{confirmBody(confirm)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant={
                confirm?.kind === "process" || confirm?.action === "stop"
                  ? "destructive"
                  : "default"
              }
              disabled={action.isPending}
              onClick={() => confirm && void run(confirm)}
            >
              {action.isPending ? <Spinner className="size-3.5" /> : null}
              {confirm?.kind === "process"
                ? confirm.forced
                  ? "Force quit"
                  : "Quit"
                : confirm?.action === "restart"
                  ? "Restart"
                  : "Stop"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </Card>
  );
}

function confirmTitle(c: Confirm | null): string {
  if (!c) return "";
  if (c.kind === "process")
    return c.forced ? `Force ${c.process.name} to quit?` : `Quit ${c.process.name}?`;
  return c.action === "restart" ? `Restart ${c.group.name}?` : `Stop ${c.group.name}?`;
}

function confirmBody(c: Confirm | null): string {
  if (!c) return "";
  if (c.kind === "process") {
    return c.forced
      ? "It didn't quit when asked. Forcing it stops it at once — anything it hasn't saved is lost."
      : `This asks ${c.process.name}${c.groupName !== c.process.name ? ` (part of ${c.groupName})` : ""} to close. Anything it hasn't saved may be lost.`;
  }
  if (c.action === "restart") {
    return `${c.group.name} stops and starts again. It's unavailable for a few seconds.`;
  }
  switch (c.group.kind) {
    case "app":
    case "docker":
    case "service":
      return `${c.group.name} stops until you start it again from This computer. Its files and data stay.`;
    case "terminal":
      return "Everything running in this terminal is closed.";
    default:
      return `All of ${c.group.name} is asked to close. Anything it hasn't saved may be lost.`;
  }
}

function GroupRow({
  group,
  sortBy,
  totalMemMb,
  open,
  highlighted,
  chatTitle,
  busy,
  onToggle,
  onOpenChat,
  onOpenFolder,
  onGroupAction,
  onQuit,
}: {
  group: UnoResourceGroup;
  sortBy: "cpu" | "memory";
  totalMemMb: number;
  open: boolean;
  highlighted: boolean;
  chatTitle: string | null;
  busy: boolean;
  onToggle: () => void;
  onOpenChat?: (() => void) | undefined;
  onOpenFolder?: (() => void) | undefined;
  onGroupAction: (action: "stop" | "restart") => void;
  onQuit: (process: UnoResourceProcess) => void;
}) {
  const detail = group.kind === "chat" && chatTitle ? `Chat · ${chatTitle}` : group.detail;
  return (
    <li className={cn("py-2", highlighted && "-mx-2 rounded-xl bg-warning/5 px-2")}>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg py-1 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-sm text-muted-foreground [&_svg]:size-4">
            {group.icon ?? KIND_ICON[group.kind]}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium">{group.name}</span>
            <span className="truncate text-xs text-muted-foreground">
              {detail ?? ""}
              {group.processCount > 1 ? ` · ${group.processCount} processes` : ""}
            </span>
          </span>
          <span className="hidden w-28 flex-col gap-1 sm:flex">
            <Meter
              value={
                sortBy === "cpu"
                  ? group.cpuPct
                  : Math.min(100, (group.memMb / Math.max(1, totalMemMb)) * 100)
              }
            />
          </span>
          <span className="w-14 shrink-0 text-right text-sm tabular-nums">
            {formatPct(group.cpuPct)}
          </span>
          <span className="w-20 shrink-0 text-right text-sm tabular-nums">
            {formatMb(group.memMb)}
          </span>
        </button>
      </div>

      {open ? (
        <div className="mt-2 ml-9 flex flex-col gap-2 rounded-xl bg-muted/30 p-3">
          <div className="flex flex-wrap items-center gap-2">
            {onOpenChat ? (
              <Button size="xs" variant="outline" onClick={onOpenChat}>
                <MessageSquareIcon />
                Open the chat
              </Button>
            ) : null}
            {onOpenFolder ? (
              <Button size="xs" variant="outline" onClick={onOpenFolder}>
                <FolderOpenIcon />
                Open folder
              </Button>
            ) : null}
            {group.actions.includes("restart") ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => onGroupAction("restart")}
              >
                <RotateCwIcon />
                Restart
              </Button>
            ) : null}
            {group.actions.includes("stop") ? (
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={busy}
                onClick={() => onGroupAction("stop")}
              >
                <SquareIcon />
                {group.kind === "program" || group.kind === "terminal" ? "Quit all" : "Stop"}
              </Button>
            ) : null}
            {group.actions.length === 0 && group.actionsBlockedReason ? (
              <span className="text-xs text-muted-foreground">{group.actionsBlockedReason}</span>
            ) : null}
          </div>
          <table className="w-full table-fixed text-xs">
            <thead className="text-left text-[11px] text-muted-foreground">
              <tr>
                <th className="py-1 font-normal">Process</th>
                <th className="w-14 py-1 text-right font-normal">CPU</th>
                <th className="w-20 py-1 text-right font-normal">Memory</th>
                <th className="w-20 py-1" />
              </tr>
            </thead>
            <tbody>
              {group.processes.map((p) => (
                <tr key={p.pid} className="align-top">
                  <td className="py-1 pr-2">
                    <div className="truncate font-medium" title={p.name}>
                      {p.name}
                    </div>
                    {p.command ? (
                      <div
                        className="truncate font-mono text-[10px] text-muted-foreground"
                        title={p.command}
                      >
                        {p.command}
                      </div>
                    ) : null}
                  </td>
                  <td className="py-1 text-right tabular-nums">{formatPct(p.cpuPct)}</td>
                  <td className="py-1 text-right tabular-nums">{formatMb(p.memMb)}</td>
                  <td className="py-1 text-right">
                    {p.canQuit ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => onQuit(p)}
                        aria-label={`Quit ${p.name}`}
                      >
                        <XIcon />
                        Quit
                      </Button>
                    ) : (
                      <span
                        className="text-[10px] text-muted-foreground"
                        title={p.protectedReason ?? undefined}
                      >
                        {p.own ? "protected" : "system"}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {group.processCount > group.processes.length ? (
            <p className="text-[11px] text-muted-foreground">
              And {group.processCount - group.processes.length} smaller ones.
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/* ------------------------------------------------------------------ *
 * Disk
 * ------------------------------------------------------------------ */

function DiskPanel({
  environmentId,
  resources,
  disk,
  loading,
  error,
  onOpenFolder,
}: {
  environmentId: EnvironmentId | null;
  resources: UnoComputerResources;
  disk: UnoDiskUsage | null;
  loading: boolean;
  error: string | null;
  onOpenFolder: (path: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const clean = useMutation(diskCleanMutationOptions(environmentId, queryClient));
  const [confirmClean, setConfirmClean] = useState<UnoDiskUsage["cleanables"][number] | null>(null);
  const [cleanResult, setCleanResult] = useState<{ message: string; error: boolean } | null>(null);
  const [rescanning, setRescanning] = useState(false);
  const isHome = disk ? disk.path === disk.home : true;
  const maxEntry = Math.max(1, ...(disk?.entries.map((e) => e.bytes) ?? [1]));

  const rescan = async () => {
    setRescanning(true);
    try {
      await rescanDisk(environmentId, disk && !isHome ? disk.path : null, queryClient);
    } finally {
      setRescanning(false);
    }
  };

  return (
    <>
      <Card>
        {resources.volumes.map((v) => {
          const pct = v.totalGb > 0 ? (v.usedGb / v.totalGb) * 100 : 0;
          return (
            <div key={v.mount} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-medium">{v.label}</span>
                <span className="tabular-nums text-muted-foreground">
                  {v.usedGb.toFixed(1)} GB used of {v.totalGb.toFixed(1)} GB ·{" "}
                  <span className="text-foreground">{v.freeGb.toFixed(1)} GB free</span>
                </span>
              </div>
              <Meter value={pct} className="h-2.5" />
            </div>
          );
        })}
        {disk?.outsideHomeBytes != null && isHome ? (
          <p className="text-xs text-muted-foreground">
            Your home folder holds {formatBytes(disk.totalBytes)}. The other{" "}
            {formatBytes(disk.outsideHomeBytes)} is the system itself, installed programs and
            Docker.
          </p>
        ) : null}
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <CloudIcon className="mt-0.5 size-3.5 shrink-0 text-sky-500" aria-hidden />
          <span>
            The working disk is where programs run: their databases, caches and temporary files.
            Photos, documents and archives belong in{" "}
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => void navigate({ to: "/files", search: { cloud: "1" } })}
            >
              Cloud storage
            </button>{" "}
            — it costs much less and apps you make here keep their files there.
          </span>
        </p>
      </Card>

      <Card
        title="What takes the space"
        action={
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void rescan()}
            disabled={rescanning || disk?.scanning === true}
            aria-label="Measure again"
          >
            {rescanning || disk?.scanning ? <Spinner className="size-3.5" /> : <RefreshCwIcon />}
            {disk?.scanning ? "Measuring…" : "Measure again"}
          </Button>
        }
      >
        {disk ? (
          <nav className="flex flex-wrap items-center gap-1 text-xs" aria-label="Folder">
            {breadcrumbs(disk.home, disk.path).map((crumb, index, all) => (
              <span key={crumb.path} className="flex items-center gap-1">
                {index > 0 ? <ChevronRightIcon className="size-3 text-muted-foreground" /> : null}
                {index === all.length - 1 ? (
                  <span className="font-medium">{crumb.name}</span>
                ) : (
                  <button
                    type="button"
                    className="text-primary hover:underline"
                    onClick={() => onOpenFolder(index === 0 ? null : crumb.path)}
                  >
                    {crumb.name}
                  </button>
                )}
              </span>
            ))}
            <span className="ml-auto flex items-center gap-2">
              {disk.totalBytes !== null ? (
                <span className="text-muted-foreground">{formatBytes(disk.totalBytes)} in all</span>
              ) : null}
              <Button
                size="xs"
                variant="outline"
                onClick={() => void navigate({ to: "/files", search: { path: disk.path } })}
              >
                <FolderOpenIcon />
                Open in Files
              </Button>
            </span>
          </nav>
        ) : null}
        {error ? (
          <p className="text-xs text-destructive">{error}</p>
        ) : loading || (disk?.scanning && disk.entries.length === 0) ? (
          <div className="flex flex-col gap-2">
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" /> Measuring folders… on a big disk this takes a minute.
              The computer stays usable meanwhile.
            </p>
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-3/4" />
          </div>
        ) : disk && disk.entries.length === 0 ? (
          <p className="text-xs text-muted-foreground">{disk.error ?? "This folder is empty."}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {disk?.entries.slice(0, 40).map((entry) => (
              <li key={entry.path}>
                <div className="group flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-accent/40">
                  <button
                    type="button"
                    disabled={!entry.isDir}
                    onClick={() => onOpenFolder(entry.path)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                    title={entry.isDir ? `Look inside ${entry.name}` : entry.name}
                    aria-label={
                      entry.isDir
                        ? `Look inside ${entry.name}, ${formatBytes(entry.bytes)}`
                        : `${entry.name}, ${formatBytes(entry.bytes)}`
                    }
                  >
                    <span className="w-44 truncate text-sm sm:w-56">
                      {entry.name}
                      {entry.isDir ? "/" : ""}
                    </span>
                    <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-muted">
                      <span
                        className="absolute inset-y-0 left-0 rounded-full bg-primary/70"
                        style={{ width: `${Math.max(1, (entry.bytes / maxEntry) * 100)}%` }}
                      />
                    </span>
                    <span className="w-20 shrink-0 text-right text-sm tabular-nums">
                      {formatBytes(entry.bytes)}
                    </span>
                  </button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Open ${entry.name} in Files`}
                    className="opacity-60 group-hover:opacity-100"
                    onClick={() =>
                      void navigate({
                        to: "/files",
                        search: entry.isDir
                          ? { path: entry.path }
                          : { path: disk.path, file: entry.path },
                      })
                    }
                  >
                    <FolderOpenIcon />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {disk && disk.unreadable > 0 ? (
          <p className="text-[11px] text-muted-foreground">
            {disk.unreadable} folder{disk.unreadable === 1 ? "" : "s"} couldn't be read (they belong
            to the system), so the total may be a little higher.
          </p>
        ) : null}
      </Card>

      {isHome ? (
        <Card title="Free up space safely">
          {cleanResult ? (
            <p
              role="status"
              className={cn(
                "rounded-xl px-3 py-2 text-xs",
                cleanResult.error
                  ? "bg-destructive/10 text-destructive"
                  : "bg-success/10 text-foreground",
              )}
            >
              {cleanResult.message}
            </p>
          ) : null}
          {!disk || (disk.scanning && disk.cleanables.length === 0) ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" /> Looking for caches and leftovers…
            </p>
          ) : disk.cleanables.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nothing to clean — no big caches or leftovers here.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border/60">
              {disk.cleanables.map((item) => (
                <li key={item.id} className="flex items-center gap-3 py-2">
                  <TrashIcon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{item.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.blockedReason ?? item.description}
                    </p>
                  </div>
                  <span className="w-20 shrink-0 text-right text-sm tabular-nums">
                    {formatBytes(item.bytes)}
                  </span>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!item.canClean || clean.isPending}
                    onClick={() => {
                      setCleanResult(null);
                      setConfirmClean(item);
                    }}
                  >
                    Clean
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {disk && disk.docker.access === "ok" ? (
            <p className="text-xs text-muted-foreground">
              Docker: images {formatBytes(disk.docker.imagesBytes)}, containers{" "}
              {formatBytes(disk.docker.containersBytes)}, data volumes{" "}
              {formatBytes(disk.docker.volumesBytes)}, build cache{" "}
              {formatBytes(disk.docker.buildCacheBytes)}. Data volumes hold your apps' data and are
              never cleaned from here.
            </p>
          ) : disk && disk.docker.access === "no-access" ? (
            <p className="text-xs text-muted-foreground">
              Docker runs on this computer, but Uno Work isn't allowed to look inside it, so its
              images and data are counted in "the system" above.
            </p>
          ) : null}
        </Card>
      ) : null}

      <AlertDialog open={confirmClean !== null} onOpenChange={(o) => !o && setConfirmClean(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Clean {confirmClean?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmClean?.description} This frees about {formatBytes(confirmClean?.bytes)}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              disabled={clean.isPending}
              onClick={() => {
                if (!confirmClean) return;
                clean.mutate(
                  { id: confirmClean.id },
                  {
                    onSuccess: (answer) => {
                      setConfirmClean(null);
                      setCleanResult({ message: answer.message, error: false });
                    },
                    onError: (e) => {
                      setConfirmClean(null);
                      setCleanResult({
                        message: e instanceof Error ? e.message : "Cleaning didn't finish.",
                        error: true,
                      });
                    },
                  },
                );
              }}
            >
              {clean.isPending ? <Spinner className="size-3.5" /> : <TrashIcon />}
              Clean
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
