/**
 * One automation as a card: its name, "When …" in words, the instruction, a
 * switch, the last run (state, link to the chat and the PR), Run now, and
 * ⋯ → Edit / Delete. What's wrong with it (GitHub can't see the repo, a
 * permission to accept) is a line with the button that fixes it.
 */
import {
  type Automation,
  type AutomationRun,
  type EnvironmentId,
  type ThreadId,
  describeAutomationTrigger,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertTriangleIcon,
  ArrowUpRightIcon,
  CalendarClockIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  GitPullRequestIcon,
  HistoryIcon,
  LoaderCircleIcon,
  MailIcon,
  MoonIcon,
  MoreHorizontalIcon,
  PlayIcon,
  VideoIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { callTimeLabel } from "../assistants/joinCalls.logic";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { type RunTone, runLine, statusProblem } from "./automations.logic";
import { useAutomationActions, useAutomationRuns } from "./useAutomations";

const TRIGGER_ICON = {
  schedule: CalendarClockIcon,
  "github.pull_request": GitPullRequestIcon,
  "call.ended": VideoIcon,
  "gmail.message": MailIcon,
} as const;

const TONE_ICON: Record<RunTone, typeof CircleCheckIcon> = {
  ok: CircleCheckIcon,
  running: LoaderCircleIcon,
  wait: MoonIcon,
  error: CircleXIcon,
  muted: CircleDashedIcon,
};

const TONE_CLASS: Record<RunTone, string> = {
  ok: "text-success",
  running: "text-sky-500 animate-spin",
  wait: "text-amber-500",
  error: "text-destructive",
  muted: "text-muted-foreground",
};

export function openExternalUrl(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/** One run as a line: its state, when, and the links (its chat, the PR). */
function RunRow(props: {
  readonly run: AutomationRun;
  readonly environmentId: string;
  readonly computer: string;
  readonly compact?: boolean;
}) {
  const { run } = props;
  const navigate = useNavigate();
  const line = runLine(run, props.computer);
  const Icon = TONE_ICON[line.tone];
  const at = run.finishedAt ?? run.startedAt ?? run.createdAt;
  const pr = run.url && /\/pull\/(\d+)/.exec(run.url)?.[1];
  return (
    <div
      className="flex min-w-0 flex-col gap-0.5"
      data-testid="automation-run"
      data-state={run.state}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
        <Icon className={cn("size-3.5 shrink-0", TONE_CLASS[line.tone])} />
        {props.compact ? null : (
          <span className="min-w-0 truncate font-medium text-foreground">{run.title}</span>
        )}
        <span
          className={cn(
            line.tone === "error"
              ? "text-destructive"
              : line.tone === "wait"
                ? "text-amber-700 dark:text-amber-400"
                : "text-muted-foreground",
          )}
          data-testid="automation-run-line"
        >
          {props.compact ? `${run.title} — ${line.text}` : `— ${line.text}`}
        </span>
        <span className="text-muted-foreground/70">· {formatRelativeTimeLabel(at)}</span>
        {run.threadId ? (
          <button
            type="button"
            className="cursor-pointer text-primary hover:underline"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams({
                  environmentId: props.environmentId as EnvironmentId,
                  threadId: run.threadId as ThreadId,
                }),
              })
            }
            data-testid="automation-run-chat"
          >
            Open chat
          </button>
        ) : null}
        {run.url ? (
          <button
            type="button"
            className="inline-flex cursor-pointer items-center gap-0.5 text-primary hover:underline"
            onClick={() => openExternalUrl(run.url!)}
          >
            {pr ? `PR #${pr}` : "Link"}
            <ArrowUpRightIcon className="size-3" />
          </button>
        ) : null}
      </div>
      {run.summary && !props.compact ? (
        <p
          className="line-clamp-2 pl-5 text-xs text-muted-foreground"
          data-testid="automation-run-summary"
        >
          {run.summary}
        </p>
      ) : null}
    </div>
  );
}

function RunHistory(props: {
  readonly automation: Automation;
  readonly environmentId: string;
  readonly computer: string;
}) {
  const runs = useAutomationRuns(props.environmentId, props.automation.id, true);
  if (runs.isLoading) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <LoaderCircleIcon className="size-3 animate-spin" /> Asking its computer…
      </p>
    );
  }
  const list = runs.data ?? [];
  if (list.length === 0) return <p className="text-xs text-muted-foreground">No runs yet.</p>;
  return (
    <div className="flex flex-col gap-1" data-testid="automation-history">
      {list.slice(0, 10).map((run) => (
        <RunRow
          key={run.id}
          run={run}
          environmentId={props.environmentId}
          computer={props.computer}
          compact
        />
      ))}
    </div>
  );
}

