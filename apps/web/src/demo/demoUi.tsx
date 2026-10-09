/**
 * Demo mode (?demo=heavy, icp3 09.10): the four "heavy usage" variants, built
 * into the real sidebar and Home. Misha 09.10: "the main thing is to sort
 * out the Inbox" — every variant answers "what needs me" first.
 *
 * - V1 — Needs you on top of the sidebar: one-click answers, projects below.
 * - V2 — the Inbox is Home: Needs you → Stopped → Running → Done today → Later,
 *   by project; the sidebar is a short list of projects.
 * - V3 — coordination: a coordinator and its helpers on every computer as one
 *   tree with progress; the Inbox folds helpers into the coordinator's card.
 * - V4 — computer lanes: a column per computer, what runs where right now.
 *
 * Loaded only in the demo (Sidebar / ComputerView import it lazily).
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleHelpIcon,
  ClockIcon,
  CloudIcon,
  CreditCardIcon,
  FolderIcon,
  GitPullRequestIcon,
  HomeIcon,
  LaptopIcon,
  MoonIcon,
  RotateCcwIcon,
  ShieldQuestionIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { formatWorkingDurationLabel } from "../components/Sidebar.logic";
import { HomeComposer, type HomeStartOptions } from "../components/computer/home/HomeComposer";
import { Button } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import { formatElapsedDurationLabel } from "../timestampFormat";
import { useDemoStore, useDemoVariant } from "./demoFlag";
import {
  actionsOf,
  answer,
  askTextOf,
  fromLine,
  NO_PROJECT,
  retry,
  useDemoChats,
  useDemoTeams,
  useNow,
  useOpenChat,
  type DemoChat,
  type DemoTeam,
} from "./demoModel";
import { MACHINE_LIST, SLEEPING_BOX, type DemoMachine } from "./heavyFixtures";

// ── Small shared pieces ──────────────────────────────────────────────────

function MachineIcon({ machine, className }: { machine: DemoMachine; className?: string }) {
  return machine.machineKind === "uno_box" ? (
    <CloudIcon className={className} />
  ) : (
    <LaptopIcon className={className} />
  );
}

/** "▢ uno-console  ☁ uno-product" — where a chat lives. */
function Place(props: {
  chat: DemoChat;
  project?: boolean | undefined;
  machine?: boolean | undefined;
  className?: string | undefined;
}) {
  const { chat } = props;
  const showProject = props.project !== false;
  const showMachine = props.machine !== false;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-2 text-xs leading-4 text-muted-foreground",
        props.className,
      )}
    >
      {showProject ? (
        <span className="inline-flex min-w-0 items-center gap-1">
          {chat.project === NO_PROJECT ? (
            <HomeIcon className="size-3 shrink-0 opacity-70" />
          ) : (
            <FolderIcon className="size-3 shrink-0 opacity-70" />
          )}
          <span className="truncate">{chat.project}</span>
        </span>
      ) : null}
      {showMachine ? (
        <span className="inline-flex shrink-0 items-center gap-1">
          <MachineIcon machine={chat.machine} className="size-3 shrink-0 opacity-70" />
          {chat.machine.label}
        </span>
      ) : null}
    </span>
  );
}

function Mark({ chat }: { chat: DemoChat }) {
  switch (chat.status) {
    case "running":
      return (
        <CircleDashedIcon
          role="img"
          aria-label="Working"
          className="size-3.5 shrink-0 animate-spin text-sky-500 [animation-duration:2.4s]"
        />
      );
    case "needs-you":
      return (
        <span
          role="img"
          aria-label="Needs you"
          className={cn(
            "size-2 shrink-0 rounded-full",
            chat.summary.hasPendingApprovals ? "bg-amber-500" : "bg-indigo-500",
          )}
        />
      );
    case "failed":
      return (
        <span role="img" aria-label="Stopped" className="size-2 shrink-0 rounded-full bg-red-500" />
      );
    case "scheduled":
      return (
        <ClockIcon aria-label="Scheduled" className="size-3.5 shrink-0 text-muted-foreground" />
      );
    case "snoozed":
      return <MoonIcon aria-label="Paused" className="size-3.5 shrink-0 text-muted-foreground" />;
    case "done":
      return chat.unread ? (
        <span role="img" aria-label="New" className="size-2 shrink-0 rounded-full bg-emerald-500" />
      ) : (
        <CircleCheckIcon aria-label="Done" className="size-3.5 shrink-0 text-muted-foreground/60" />
      );
    default:
      return (
        <CircleCheckIcon aria-label="Done" className="size-3.5 shrink-0 text-muted-foreground/40" />
      );
  }
}

