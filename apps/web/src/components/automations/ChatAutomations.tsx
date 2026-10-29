/**
 * The automations of one chat (29.10, T3's ThreadAutomationsPanel): a clock
 * in the chat's header — with how many run here — opens the list: a dot for
 * how it is, its name, when it runs and how soon, Run now, Edit, on/off, and
 * "New automation" (this chat runs it by default; a new chat each time is
 * the other choice). Shown only where the computer has Automations (a cloud
 * computer, the account's switch on). The list is asked again only while
 * the panel is open.
 */
import {
  type Automation,
  type EnvironmentId,
  type ThreadId,
  automationRunsInChat,
  describeAutomationTrigger,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AlarmClockIcon, LoaderCircleIcon, PencilIcon, PlayIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { listAutomations } from "../../lib/automationsApi";
import { cn } from "../../lib/utils";
import { selectEnvironmentState, useStore } from "../../store";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { AutomationDialog, type AutomationChatContext } from "./AutomationDialog";
import { type RunTone, automationDot, nextInLabel, runIsActive } from "./automations.logic";
import { AUTOMATIONS_KEY, useAutomationActions } from "./useAutomations";

const DOT_CLASS: Record<RunTone, string> = {
  ok: "bg-emerald-500",
  running: "bg-sky-500 animate-pulse",
  wait: "bg-amber-500",
  error: "bg-destructive",
  muted: "bg-muted-foreground/40",
};

/** "Mon, Wed, Fri at 19:00 · next in 3h" / "… · off" / "… · running now". */
export function chatAutomationWhen(automation: Automation, nowMs: number): string {
  const when = describeAutomationTrigger(automation.trigger);
  if (!automation.enabled) return `${when} · off`;
  if (runIsActive(automation.lastRun)) return `${when} · running now`;
  const next = nextInLabel(automation.nextRunAt, nowMs);
  return next ? `${when} · next ${next}` : when;
}

function AutomationRow(props: {
  readonly automation: Automation;
  readonly environmentId: string;
  readonly onEdit: () => void;
}) {
  const { automation } = props;
  const actions = useAutomationActions(props.environmentId);
  const [busy, setBusy] = useState<null | "run" | "toggle">(null);
  const task = async (kind: "run" | "toggle", run: () => Promise<unknown>) => {
    setBusy(kind);
    try {
      await run();
      if (kind === "run") toastManager.add({ type: "success", title: "It runs in a moment" });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: kind === "run" ? "Couldn't run it" : "Couldn't change it",
        description: cause instanceof Error ? cause.message : "Its computer didn't answer.",
      });
    } finally {
      setBusy(null);
    }
  };
  const dot = automationDot(automation);
  return (
    <li
      className="flex items-center gap-2 px-2 py-2"
      data-testid="chat-automation-row"
      data-automation={automation.id}
      data-enabled={automation.enabled}
    >
      <span
        className={cn("size-2 shrink-0 rounded-full", DOT_CLASS[dot])}
        data-testid="chat-automation-dot"
        data-tone={dot}
        aria-hidden
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            "truncate text-sm font-medium",
            !automation.enabled && "text-muted-foreground",
          )}
        >
          {automation.name}
        </span>
        <span className="truncate text-xs text-muted-foreground" data-testid="chat-automation-when">
          {chatAutomationWhen(automation, Date.now())}
        </span>
      </div>
      <Button
        size="icon-xs"
        variant="ghost"
        title="Run now"
        aria-label={`Run ${automation.name} now`}
        disabled={busy !== null || !automation.enabled}
        onClick={() => void task("run", () => actions.runNow(automation.id))}
        data-testid="chat-automation-run"
      >
        {busy === "run" ? (
          <LoaderCircleIcon className="size-3.5 animate-spin" />
        ) : (
          <PlayIcon className="size-3.5" />
        )}
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        title="Edit"
        aria-label={`Edit ${automation.name}`}
        onClick={props.onEdit}
        data-testid="chat-automation-edit"
      >
        <PencilIcon className="size-3.5" />
      </Button>
      <Switch
        checked={automation.enabled}
        disabled={busy !== null}
        onCheckedChange={(enabled) =>
          void task("toggle", () => actions.update(automation.id, { enabled }))
        }
        aria-label={automation.enabled ? "Pause it" : "Turn it on"}
        data-testid="chat-automation-toggle"
      />
    </li>
  );
}