export function AutomationCard(props: {
  readonly automation: Automation;
  readonly environmentId: string;
  /** Its computer's name ("uno-work"), for "Waiting — uno-work is asleep". */
  readonly computer: string;
  readonly onEdit: () => void;
  /** On the Automations screen: whose it is. */
  readonly showAssistant?: boolean;
  readonly highlighted?: boolean;
}) {
  const { automation } = props;
  const actions = useAutomationActions(props.environmentId);
  const [busy, setBusy] = useState<null | "toggle" | "run" | "delete">(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [history, setHistory] = useState(false);
  const problem = statusProblem(automation);
  const Icon = TRIGGER_ICON[automation.trigger.kind];
  const next =
    automation.enabled && automation.nextRunAt
      ? callTimeLabel(automation.nextRunAt, Date.now())
      : null;

  const task = async (kind: "toggle" | "run" | "delete", run: () => Promise<unknown>) => {
    setBusy(kind);
    try {
      await run();
    } catch (cause) {
      toastManager.add({
        type: "error",
        title:
          kind === "run"
            ? "Couldn't run it"
            : kind === "delete"
              ? "Couldn't delete it"
              : "Couldn't change it",
        description: errorText(cause, "Its computer didn't answer."),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className={cn(
        "flex flex-col gap-2 border-b border-border/70 px-3 py-3 last:border-b-0",
        !automation.enabled && "bg-muted/20",
        props.highlighted && "bg-primary/[0.04] ring-1 ring-primary/40 ring-inset",
      )}
      data-testid="automation-card"
      data-automation={automation.id}
      data-enabled={automation.enabled}
      data-status={automation.status}
    >
      <div className="flex items-start gap-2.5">
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn(
              "truncate text-sm font-medium",
              !automation.enabled && "text-muted-foreground",
            )}
            data-testid="automation-name"
          >
            {automation.name}
            {props.showAssistant ? (
              <span className="font-normal text-muted-foreground">
                {" "}
                · {automation.assistantName}
              </span>
            ) : null}
          </span>
          <span className="text-xs text-muted-foreground" data-testid="automation-when">
            {describeAutomationTrigger(automation.trigger)}
            {next ? ` · next: ${next}` : ""}
            {automation.enabled ? "" : " · off"}
          </span>
          <span className="line-clamp-2 text-xs text-foreground/80">
            “{automation.instruction}”
          </span>
        </div>
        <Switch
          checked={automation.enabled}
          disabled={busy !== null}
          onCheckedChange={(checked) =>
            void task("toggle", () => actions.update(automation.id, { enabled: checked }))
          }
          aria-label={
            automation.enabled ? `Turn off ${automation.name}` : `Turn on ${automation.name}`
          }
          data-testid="automation-switch"
        />
        <Menu>
          <MenuTrigger
            aria-label="More"
            className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            data-testid="automation-menu"
          >
            <MoreHorizontalIcon className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end" side="bottom" className="min-w-36">
            <MenuItem onClick={props.onEdit} data-testid="automation-edit">
              Edit
            </MenuItem>
            <MenuItem
              onClick={() => setConfirmDelete(true)}
              className="text-destructive"
              data-testid="automation-delete"
            >
              Delete
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>

      {problem ? (
        <div
          className="ml-6.5 flex flex-wrap items-center gap-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-800 dark:text-amber-300"
          data-testid="automation-problem"
          data-kind={problem.kind}
        >
          <AlertTriangleIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{problem.text}</span>
          {problem.url ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => openExternalUrl(problem.url!)}
              data-testid="automation-problem-fix"
            >
              {problem.action}
              <ArrowUpRightIcon className="size-3" />
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="ml-6.5 flex flex-col gap-1.5">
        {automation.lastRun ? (
          <RunRow
            run={automation.lastRun}
            environmentId={props.environmentId}
            computer={props.computer}
          />
        ) : (
          <span className="text-xs text-muted-foreground" data-testid="automation-no-runs">
            Hasn't run yet.
          </span>
        )}
        {history ? (
          <RunHistory
            automation={automation}
            environmentId={props.environmentId}
            computer={props.computer}
          />
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null || !automation.enabled || problem !== null}
            onClick={() =>
              void task("run", async () => {
                await actions.runNow(automation.id);
                toastManager.add({
                  type: "success",
                  title: `${automation.assistantName} is on it`,
                  description: "The result comes to its chat — and to Telegram, if it's linked.",
                });
              })
            }
            data-testid="automation-run-now"
          >
            {busy === "run" ? (
              <LoaderCircleIcon className="size-3 animate-spin" />
            ) : (
              <PlayIcon className="size-3" />
            )}
            Run now
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setHistory((value) => !value)}
            aria-expanded={history}
            data-testid="automation-history-toggle"
          >
            <HistoryIcon className="size-3" />
            {history ? "Hide history" : "History"}
          </Button>
        </div>
        {confirmDelete ? (
          <div
            className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs"
            data-testid="automation-delete-confirm"
          >
            <span className="min-w-0 flex-1">
              Delete “{automation.name}”? It stops for good; its chats stay.
            </span>
            <Button
              size="xs"
              variant="destructive"
              disabled={busy !== null}
              onClick={() => void task("delete", () => actions.remove(automation.id))}
              data-testid="automation-delete-yes"
            >
              Delete
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
