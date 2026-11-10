/**
 * Workspace (vision 10.11): the top of Uno Work. One "liquid computer" —
 * the workspace lives in the account's cloud (chats, assistants, apps,
 * memory: always on), and everything it runs on is its hardware: computers
 * in the cloud and at home, asleep or away, Spark functions, data, Drive,
 * git, addresses.
 *
 *   Apps     : every app of the workspace, opened from any computer; each
 *              says what it uses and what opening it takes (nothing, a
 *              wake-up, or a laptop that is away).
 *   Hardware : every part with its state and who uses it; a computer's
 *              terminal and files stay with that computer.
 *
 * Reads only `GET /api/v1/workspace` (./api.ts).
 */
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import {
  CloudIcon,
  LayersIcon,
  LoaderCircleIcon,
  SunIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";

import { useMediaQuery } from "../hooks/useMediaQuery";
import { cn } from "../lib/utils";
import { openInNewTab } from "../navigation/useOpenApp";
import { useHomeLaunchers } from "../components/computer/useHomeLaunchers";
import { GroupTitle, Row, RowList } from "../components/myuno/rowsUi";
import { SidebarShowButton } from "../components/sidebar/SidebarShowButton";
import { Button } from "../components/ui/button";
import { Sheet, SheetPopup } from "../components/ui/sheet";
import { SidebarInset } from "../components/ui/sidebar";
import { toastManager } from "../components/ui/toast";
import { useMoveApp, useOpenApp, useWake, useWelcomeComputer, useWorkspace } from "./api";
import {
  appReadiness,
  canWake,
  computerOf,
  hardwareSummary,
  isUp,
  PART_LABEL,
  partOf,
  ROLE_LABEL,
  STATE_WORD,
  usedBy,
  useComputer,
  type PartKind,
  type Readiness,
  type Workspace,
  type WsApp,
  type WsComputer,
  type WsPart,
} from "./model";
import { ComputerGlyph, PART_ICON, StateDot, UsedByChip } from "./ui";

const routeApi = getRouteApi("/_chat/workspace");

export type WorkspaceTab = "apps" | "hardware";

type Selection =
  | { readonly kind: "app"; readonly id: string }
  | { readonly kind: "computer"; readonly id: string };

const PART_ORDER: ReadonlyArray<PartKind> = ["spark", "database", "kv", "drive", "git", "address"];

export function WorkspaceView() {
  const search = routeApi.useSearch();
  const tab: WorkspaceTab = search.tab === "hardware" ? "hardware" : "apps";
  const navigate = useNavigate();
  const wide = useMediaQuery("lg");
  const query = useWorkspace();
  const ws = query.data ?? null;

  const selection: Selection | null = search.app
    ? { kind: "app", id: search.app }
    : search.computer
      ? { kind: "computer", id: search.computer }
      : null;
  const select = (next: Selection | null, nextTab: WorkspaceTab = tab) =>
    void navigate({
      to: "/workspace",
      search: {
        ...(nextTab === "hardware" ? { tab: "hardware" as const } : {}),
        ...(next?.kind === "app" ? { app: next.id } : {}),
        ...(next?.kind === "computer" ? { computer: next.id } : {}),
      },
      replace: true,
    });
  const setTab = (next: WorkspaceTab) => select(null, next);

  const opener = useAppOpener(ws);

  const panel =
    ws && selection
      ? selection.kind === "app"
        ? (() => {
            const app = ws.apps.find((item) => item.id === selection.id);
            return app ? (
              <AppPanel ws={ws} app={app} opener={opener} onClose={() => select(null)} />
            ) : null;
          })()
        : (() => {
            const computer = computerOf(ws, selection.id);
            return computer ? (
              <ComputerPanel
                ws={ws}
                computer={computer}
                onClose={() => select(null)}
                onOpenApp={(id) => select({ kind: "app", id }, "apps")}
              />
            ) : null;
          })()
      : null;

  useEffect(() => {
    if (!selection || !wide) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header className="border-b border-border px-3 py-2 sm:px-5 sm:py-3">
          <div className="flex items-center gap-2">
            <SidebarShowButton />
            <LayersIcon className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">Workspace</span>
            <div className="ml-3 flex rounded-lg bg-muted/50 p-0.5" role="tablist">
              {(
                [
                  ["apps", "Apps"],
                  ["hardware", "Hardware"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  onClick={() => setTab(key)}
                  className={cn(
                    "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                    tab === key
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  data-testid={`ws-tab-${key}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-4 pb-16 sm:px-6 sm:pt-6">
              {ws ? (
                <>
                  <LiquidStrip
                    ws={ws}
                    onComputer={(id) => select({ kind: "computer", id }, "hardware")}
                    onCloud={() => setTab("hardware")}
                  />
                  {tab === "apps" ? (
                    <AppsList
                      ws={ws}
                      selectedId={selection?.kind === "app" ? selection.id : null}
                      onSelect={(id) =>
                        select(
                          selection?.kind === "app" && selection.id === id
                            ? null
                            : { kind: "app", id },
                        )
                      }
                      opener={opener}
                    />
                  ) : (
                    <Hardware
                      ws={ws}
                      selectedId={selection?.kind === "computer" ? selection.id : null}
                      onSelect={(id) =>
                        select(
                          selection?.kind === "computer" && selection.id === id
                            ? null
                            : { kind: "computer", id },
                        )
                      }
                    />
                  )}
                </>
              ) : query.error ? (
                <p className="text-sm text-muted-foreground">Couldn't reach your workspace.</p>
              ) : (
                <p className="text-sm text-muted-foreground">Loading your workspace…</p>
              )}
            </div>
          </div>
          {wide && panel ? (
            <aside className="flex w-[360px] shrink-0 flex-col border-l border-border">
              {panel}
            </aside>
          ) : null}
        </div>
      </div>
      {!wide ? (
        <Sheet open={panel !== null} onOpenChange={(next) => (next ? null : select(null))}>
          <SheetPopup side="right" showCloseButton={false} className="max-w-sm">
            {panel}
          </SheetPopup>
        </Sheet>
      ) : null}
    </SidebarInset>
  );
}

// ── The liquid computer at a glance ───────────────────────────────────────

/**
 * The workspace's own home on the left (always on), its computers along one
 * line — on, asleep (dashed), away (faded) — and the rest of the hardware as
 * a count. The one picture of "one computer living in many places".
 */
function LiquidStrip(props: {
  ws: Workspace;
  onComputer: (id: string) => void;
  onCloud: () => void;
}) {
  const inCloud = props.ws.parts.filter((part) => part.on === null).length;
  return (
    <section
      className="flex items-center overflow-x-auto rounded-2xl border border-border/60 bg-card/30 p-3 [scrollbar-width:none]"
      aria-label="Your workspace"
      data-testid="ws-strip"
    >
      <button
        type="button"
        onClick={props.onCloud}
        className="flex shrink-0 items-center gap-2.5 rounded-xl bg-primary/8 py-2 pr-3.5 pl-2.5 text-left transition-colors hover:bg-primary/12"
        title="Chats, assistants, apps and memory live here, always on"
        data-testid="ws-strip-cloud"
      >
        <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
          <CloudIcon className="size-4" />
        </span>
        <span className="leading-tight">
          <span className="block text-sm font-medium whitespace-nowrap">
            {props.ws.name}'s workspace
          </span>
          <span className="block text-[11px] whitespace-nowrap text-muted-foreground">
            Always on · {inCloud} parts in the cloud
          </span>
        </span>
      </button>
      {props.ws.computers.map((computer) => (
        <div key={computer.id} className="flex shrink-0 items-center">
          <span aria-hidden className="h-px w-4 bg-border sm:w-6" />
          <button
            type="button"
            onClick={() => props.onComputer(computer.id)}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-full border bg-background px-3 text-xs whitespace-nowrap transition-colors hover:bg-accent",
              computer.state === "asleep" && "border-dashed text-muted-foreground",
              computer.state === "offline" && "border-dashed text-muted-foreground/70",
              isUp(computer) && "border-border",
            )}
            title={`${computer.name} · ${STATE_WORD[computer.state]}`}
            data-testid={`ws-strip-${computer.id}`}
            data-state={computer.state}
          >
            <StateDot state={computer.state} />
            <ComputerGlyph computer={computer} className="size-3.5" />
            {computer.name}
          </button>
        </div>
      ))}
    </section>
  );
}

// ── Apps ──────────────────────────────────────────────────────────────────

interface Opener {
  readonly pending: string | null;
  readonly open: (app: WsApp) => void;
}

/**
 * Opening an app: wakes what it needs (the account does it), then opens its
 * address once everything it uses is up. Works the same from any computer.
 */
function useAppOpener(ws: Workspace | null): Opener {
  const openApp = useOpenApp();
  const [pending, setPending] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => {
    if (!pending || !ws) return;
    const app = ws.apps.find((item) => item.id === pending.id);
    if (!app) return setPending(null);
    const ready = appReadiness(ws, app);
    if (ready.kind === "ready") {
      openInNewTab(pending.url);
      setPending(null);
    } else if (ready.kind === "unavailable") {
      setPending(null);
    }
  }, [pending, ws]);
  return {
    pending: pending?.id ?? null,
    open: (app) => {
      openApp.mutate(app.id, {
        onSuccess: (result) => setPending({ id: app.id, url: result.url }),
        onError: () => toastManager.add({ type: "error", title: `Couldn't open ${app.name}` }),
      });
    },
  };
}

function OpenButton(props: {
  ws: Workspace;
  app: WsApp;
  opener: Opener;
  size?: "xs" | "default";
  className?: string;
}) {
  const ready = appReadiness(props.ws, props.app);
  const waking =
    props.opener.pending === props.app.id ||
    (ready.kind === "wakes" && ready.computer.state === "waking");
  if (ready.kind === "unavailable") {
    return (
      <span
        className={cn(
          "flex items-center gap-1.5 px-2 text-xs text-muted-foreground",
          props.size === "default" && "h-9 justify-center rounded-md bg-muted/60 text-sm",
          props.className,
        )}
        data-testid="ws-app-away"
      >
        <StateDot state={ready.computer.state} />
        {ready.computer.name} is {STATE_WORD[ready.computer.state].toLowerCase()}
      </span>
    );
  }
  return (
    <Button
      size={props.size ?? "xs"}
      variant={props.size === "default" ? "default" : "outline"}
      disabled={waking}
      onClick={(event) => {
        event.stopPropagation();
        props.opener.open(props.app);
      }}
      className={props.className}
      data-testid="ws-app-open"
    >
      {waking ? (
        <>
          <LoaderCircleIcon className="size-3.5 animate-spin" />
          Waking {ready.kind === "wakes" ? ready.computer.name : ""}…
        </>
      ) : ready.kind === "wakes" ? (
        <>
          <SunIcon className="size-3.5" />
          Wake & open
        </>
      ) : (
        "Open"
      )}
    </Button>
  );
}

/** The computers and parts an app uses, as one quiet line: computers by name, the rest as icons. */
function UsesLine({ ws, app }: { ws: Workspace; app: WsApp }) {
  const computers: WsComputer[] = [];
  const kinds: PartKind[] = [];
  for (const use of app.uses) {
    const computer = useComputer(ws, use);
    if (computer && !computers.includes(computer)) computers.push(computer);
    const part = partOf(ws, use.ref);
    if (part && part.kind !== "address" && !kinds.includes(part.kind)) kinds.push(part.kind);
  }
  return (
    <span className="hidden min-w-0 items-center gap-1.5 md:flex">
      {computers.map((computer) => (
        <span
          key={computer.id}
          className="flex h-5 shrink-0 items-center gap-1 rounded-full bg-muted/70 px-1.5 text-[11px] text-foreground/80"
        >
          <StateDot state={computer.state} className="size-1.5" />
          {computer.name}
        </span>
      ))}
      {computers.length === 0 ? (
        <span className="flex h-5 shrink-0 items-center gap-1 rounded-full bg-primary/8 px-1.5 text-[11px] text-primary">
          <CloudIcon className="size-3" /> no computer
        </span>
      ) : null}
      {kinds.map((kind) => {
        const Icon = PART_ICON[kind];
        return (
          <Icon
            key={kind}
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-label={PART_LABEL[kind]}
          />
        );
      })}
    </span>
  );
}

function AppsList(props: {
  ws: Workspace;
  selectedId: string | null;
  onSelect: (id: string) => void;
  opener: Opener;
}) {
  return (
    <RowList testId="ws-apps">
      {props.ws.apps.map((app) => {
        const ready = appReadiness(props.ws, app);
        return (
          <Row
            key={app.id}
            selected={props.selectedId === app.id}
            dim={ready.kind === "unavailable"}
            onSelect={() => props.onSelect(app.id)}
            label={app.name}
            testId={`ws-app-${app.id}`}
            action={<OpenButton ws={props.ws} app={app} opener={props.opener} />}
          >
            <AppTile icon={app.icon} />
            <span className="min-w-0 shrink truncate font-medium">{app.name}</span>
            <span className="hidden min-w-0 shrink truncate text-xs text-muted-foreground lg:inline">
              {host(app.url)}
            </span>
            <span className="ml-auto" />
            <UsesLine ws={props.ws} app={app} />
          </Row>
        );
      })}
    </RowList>
  );
}

function AppTile({ icon, large }: { icon: string; large?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-lg bg-muted/70",
        large ? "size-10 text-xl" : "size-7 text-sm",
      )}
    >
      {icon}
    </span>
  );
}

const host = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

function readinessLine(ready: Readiness): string {
  switch (ready.kind) {
    case "ready":
      return "Opens from any computer.";
    case "wakes":
      return ready.computer.state === "waking"
        ? `Waking ${ready.computer.name}…`
        : `${ready.computer.name} is asleep. Opening wakes it — about 2 seconds.`;
    case "unavailable":
      return `Runs on your ${ready.computer.name}, which is ${STATE_WORD[ready.computer.state].toLowerCase()}. Opens when it's back.`;
  }
}

function PanelHead(props: {
  title: ReactNode;
  sub?: ReactNode;
  leading: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="flex items-start gap-3 px-4 pt-4 pb-3">
      {props.leading}
      <div className="min-w-0 flex-1 leading-tight">
        <h2 className="truncate text-base font-semibold">{props.title}</h2>
        {props.sub ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{props.sub}</p>
        ) : null}
      </div>
      <Button size="icon-xs" variant="ghost" aria-label="Close" onClick={props.onClose}>
        <XIcon />
      </Button>
    </div>
  );
}

function PanelBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 border-t border-border/60 px-4 py-3.5">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** The app card: what opening it takes, and everything it uses. */
function AppPanel(props: { ws: Workspace; app: WsApp; opener: Opener; onClose: () => void }) {
  const { ws, app } = props;
  const ready = appReadiness(ws, app);
  const move = useMoveApp();
  const target = ws.computers.find((computer) => computer.kind === "cloud" && isUp(computer));
  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="ws-app-panel">
      <PanelHead
        leading={<AppTile icon={app.icon} large />}
        title={app.name}
        sub={host(app.url)}
        onClose={props.onClose}
      />
      <div className="flex flex-col gap-2 px-4 pb-4">
        <OpenButton ws={ws} app={app} opener={props.opener} size="default" className="w-full" />
        <p className="text-xs text-muted-foreground" data-testid="ws-app-readiness">
          {readinessLine(ready)}
        </p>
        {ready.kind === "unavailable" && target ? (
          <Button
            size="sm"
            variant="outline"
            disabled={move.isPending}
            onClick={() =>
              move.mutate(
                { id: app.id, to: target.id },
                {
                  onSuccess: () =>
                    toastManager.add({
                      type: "success",
                      title: `Moving ${app.name} to ${target.name}`,
                      description: "Uno copies it from git and tells you when it opens there.",
                    }),
                },
              )
            }
            data-testid="ws-app-move"
          >
            Move it to {target.name}
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-10">
        <PanelBlock title="Uses">
          <ul className="flex flex-col" data-testid="ws-app-uses">
            {app.uses.map((use) => (
              <UseRow
                key={`${use.ref}-${use.role}`}
                ws={ws}
                refId={use.ref}
                role={ROLE_LABEL[use.role]}
                detail={use.detail}
              />
            ))}
          </ul>
        </PanelBlock>
      </div>
    </div>
  );
}

function UseRow(props: {
  ws: Workspace;
  refId: string;
  role: string;
  detail?: string | undefined;
}) {
  const computer = computerOf(props.ws, props.refId);
  const part = computer ? null : partOf(props.ws, props.refId);
  const on = part ? computerOf(props.ws, part.on) : null;
  const Icon = part ? PART_ICON[part.kind] : null;
  return (
    <li className="flex items-center gap-2.5 py-1.5 text-sm" data-testid={`ws-use-${props.refId}`}>
      {computer ? (
        <ComputerGlyph computer={computer} />
      ) : Icon ? (
        <Icon className="size-4 shrink-0 text-muted-foreground" />
      ) : null}
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate">
          <span className="text-muted-foreground">{props.role} </span>
          {computer?.name ?? part?.name ?? props.refId}
        </p>
        {props.detail || part ? (
          <p className="truncate text-[11px] text-muted-foreground">
            {props.detail ?? part?.detail}
          </p>
        ) : null}
      </div>
      {computer ? (
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
          <StateDot state={computer.state} className="size-1.5" />
          {STATE_WORD[computer.state]}
        </span>
      ) : on ? (
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
          <StateDot state={on.state} className="size-1.5" />
          on {on.name}
        </span>
      ) : (
        <span className="shrink-0 text-[11px] text-muted-foreground">cloud</span>
      )}
    </li>
  );
}

// ── Hardware ──────────────────────────────────────────────────────────────

function Hardware(props: {
  ws: Workspace;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { ws } = props;
  const summary = hardwareSummary(ws);
  const parts = useMemo(
    () => PART_ORDER.flatMap((kind) => ws.parts.filter((part) => part.kind === kind)),
    [ws.parts],
  );
  const fresh = ws.computers.find((computer) => computer.isNew) ?? null;
  return (
    <div className="flex flex-col gap-2" data-testid="ws-hardware">
      {fresh ? <NewComputerCard ws={ws} computer={fresh} /> : null}
      <GroupTitle
        right={[
          `${summary.up} on`,
          summary.asleep ? `${summary.asleep} asleep` : null,
          summary.offline ? `${summary.offline} away` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      >
        Computers
      </GroupTitle>
      <RowList testId="ws-computers">
        {ws.computers.map((computer) => (
          <ComputerRow
            key={computer.id}
            ws={ws}
            computer={computer}
            selected={props.selectedId === computer.id}
            onSelect={() => props.onSelect(computer.id)}
          />
        ))}
      </RowList>
      <GroupTitle right={String(parts.length)}>Spark, data and addresses</GroupTitle>
      <ul
        className="overflow-hidden rounded-2xl border border-border/60 bg-card/30"
        data-testid="ws-parts"
      >
        {parts.map((part) => (
          <PartRow key={part.id} ws={ws} part={part} />
        ))}
      </ul>
    </div>
  );
}

function ComputerRow(props: {
  ws: Workspace;
  computer: WsComputer;
  selected: boolean;
  onSelect: () => void;
}) {
  const { ws, computer } = props;
  const users = usedBy(ws, computer.id);
  return (
    <Row
      selected={props.selected}
      dim={!isUp(computer)}
      onSelect={props.onSelect}
      label={computer.name}
      testId={`ws-computer-${computer.id}`}
      action={<ComputerAction computer={computer} />}
    >
      <StateDot state={computer.state} />
      <ComputerGlyph computer={computer} />
      <span className="min-w-0 shrink truncate font-medium">{computer.name}</span>
      <span className="hidden min-w-0 shrink truncate text-xs text-muted-foreground sm:inline">
        {computer.detail}
      </span>
      <span className="ml-auto" />
      <span className="hidden items-center gap-1 md:flex">
        {users.apps.slice(0, 2).map((app) => (
          <UsedByChip key={app.id} icon={app.icon} name={app.name} />
        ))}
        {users.assistants.length > 0 ? (
          <UsedByChip name={users.assistants.map((assistant) => assistant.name).join(", ")} />
        ) : null}
      </span>
      <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">
        {STATE_WORD[computer.state]}
      </span>
    </Row>
  );
}

/** A computer's one action: its terminal when it's on, Wake when it can be woken. */
function ComputerAction({ computer, size = "xs" }: { computer: WsComputer; size?: "xs" | "sm" }) {
  const wake = useWake();
  const launchers = useHomeLaunchers((computer.environmentId as EnvironmentId | null) ?? null);
  if (isUp(computer) && computer.environmentId) {
    return (
      <Button
        size={size}
        variant="ghost"
        onClick={() => void launchers.openTerminal()}
        data-testid={`ws-terminal-${computer.id}`}
        title={`A terminal on ${computer.name}`}
      >
        <TerminalIcon className="size-3.5" />
        Terminal
      </Button>
    );
  }
  if (canWake(computer)) {
    return (
      <Button
        size={size}
        variant="outline"
        disabled={wake.isPending}
        onClick={() => wake.mutate(computer.id)}
        data-testid={`ws-wake-${computer.id}`}
      >
        <SunIcon className="size-3.5" />
        Wake up
      </Button>
    );
  }
  if (computer.state === "waking") {
    return (
      <span className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground">
        <LoaderCircleIcon className="size-3.5 animate-spin" />
        Waking
      </span>
    );
  }
  return null;
}

function PartRow({ ws, part }: { ws: Workspace; part: WsPart }) {
  const Icon = PART_ICON[part.kind];
  const on = computerOf(ws, part.on);
  const apps = usedBy(ws, part.id).apps;
  return (
    <li
      className="flex h-11 items-center gap-3 border-b border-border/50 px-3 text-sm last:border-0"
      data-testid={`ws-part-${part.id}`}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-label={PART_LABEL[part.kind]} />
      <span className="min-w-0 shrink truncate">{part.name}</span>
      <span className="hidden min-w-0 shrink truncate text-xs text-muted-foreground sm:inline">
        {part.detail}
      </span>
      <span className="ml-auto" />
      <span className="hidden items-center gap-1 md:flex">
        {apps.slice(0, 2).map((app) => (
          <UsedByChip key={app.id} icon={app.icon} name={app.name} />
        ))}
      </span>
      <span className="flex w-24 shrink-0 items-center justify-end gap-1 text-xs text-muted-foreground">
        {on ? (
          <>
            <StateDot state={on.state} className="size-1.5" />
            on {on.name}
          </>
        ) : (
          "cloud"
        )}
      </span>
    </li>
  );
}

/** A computer just joined: one question — may the assistants use it? */
function NewComputerCard({ ws, computer }: { ws: Workspace; computer: WsComputer }) {
  const welcome = useWelcomeComputer();
  const uno = ws.assistants.find((assistant) => assistant.id === "uno");
  return (
    <section
      className="flex flex-wrap items-center gap-3 rounded-2xl border border-primary/25 bg-primary/6 px-4 py-3"
      data-testid="ws-new-computer"
    >
      <ComputerGlyph computer={computer} className="size-5 text-primary" />
      <div className="min-w-0 flex-1 leading-tight">
        <p className="text-sm font-medium">{computer.name} joined your workspace</p>
        <p className="text-xs text-muted-foreground">
          Your apps can run on it. Let {uno?.name ?? "Uno"} use it too?
        </p>
      </div>
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          disabled={welcome.isPending}
          onClick={() => welcome.mutate({ id: computer.id, assistants: uno ? [uno.id] : [] })}
          data-testid="ws-new-allow"
        >
          Let {uno?.name ?? "Uno"} use it
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={welcome.isPending}
          onClick={() => welcome.mutate({ id: computer.id, assistants: [] })}
          data-testid="ws-new-later"
        >
          Not yet
        </Button>
      </div>
    </section>
  );
}

function ComputerPanel(props: {
  ws: Workspace;
  computer: WsComputer;
  onClose: () => void;
  onOpenApp: (id: string) => void;
}) {
  const { ws, computer } = props;
  const users = usedBy(ws, computer.id);
  const onIt = ws.parts.filter((part) => part.on === computer.id);
  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="ws-computer-panel">
      <PanelHead
        leading={
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted/70">
            <ComputerGlyph computer={computer} className="size-5" />
          </span>
        }
        title={computer.name}
        sub={
          <span className="flex items-center gap-1.5">
            <StateDot state={computer.state} className="size-1.5" />
            {STATE_WORD[computer.state]} · {computer.detail}
          </span>
        }
        onClose={props.onClose}
      />
      <div className="flex flex-wrap items-center gap-1.5 px-4 pb-4">
        <ComputerAction computer={computer} size="sm" />
        {computer.kind === "local" && !isUp(computer) ? (
          <p className="text-xs text-muted-foreground">
            Only you can bring it back. Its apps wait; the workspace goes on.
          </p>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-10">
        <PanelBlock title="Apps on it">
          {users.apps.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {users.apps.map((app) => (
                <button key={app.id} type="button" onClick={() => props.onOpenApp(app.id)}>
                  <UsedByChip icon={app.icon} name={app.name} />
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">None.</p>
          )}
        </PanelBlock>
        <PanelBlock title="Assistants that work here">
          {users.assistants.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {users.assistants.map((assistant) => (
                <UsedByChip key={assistant.id} name={assistant.name} />
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">None yet.</p>
          )}
        </PanelBlock>
        {onIt.length > 0 ? (
          <PanelBlock title="Data on it">
            <ul className="flex flex-col">
              {onIt.map((part) => (
                <UseRow key={part.id} ws={ws} refId={part.id} role={PART_LABEL[part.kind]} />
              ))}
            </ul>
          </PanelBlock>
        ) : null}
        <p className="px-4 pt-2 text-[11px] text-muted-foreground">
          Its terminal and files stay on {computer.name}.
        </p>
      </div>
    </div>
  );
}