/** The clock in a chat's header and its panel. Nothing where Automations aren't. */
export function ChatAutomationsButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<{ automation: Automation | null } | null>(null);
  const navigate = useNavigate();
  const list = useQuery({
    queryKey: [...AUTOMATIONS_KEY, "list", props.environmentId],
    queryFn: () => listAutomations({ environmentId: props.environmentId }),
    // The same cache as the Automations screen; asked often only while open.
    staleTime: 60_000,
    retry: false,
    refetchInterval: open ? 5_000 : false,
  });
  // Primitives only: a new object per render would loop the store.
  const shell = useStore(
    (state) =>
      selectEnvironmentState(state, props.environmentId).threadShellById[props.threadId] ?? null,
  );
  const projectName = useStore((state) =>
    shell
      ? (selectEnvironmentState(state, props.environmentId).projectById[shell.projectId]?.name ??
        null)
      : null,
  );
  const chat: AutomationChatContext | null = shell
    ? {
        environmentId: props.environmentId,
        threadId: props.threadId,
        title: shell.title,
        projectId: shell.projectId,
        projectTitle: projectName ?? "this project",
      }
    : null;
  if (list.data?.available !== true || chat === null) return null;
  const mine = list.data.automations.filter((a) => automationRunsInChat(a, props.threadId));
  const active = mine.filter((a) => a.enabled).length;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          data-testid="chat-automations-button"
          data-count={mine.length}
          title={
            mine.length > 0
              ? `${mine.length} automation${mine.length === 1 ? "" : "s"} in this chat`
              : "Automations: make this chat do something on its own"
          }
          aria-label="Automations in this chat"
          className={cn(
            "inline-flex h-7 min-w-7 shrink-0 cursor-pointer items-center justify-center gap-1 rounded-md border border-input px-[calc(--spacing(1)-1px)] text-xs shadow-xs/5 hover:bg-accent hover:text-foreground sm:h-6 sm:min-w-6",
            active > 0 ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <AlarmClockIcon className="size-3.5" />
          {mine.length > 0 ? (
            <span className="pr-0.5 tabular-nums" data-testid="chat-automations-count">
              {mine.length}
            </span>
          ) : null}
        </PopoverTrigger>
        <PopoverPopup align="end" className="w-[24rem]" data-testid="chat-automations-panel">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold">Automations in this chat</span>
              <button
                type="button"
                className="cursor-pointer text-xs text-muted-foreground hover:text-foreground hover:underline"
                onClick={() => {
                  setOpen(false);
                  void navigate({ to: "/automations" });
                }}
                data-testid="chat-automations-all"
              >
                All automations
              </button>
            </div>
            {mine.length > 0 ? (
              <ul className="divide-y divide-border/70 rounded-md border border-border/70">
                {mine.map((automation) => (
                  <AutomationRow
                    key={automation.id}
                    automation={automation}
                    environmentId={props.environmentId}
                    onEdit={() => {
                      setOpen(false);
                      setDialog({ automation });
                    }}
                  />
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground" data-testid="chat-automations-empty">
                Nothing runs here on its own yet. Say it in the chat — “every weekday at 9, sum up
                what changed” — or set one up.
              </p>
            )}
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              onClick={() => {
                setOpen(false);
                setDialog({ automation: null });
              }}
              data-testid="chat-automations-new"
            >
              <PlusIcon className="size-3.5" /> New automation
            </Button>
          </div>
        </PopoverPopup>
      </Popover>
      <AutomationDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        choices={[]}
        chat={chat}
        automation={dialog?.automation ?? null}
        automationEnvironmentId={props.environmentId}
      />
    </>
  );
}