function since(iso: string | null, now: number): string {
  if (!iso) return "";
  return formatWorkingDurationLabel(now - Date.parse(iso));
}

function agoLabel(iso: string, now: number): string {
  const label = formatElapsedDurationLabel(iso, now);
  return label === "just now" ? "now" : label;
}

function whenLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const at = new Date(iso);
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const time = at.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (at.toDateString() === today.toDateString()) return `today ${time}`;
  if (at.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  return `${at.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
}

function SectionTitle(props: { children: ReactNode; count?: number; aside?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-1 pt-1 pb-1.5">
      <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {props.children}
      </span>
      {props.count ? (
        <span className="text-[11px] font-medium text-muted-foreground tabular-nums">
          {props.count}
        </span>
      ) : null}
      {props.aside ? <span className="ml-auto">{props.aside}</span> : null}
    </div>
  );
}

const ASK_ICON = {
  question: CircleHelpIcon,
  permission: ShieldQuestionIcon,
  review: GitPullRequestIcon,
  payment: CreditCardIcon,
} as const;

function sent(chat: DemoChat, label: string) {
  toastManager.add({
    type: "success",
    title: `${label} — sent`,
    description: `${chat.title} · ${chat.project} · ${chat.machine.label}`,
  });
}

/** The answer buttons of a chat that waits — one click and it continues. */
function AskButtons({ chat, size = "xs" }: { chat: DemoChat; size?: "xs" | "sm" }) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap gap-1.5">
      {actionsOf(chat).map((action) => (
        <Button
          key={action.label}
          size={size}
          variant={action.primary ? "default" : "outline"}
          disabled={busy !== null}
          data-testid="demo-answer"
          onClick={(event) => {
            event.stopPropagation();
            setBusy(action.label);
            answer(chat, action.label);
            sent(chat, action.label);
          }}
        >
          {action.label}
        </Button>
      ))}
    </div>
  );
}

/** One thing that waits for the person: what it asks, where, the answer buttons. */
function NeedsCard({ chat, wide = false }: { chat: DemoChat; wide?: boolean }) {
  const open = useOpenChat();
  const now = useNow();
  const ask = chat.spec?.ask;
  const Icon = ASK_ICON[ask?.kind ?? "question"];
  const from = fromLine(chat);
  const tone =
    ask?.kind === "permission" || ask?.kind === "payment"
      ? "bg-amber-500/12 text-amber-600 dark:text-amber-400"
      : "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400";
  const extra =
    ask?.kind === "permission" ? (
      <code className="mt-2 block truncate rounded-md bg-muted px-2 py-1 font-mono text-[11px] text-foreground/80">
        {ask.command}
      </code>
    ) : ask?.kind === "review" ? (
      <p className="mt-1.5 text-xs text-muted-foreground">
        {ask.pr} · {ask.checks}
      </p>
    ) : null;
  if (!wide) {
    // Sidebar / lane: the question gets the whole width; where and who below.
    return (
      <div
        className="rounded-xl border border-border bg-card p-2.5 text-card-foreground shadow-xs/5"
        data-testid="demo-needs-card"
      >
        <button
          type="button"
          onClick={() => open(chat)}
          className="block w-full cursor-pointer text-left"
        >
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                "inline-flex size-5 shrink-0 items-center justify-center rounded-md",
                tone,
              )}
            >
              <Icon className="size-3" />
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-sidebar-foreground/80">
              {chat.title}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
              {agoLabel(chat.updatedAt, now)}
            </span>
          </span>
          <span className="mt-1 line-clamp-3 block text-[13px] leading-snug font-medium text-foreground">
            {askTextOf(chat)}
          </span>
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <Place chat={chat} className="flex-wrap gap-y-0.5" />
            {from ? <span className="text-xs text-muted-foreground/80">{from}</span> : null}
          </span>
        </button>
        {extra}
        <div className="mt-2">
          <AskButtons chat={chat} />
        </div>
      </div>
    );
  }
  return (
    <div
      className="rounded-xl border border-border bg-card p-3.5 text-card-foreground shadow-xs/5"
      data-testid="demo-needs-card"
    >
      <div className="flex items-center gap-2.5 max-sm:flex-wrap">
        <span
          className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-lg", tone)}
        >
          <Icon className="size-4" />
        </span>
        <button
          type="button"
          onClick={() => open(chat)}
          className="min-w-0 flex-1 cursor-pointer text-left"
        >
          <span className="block text-sm leading-snug font-medium text-foreground">
            {askTextOf(chat)}
          </span>
          <span className="mt-0.5 block truncate text-xs text-sidebar-foreground/80">
            {chat.title}
          </span>
          <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <Place chat={chat} />
            {from ? <span className="text-xs text-muted-foreground/80">{from}</span> : null}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-3 max-sm:w-full max-sm:pl-10.5">
          <span className="text-xs text-muted-foreground tabular-nums max-sm:hidden">
            {agoLabel(chat.updatedAt, now)}
          </span>
          <AskButtons chat={chat} size="sm" />
        </div>
      </div>
      {extra}
    </div>
  );
}

/** A chat that stopped: why, and the way to get it going again. */
function StoppedCard({ chat, wide = false }: { chat: DemoChat; wide?: boolean }) {
  const open = useOpenChat();
  const [done, setDone] = useState(false);
  const billing = chat.spec?.errorClass === "billing_error";
  const slept = chat.machine.key === "mac" && !billing;
  const label = billing ? "Continue on Uno AI" : slept ? "Retry on uno-work" : "Retry";
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card shadow-xs/5",
        wide ? "flex items-center gap-3 p-3" : "p-2.5",
      )}
    >
      <button
        type="button"
        onClick={() => open(chat)}
        className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 text-left"
      >
        <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-red-500" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{chat.title}</span>
          <span className="block text-xs leading-snug text-muted-foreground">
            {chat.spec?.error ?? "Stopped with an error"}
          </span>
          <Place chat={chat} className="mt-0.5" />
        </span>
      </button>
      <div className={cn("flex flex-wrap gap-1.5", wide ? "shrink-0" : "mt-2")}>
        <Button
          size={wide ? "sm" : "xs"}
          variant="outline"
          disabled={done}
          onClick={() => {
            setDone(true);
            retry(chat, label);
            toastManager.add({
              type: "success",
              title: `${label} — started`,
              description: chat.title,
            });
          }}
        >
          <RotateCcwIcon />
          {label}
        </Button>
      </div>
    </div>
  );
}

/** One line of a chat in a list: mark, title, what's going on, where, time. */
function ChatLine(props: {
  chat: DemoChat;
  now: number;
  project?: boolean;
  machine?: boolean;
  /** The second line: "now" text of the fixture (what it is doing / what came out). */
  detail?: boolean;
  dense?: boolean;
  indent?: boolean;
  right?: ReactNode;
}) {
  const open = useOpenChat();
  const { chat, now } = props;
  const right =
    props.right ??
    (chat.status === "running"
      ? since(chat.startedAt, now)
      : chat.status === "scheduled"
        ? whenLabel(chat.summary.snoozedUntil)
        : chat.status === "snoozed"
          ? `until ${whenLabel(chat.summary.snoozedUntil)}`
          : agoLabel(chat.updatedAt, now));
  const showPlace = props.project !== false || props.machine !== false;
  return (
    <button
      type="button"
      onClick={() => open(chat)}
      data-testid="demo-chat-line"
      className={cn(
        "flex w-full min-w-0 cursor-pointer items-start gap-2 rounded-lg pr-2 text-left outline-hidden transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring",
        props.dense ? "py-1" : "py-1.5",
        props.indent ? "pl-6" : "pl-2",
      )}
    >
      <span className="flex h-5 w-3.5 shrink-0 items-center justify-center">
        <Mark chat={chat} />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-[13px] leading-5",
            chat.unread || chat.status === "needs-you"
              ? "font-medium text-foreground"
              : "text-sidebar-foreground",
          )}
        >
          {chat.title}
        </span>
        {props.detail && chat.spec?.now ? (
          <span className="block truncate text-xs text-sidebar-foreground/75">{chat.spec.now}</span>
        ) : null}
        {showPlace ? <Place chat={chat} project={props.project} machine={props.machine} /> : null}
      </span>
      <span className="shrink-0 pt-0.5 text-[11px] text-muted-foreground tabular-nums">
        {right}
      </span>
    </button>
  );
}

// ── V1: Needs you on top of the sidebar ──────────────────────────────────

const V1_SHOWN = 3;

function NeedsYouBlock() {
  const chats = useDemoChats();
  const now = useNow();
  const [all, setAll] = useState(false);
  const needs = chats.filter((chat) => chat.status === "needs-you");
  const stopped = chats.filter((chat) => chat.status === "failed");
  const running = chats.filter((chat) => chat.status === "running").length;
  const fresh = chats.filter((chat) => chat.unread);
  const shown = all ? needs : needs.slice(0, V1_SHOWN);
  return (
    <li className="mb-2 list-none" data-testid="demo-v1-needs">
      <div className="flex h-8 items-center gap-2 px-1.5">
        <span className="text-sm font-semibold text-foreground">Needs you</span>
        {needs.length > 0 ? (
          <span className="rounded-full bg-amber-500/15 px-1.5 text-[11px] font-semibold text-amber-700 tabular-nums dark:text-amber-300">
            {needs.length}
          </span>
        ) : null}
        <span className="ml-auto text-[11px] text-muted-foreground">
          {running} running · 3 computers
        </span>
      </div>
      {needs.length === 0 ? (
        <p className="px-1.5 pb-1 text-xs text-muted-foreground">
          Nothing waits for you. Agents keep working.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5 px-0.5">
          {shown.map((chat) => (
            <NeedsCard key={chat.key} chat={chat} />
          ))}
          {needs.length > V1_SHOWN ? (
            <button
              type="button"
              onClick={() => setAll((value) => !value)}
              className="flex h-7 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground"
            >
              {all ? "Show fewer" : `${needs.length - V1_SHOWN} more waiting`}
              <ChevronDownIcon className={cn("size-3 transition-transform", all && "rotate-180")} />
            </button>
          ) : null}
        </div>
      )}
      {stopped.length > 0 ? (
        <>
          <p className="px-1.5 pt-2 pb-1 text-xs font-medium text-muted-foreground">
            Stopped · {stopped.length}
          </p>
          <div className="flex flex-col gap-1.5 px-0.5">
            {stopped.map((chat) => (
              <StoppedCard key={chat.key} chat={chat} />
            ))}
          </div>
        </>
      ) : null}
      {fresh.length > 0 ? (
        <>
          <p className="px-1.5 pt-2 pb-0.5 text-xs font-medium text-muted-foreground">
            Done since you looked · {fresh.length}
          </p>
          <div className="flex flex-col">
            {fresh.slice(0, 4).map((chat) => (
              <ChatLine key={chat.key} chat={chat} now={now} dense />
            ))}
          </div>
        </>
      ) : null}
      <div className="mx-1.5 mt-2 border-t border-border/60" />
    </li>
  );
}

// ── V3: coordination tree ────────────────────────────────────────────────

function ProgressBar({ counts }: { counts: DemoTeam["counts"] }) {
  const total = counts.done + counts.running + counts.needs + counts.failed;
  if (total === 0) return null;
  const parts: Array<[number, string]> = [
    [counts.done, "bg-emerald-500"],
    [counts.needs, "bg-amber-500"],
    [counts.running, "bg-sky-500"],
    [counts.failed, "bg-red-500"],
  ];
  return (
    <span className="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full" aria-hidden>
      {parts.map(([count, color], index) =>
        count > 0 ? (
          <span
            key={index}
            className={cn("h-full rounded-full", color)}
            style={{ flexGrow: count }}
          />
        ) : null,
      )}
    </span>
  );
}

function teamSummary(team: DemoTeam): string {
  const { counts } = team;
  const total = counts.done + counts.running + counts.needs + counts.failed;
  return [
    `${counts.done}/${total} done`,
    counts.needs > 0 ? `${counts.needs} needs you` : null,
    counts.running > 0 ? `${counts.running} working` : null,
    counts.failed > 0 ? `${counts.failed} stopped` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function TeamNode({ team, now }: { team: DemoTeam; now: number }) {
  const open = useOpenChat();
  const urgent =
    team.counts.needs > 0 || team.lead.status === "needs-you" || team.counts.failed > 0;
  const [folded, setFolded] = useState(!urgent && team.counts.running === 0);
  const computers = [...new Set([team.lead, ...team.helpers].map((chat) => chat.machine.label))];
  return (
    <li className="list-none" data-testid="demo-team">
      <div className="group/team flex items-start gap-0.5 rounded-lg hover:bg-sidebar-row-hover">
        <button
          type="button"
          aria-label={folded ? "Show helpers" : "Hide helpers"}
          onClick={() => setFolded((value) => !value)}
          className="mt-1.5 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:text-foreground"
        >
          <ChevronDownIcon
            className={cn("size-3.5 transition-transform", folded && "-rotate-90")}
          />
        </button>
        <button
          type="button"
          onClick={() => open(team.lead)}
          className="min-w-0 flex-1 cursor-pointer py-1.5 pr-2 text-left"
        >
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
              {team.lead.title}
            </span>
            <Mark chat={team.lead} />
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {team.leadWord === "coordinator"
              ? "Coordinator"
              : team.leadWord === "validator"
                ? "Validator"
                : "Started work in the cloud"}{" "}
            · {computers.join(", ")}
          </span>
          <span className="mt-1.5 block">
            <ProgressBar counts={team.counts} />
          </span>
          <span className="mt-1 block truncate text-[11px] text-sidebar-foreground/85">
            {teamSummary(team)}
          </span>
        </button>
      </div>
      {folded ? null : (
        <ul className="mb-1 flex flex-col">
          {team.helpers.map((helper) => (
            <li key={helper.key} className="list-none">
              <ChatLine chat={helper} now={now} indent dense />
              {helper.status === "needs-you" ? (
                <div className="pr-2 pb-1.5 pl-11">
                  <p className="mb-1 text-xs leading-snug text-foreground/90">
                    {askTextOf(helper)}
                  </p>
                  <AskButtons chat={helper} />
                </div>
              ) : null}
            </li>
          ))}
          {team.lead.status === "needs-you" ? (
            <li className="list-none pr-2 pb-1.5 pl-6">
              <p className="mb-1 text-xs leading-snug text-foreground/90">{askTextOf(team.lead)}</p>
              <AskButtons chat={team.lead} />
            </li>
          ) : null}
        </ul>
      )}
    </li>
  );
}

function TeamsTree() {
  const chats = useDemoChats();
  const teams = useDemoTeams(chats);
  const now = useNow();
  if (teams.length === 0) return null;
  return (
    <li className="mb-1 list-none" data-testid="demo-v3-teams">
      <div className="flex h-8 items-center gap-2 px-2">
        <span className="text-xs font-medium text-muted-foreground">Teams of agents</span>
        <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
          {teams.length}
        </span>
      </div>
      <ul className="flex flex-col gap-0.5">
        {teams.map((team) => (
          <TeamNode key={team.lead.key} team={team} now={now} />
        ))}
      </ul>
      <div className="mx-1.5 mt-2 border-t border-border/60" />
    </li>
  );
}

// ── V2: the sidebar as a short list of projects ──────────────────────────

interface ProjectRow {
  readonly name: string;
  readonly machines: string[];
  readonly needs: number;
  readonly running: number;
  readonly failed: number;
  readonly fresh: number;
  readonly total: number;
}

function useProjectRows(chats: ReadonlyArray<DemoChat>): ProjectRow[] {
  return useMemo(() => {
    const rows = new Map<string, ProjectRow & { last: string }>();
    for (const chat of chats) {
      if (chat.status === "archived" || chat.project === "Uno") continue;
      const row = rows.get(chat.project) ?? {
        name: chat.project,
        machines: [],
        needs: 0,
        running: 0,
        failed: 0,
        fresh: 0,
        total: 0,
        last: "",
      };
      if (!row.machines.includes(chat.machine.label)) row.machines.push(chat.machine.label);
      rows.set(chat.project, {
        ...row,
        needs: row.needs + (chat.status === "needs-you" ? 1 : 0),
        running: row.running + (chat.status === "running" ? 1 : 0),
        failed: row.failed + (chat.status === "failed" ? 1 : 0),
        fresh: row.fresh + (chat.unread ? 1 : 0),
        total: row.total + 1,
        last: chat.updatedAt > row.last ? chat.updatedAt : row.last,
      });
    }
    return [...rows.values()].toSorted((a, b) => {
      if ((a.name === NO_PROJECT) !== (b.name === NO_PROJECT))
        return a.name === NO_PROJECT ? 1 : -1;
      return b.last.localeCompare(a.last);
    });
  }, [chats]);
}

function ProjectsCompact() {
  const chats = useDemoChats();
  const rows = useProjectRows(chats);
  const project = useDemoStore((state) => state.project);
  const setProject = useDemoStore((state) => state.setProject);
  const navigate = useNavigate();
  return (
    <li className="list-none" data-testid="demo-v2-projects">
      <div className="flex h-8 items-center gap-2 px-2 pt-2">
        <span className="text-xs font-medium text-muted-foreground">Projects</span>
      </div>
      <ul className="flex flex-col gap-px">
        {rows.map((row) => {
          const on = project === row.name;
          return (
            <li key={row.name} className="list-none">
              <button
                type="button"
                onClick={() => {
                  setProject(on ? null : row.name);
                  void navigate({ to: "/computer" });
                }}
                aria-pressed={on}
                className={cn(
                  "flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-sidebar-row-hover",
                  on && "bg-sidebar-row-hover",
                )}
              >
                {row.name === NO_PROJECT ? (
                  <HomeIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <FolderIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">{row.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {row.machines.join(" + ")}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5 pt-0.5">
                  {row.needs > 0 ? (
                    <span className="rounded-full bg-amber-500/15 px-1.5 text-[11px] font-semibold text-amber-700 tabular-nums dark:text-amber-300">
                      {row.needs}
                    </span>
                  ) : null}
                  {row.failed > 0 ? <span className="size-2 rounded-full bg-red-500" /> : null}
                  {row.running > 0 ? (
                    <span className="inline-flex items-center gap-0.5 text-[11px] text-sky-600 tabular-nums dark:text-sky-400">
                      <CircleDashedIcon className="size-3 animate-spin [animation-duration:2.4s]" />
                      {row.running}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

// ── V2: the Inbox is Home ────────────────────────────────────────────────

function groupByProject(chats: ReadonlyArray<DemoChat>): Array<[string, DemoChat[]]> {
  const groups = new Map<string, DemoChat[]>();
  for (const chat of chats) {
    const list = groups.get(chat.project) ?? [];
    list.push(chat);
    groups.set(chat.project, list);
  }
  return [...groups.entries()];
}

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 5
    ? "Good night"
    : hour < 12
      ? "Good morning"
      : hour < 18
        ? "Good afternoon"
        : "Good evening";
}

function Summary({ chats }: { chats: ReadonlyArray<DemoChat> }) {
  const needs = chats.filter((chat) => chat.status === "needs-you").length;
  const running = chats.filter((chat) => chat.status === "running").length;
  const machines = new Set(
    chats.filter((chat) => chat.status === "running").map((chat) => chat.machine.key),
  ).size;
  const done = chats.filter((chat) => chat.status === "done" && isToday(chat.updatedAt)).length;
  return (
    <p className="mt-1 text-sm text-muted-foreground" data-testid="demo-summary">
      <b className="font-medium text-foreground">{needs} need you</b> · {running} running on{" "}
      {machines} computers · {done} done today
    </p>
  );
}

function isToday(iso: string): boolean {
  return Date.now() - Date.parse(iso) < 16 * 3_600_000;
}

function FeedHome(props: {
  environmentId: EnvironmentId | null;
  onStart: (prompt: string, options: HomeStartOptions) => Promise<void>;
}) {
  const all = useDemoChats();
  const now = useNow();
  const project = useDemoStore((state) => state.project);
  const setProject = useDemoStore((state) => state.setProject);
  const chats = project ? all.filter((chat) => chat.project === project) : all;
  const live = chats.filter((chat) => chat.project !== "Uno" || chat.status === "needs-you");
  const needs = live.filter((chat) => chat.status === "needs-you");
  const stopped = live.filter((chat) => chat.status === "failed");
  const running = live.filter((chat) => chat.status === "running");
  const done = live
    .filter((chat) => chat.status === "done" && isToday(chat.updatedAt))
    .toSorted((a, b) => Number(b.unread) - Number(a.unread));
  const later = live.filter((chat) => chat.status === "scheduled" || chat.status === "snoozed");
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 pb-16" data-testid="demo-v2-home">
      <div>
        <h1 className="text-[28px] font-semibold tracking-tight">{greeting()}, Misha</h1>
        <Summary chats={all} />
      </div>
      <HomeComposer
        environmentId={props.environmentId}
        starters={[]}
        onStart={props.onStart}
        placeholder="What should your agents do next?"
      />
      {project ? (
        <div className="-mb-3 flex items-center gap-2">
          <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-xs font-medium">
            <FolderIcon className="size-3.5 text-muted-foreground" />
            {project}
            <button
              type="button"
              aria-label="Show every project"
              onClick={() => setProject(null)}
              className="-mr-1 inline-flex size-5 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <XIcon className="size-3" />
            </button>
          </span>
        </div>
      ) : null}
      <section>
        <SectionTitle count={needs.length}>Needs you</SectionTitle>
        {needs.length === 0 ? (
          <p className="px-1 text-sm text-muted-foreground">Nothing waits for you.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {needs.map((chat) => (
              <NeedsCard key={chat.key} chat={chat} wide />
            ))}
          </div>
        )}
      </section>
      {stopped.length > 0 ? (
        <section>
          <SectionTitle count={stopped.length}>Stopped</SectionTitle>
          <div className="flex flex-col gap-2">
            {stopped.map((chat) => (
              <StoppedCard key={chat.key} chat={chat} wide />
            ))}
          </div>
        </section>
      ) : null}
      {running.length > 0 ? (
        <section>
          <SectionTitle count={running.length}>Running now</SectionTitle>
          <ProjectGroups chats={running} now={now} />
        </section>
      ) : null}
      {done.length > 0 ? (
        <section>
          <SectionTitle count={done.length}>Done today</SectionTitle>
          <ProjectGroups chats={done} now={now} />
        </section>
      ) : null}
      {later.length > 0 ? (
        <section>
          <SectionTitle count={later.length}>Later</SectionTitle>
          <div className="rounded-xl border border-border bg-card p-1">
            {later.map((chat) => (
              <ChatLine
                key={chat.key}
                chat={chat}
                now={now}
                right={
                  chat.spec?.schedule
                    ? `${whenLabel(chat.summary.snoozedUntil)} · ${chat.spec.schedule.every}`
                    : `paused until ${whenLabel(chat.summary.snoozedUntil)}`
                }
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function ProjectGroups({ chats, now }: { chats: ReadonlyArray<DemoChat>; now: number }) {
  return (
    <div className="flex flex-col gap-2">
      {groupByProject(chats).map(([project, list]) => {
        const machines = [...new Set(list.map((chat) => chat.machine.label))];
        return (
          <div key={project} className="rounded-xl border border-border bg-card p-1">
            <div className="flex items-center gap-2 px-2 pt-1.5 pb-0.5">
              {project === NO_PROJECT ? (
                <HomeIcon className="size-3.5 text-muted-foreground" />
              ) : (
                <FolderIcon className="size-3.5 text-muted-foreground" />
              )}
              <span className="text-sm font-medium">{project}</span>
              <span className="text-xs text-muted-foreground">{machines.join(" + ")}</span>
            </div>
            {list.map((chat) => (
              <ChatLine key={chat.key} chat={chat} now={now} project={false} detail />
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ── V4: computer lanes ───────────────────────────────────────────────────

const LOAD: Record<string, string> = {
  work: "CPU 64%",
  product: "CPU 38%",
  mac: "CPU 22% · on battery",
};

function Lane({ machine, chats, now }: { machine: DemoMachine; chats: DemoChat[]; now: number }) {
  const [doneOpen, setDoneOpen] = useState(false);
  const mine = chats.filter(
    (chat) => chat.machine.key === machine.key && chat.status !== "archived",
  );
  const running = mine.filter((chat) => chat.status === "running");
  const needs = mine.filter((chat) => chat.status === "needs-you");
  const stopped = mine.filter((chat) => chat.status === "failed");
  const done = mine.filter((chat) => chat.status === "done" && isToday(chat.updatedAt));
  const later = mine.filter((chat) => chat.status === "scheduled" || chat.status === "snoozed");
  return (
    <section
      className="flex min-w-0 flex-col rounded-2xl border border-border bg-card"
      data-testid="demo-lane"
    >
      <header className="flex items-start gap-2.5 border-b border-border/60 px-3.5 py-3">
        <MachineIcon machine={machine} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{machine.label}</span>
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              On
            </span>
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {running.length} running · {LOAD[machine.key]}
          </p>
          {machine.key === "mac" ? (
            <p className="truncate text-xs text-muted-foreground">
              Slept 20:05–20:30 — 1 chat stopped
            </p>
          ) : null}
        </div>
      </header>
      <div className="flex flex-col gap-3 p-2">
        {running.length > 0 ? (
          <div>
            <p className="px-1.5 pb-0.5 text-[11px] font-medium text-muted-foreground uppercase">
              Running
            </p>
            {running.map((chat) => (
              <ChatLine key={chat.key} chat={chat} now={now} machine={false} detail />
            ))}
          </div>
        ) : (
          <p className="px-1.5 text-xs text-muted-foreground">Nothing running.</p>
        )}
        {needs.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <p className="px-1.5 text-[11px] font-medium text-muted-foreground uppercase">
              Needs you
            </p>
            {needs.map((chat) => (
              <NeedsCard key={chat.key} chat={chat} />
            ))}
          </div>
        ) : null}
        {stopped.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <p className="px-1.5 text-[11px] font-medium text-muted-foreground uppercase">
              Stopped
            </p>
            {stopped.map((chat) => (
              <StoppedCard key={chat.key} chat={chat} />
            ))}
          </div>
        ) : null}
        {done.length + later.length > 0 ? (
          <div>
            <button
              type="button"
              onClick={() => setDoneOpen((value) => !value)}
              className="flex h-7 w-full cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground"
            >
              {done.length} done today
              {later.length > 0 ? ` · ${later.length} later` : ""}
              {done.some((chat) => chat.unread) ? (
                <span className="ml-1 size-1.5 rounded-full bg-emerald-500" />
              ) : null}
              <ChevronDownIcon
                className={cn("ml-auto size-3 transition-transform", !doneOpen && "-rotate-90")}
              />
            </button>
            {doneOpen
              ? [...done, ...later].map((chat) => (
                  <ChatLine key={chat.key} chat={chat} now={now} machine={false} dense />
                ))
              : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function SleepingLane() {
  const [waking, setWaking] = useState(false);
  return (
    <section className="flex min-w-0 flex-col rounded-2xl border border-dashed border-border bg-card/40">
      <header className="flex items-start gap-2.5 px-3.5 py-3">
        <CloudIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground/70" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-foreground/80">
              {SLEEPING_BOX.name}
            </span>
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <MoonIcon className="size-3" />
              {waking ? "Waking…" : "Asleep"}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{SLEEPING_BOX.note}</p>
        </div>
      </header>
      <div className="flex flex-col gap-2 px-3.5 pb-3.5">
        <p className="text-xs leading-snug text-muted-foreground">
          No chats here now. It wakes by itself when a chat starts on it — you don't pay while it
          sleeps.
        </p>
        <Button
          size="xs"
          variant="outline"
          className="self-start"
          disabled={waking}
          onClick={() => {
            setWaking(true);
            toastManager.add({
              type: "info",
              title: `Waking ${SLEEPING_BOX.name}…`,
              description: "Demo: nothing really wakes.",
            });
          }}
        >
          Wake now
        </Button>
      </div>
    </section>
  );
}

function LanesHome(props: {
  environmentId: EnvironmentId | null;
  onStart: (prompt: string, options: HomeStartOptions) => Promise<void>;
}) {
  const chats = useDemoChats();
  const now = useNow();
  const visible = chats.filter((chat) => chat.project !== "Uno" || chat.status === "needs-you");
  return (
    <div
      className="mx-auto flex w-full max-w-[90rem] flex-col gap-5 pb-16"
      data-testid="demo-v4-home"
    >
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight">{greeting()}, Misha</h1>
          <Summary chats={chats} />
        </div>
        <div className="min-w-[18rem] flex-1">
          <HomeComposer
            environmentId={props.environmentId}
            starters={[]}
            onStart={props.onStart}
            placeholder="New task — pick the computer under the box"
            minimal
          />
        </div>
      </div>
      <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-2 xl:grid-cols-4">
        {MACHINE_LIST.map((machine) => (
          <Lane key={machine.key} machine={machine} chats={visible} now={now} />
        ))}
        <SleepingLane />
      </div>
    </div>
  );
}

// ── Entry points ─────────────────────────────────────────────────────────

/** Top of the sidebar's chat list: V1 Needs you, V3 the teams tree. */
export function DemoSidebarTop() {
  const variant = useDemoVariant();
  if (variant === "V1") return <NeedsYouBlock />;
  if (variant === "V3") return <TeamsTree />;
  return null;
}

/** V2: the sidebar's chat list is a short list of projects. */
export function DemoSidebarList() {
  return <ProjectsCompact />;
}

/** Home of V2 (the feed) and V4 (lanes). */
export function DemoHome(props: {
  environmentId: EnvironmentId | null;
  onStart: (prompt: string, options: HomeStartOptions) => Promise<void>;
}) {
  const variant = useDemoVariant();
  if (variant === "V4") return <LanesHome {...props} />;
  return <FeedHome {...props} />;
}
