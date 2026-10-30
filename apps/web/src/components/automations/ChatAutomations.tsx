/**
 * The automations of one chat (29.10, T3's ThreadAutomationsPanel): the list
 * lives in the Panel, and a clock in the chat's header — with how many run
 * here — opens it too once the chat has some (Misha 30.10). A row: a dot for
 * how it is, its name, when it runs and how soon, Run now, Edit, on/off, and
 * "New automation" (this chat runs it by default; a new chat each time is
 * the other choice). Shown only where the computer has Automations (a cloud
 * computer, the account's switch on). The list is asked again only while
 * it is open.
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

export interface ChatAutomationsHere {
  readonly environmentId: EnvironmentId;
  readonly chat: AutomationChatContext;
  /** The ones that run in this chat. */
  readonly automations: ReadonlyArray<Automation>;
}

/** A chat's automations; null where there are none to have (no such chat, no Automations). */
export function useChatAutomations(
  environmentId: EnvironmentId | null,
  threadId: string | null,
  /** On screen: asked often. */
  live: boolean,
): ChatAutomationsHere | null {
  const list = useQuery({
    queryKey: [...AUTOMATIONS_KEY, "list", environmentId],
    queryFn: () => listAutomations({ environmentId: environmentId as EnvironmentId }),
    enabled: environmentId !== null,
    // The same cache as the Automations screen; asked often only while open.
    staleTime: 60_000,
    retry: false,
    refetchInterval: live ? 5_000 : false,
  });
  // Primitives only: a new object per render would loop the store.
  const shell = useStore((state) =>
    environmentId && threadId
      ? (selectEnvironmentState(state, environmentId).threadShellById[threadId as ThreadId] ?? null)
      : null,
  );
  const projectName = useStore((state) =>
    environmentId && shell
      ? (selectEnvironmentState(state, environmentId).projectById[shell.projectId]?.name ?? null)
      : null,
  );
  if (list.data?.available !== true || environmentId === null || shell === null) return null;
  return {
    environmentId,
    chat: {
      environmentId,
      threadId: threadId as ThreadId,
      title: shell.title,
      projectId: shell.projectId,
      projectTitle: projectName ?? "this project",
    },
    automations: list.data.automations.filter((a) => automationRunsInChat(a, threadId as ThreadId)),
  };
}

/** The list: the same in the header's clock and in the Panel. */
function ChatAutomationsList(props: {
  readonly here: ChatAutomationsHere;
  /** A row's Edit, or New automation (null). */
  readonly onEdit: (automation: Automation | null) => void;
  /** Leaving for All automations. */
  readonly onLeave?: () => void;
}) {
  const { here } = props;
  const navigate = useNavigate();
  return (
    <div className="flex flex-col gap-2" data-testid="chat-automations-panel">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">Automations in this chat</span>
        <button
          type="button"
          className="cursor-pointer text-xs text-muted-foreground hover:text-foreground hover:underline"
          onClick={() => {
            props.onLeave?.();
            void navigate({ to: "/automations" });
          }}
          data-testid="chat-automations-all"
        >
          All automations
        </button>
      </div>
      {here.automations.length > 0 ? (
        <ul className="divide-y divide-border/70 rounded-md border border-border/70">
          {here.automations.map((automation) => (
            <AutomationRow
              key={automation.id}
              automation={automation}
              environmentId={here.environmentId}
              onEdit={() => props.onEdit(automation)}
            />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="chat-automations-empty">
          Nothing runs here on its own yet. Say it in the chat — “every weekday at 9, sum up what
          changed” — or set one up.
        </p>
      )}
      <Button
        size="sm"
        variant="outline"
        className="self-start"
        onClick={() => props.onEdit(null)}
        data-testid="chat-automations-new"
      >
        <PlusIcon className="size-3.5" /> New automation
      </Button>
    </div>
  );
}

/** Stays on screen after the list that asked for it has closed. */
function ChatAutomationDialog(props: {
  readonly here: ChatAutomationsHere;
  readonly dialog: { automation: Automation | null } | null;
  readonly onClose: () => void;
}) {
  return (
    <AutomationDialog
      open={props.dialog !== null}
      onClose={props.onClose}
      choices={[]}
      chat={props.here.chat}
      automation={props.dialog?.automation ?? null}
      automationEnvironmentId={props.here.environmentId}
    />
  );
}

/** The list in the Panel. */
export function ChatAutomationsInPanel(props: { readonly here: ChatAutomationsHere }) {
  const [dialog, setDialog] = useState<{ automation: Automation | null } | null>(null);
  return (
    <>
      <ChatAutomationsList here={props.here} onEdit={(automation) => setDialog({ automation })} />
      <ChatAutomationDialog here={props.here} dialog={dialog} onClose={() => setDialog(null)} />
    </>
  );
}

/** The clock in a chat's header: only once the chat has automations. */
export function ChatAutomationsButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<{ automation: Automation | null } | null>(null);
  const here = useChatAutomations(props.environmentId, props.threadId, open);
  if (here === null || here.automations.length === 0) return null;
  const count = here.automations.length;
  const active = here.automations.filter((a) => a.enabled).length;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          data-testid="chat-automations-button"
          data-count={count}
          title={`${count} automation${count === 1 ? "" : "s"} in this chat`}
          aria-label="Automations in this chat"
          className={cn(
            "inline-flex h-7 min-w-7 shrink-0 cursor-pointer items-center justify-center gap-1 rounded-md border border-input px-[calc(--spacing(1)-1px)] text-xs shadow-xs/5 hover:bg-accent hover:text-foreground sm:h-6 sm:min-w-6",
            active > 0 ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <AlarmClockIcon className="size-3.5" />
          <span className="pr-0.5 tabular-nums" data-testid="chat-automations-count">
            {count}
          </span>
        </PopoverTrigger>
        <PopoverPopup align="end" className="w-[24rem]">
          <ChatAutomationsList
            here={here}
            onLeave={() => setOpen(false)}
            onEdit={(automation) => {
              setOpen(false);
              setDialog({ automation });
            }}
          />
        </PopoverPopup>
      </Popover>
      <ChatAutomationDialog here={here} dialog={dialog} onClose={() => setDialog(null)} />
    </>
  );
}
