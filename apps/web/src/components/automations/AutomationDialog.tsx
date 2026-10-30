/**
 * New / Edit automation: When (a schedule in plain choices, or an event —
 * a GitHub pull request, after a call, Gmail soon) → What to do, in the
 * person's words. The mode is the assistant's own and is said in one line.
 * Who (29.10): an assistant, or — opened from a chat — this chat / a new
 * chat each time. Schedules: every day, weekdays, picked days, every N
 * minutes or hours (15 minutes at least), every week.
 * No cron, no JSON: the dialog makes the trigger (`automations.logic.ts`).
 */
import {
  AUTOMATION_EVERY_MINUTES,
  AUTOMATION_INSTRUCTION_MAX_CHARS,
  AUTOMATION_NAME_MAX_CHARS,
  type Automation,
  type AutomationCadence,
  type AutomationExecutor,
  type EnvironmentId,
  automationExecutorOf,
  everyLabel,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  CalendarClockIcon,
  FileTextIcon,
  GitPullRequestIcon,
  HandIcon,
  LoaderCircleIcon,
  MailIcon,
  MessageSquareIcon,
  VideoIcon,
  WebhookIcon,
  ZapIcon,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { getAssistantCalls } from "../../lib/assistantCallsApi";
import { AutomationApiError, listAutomationRepos } from "../../lib/automationsApi";
import { cn } from "../../lib/utils";
import { CALLS_KEY } from "../assistants/JoinCallsSection";
import { joinCallsStage } from "../assistants/joinCalls.logic";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { openExternalUrl } from "./AutomationCard";
import {
  type AutomationDraft,
  EMPTY_DRAFT,
  type EventSource,
  askLine,
  autoName,
  browserTimeZone,
  draftOf,
  draftProblem,
  isRepoName,
  modeLine,
  normalizeRepo,
  suggestionsFor,
  triggerOf,
} from "./automations.logic";
import { AUTOMATIONS_KEY, useAutomationActions, useAutomationsOn } from "./useAutomations";

/** An assistant the automation can be for. */
export interface AutomationAssistantChoice {
  readonly environmentId: string;
  readonly projectId: string;
  readonly name: string;
  readonly computer: string;
  readonly asksFirst: boolean;
  /** False: on a laptop (or Automations are off there) — `note` says why. */
  readonly available: boolean;
  readonly note?: string | null;
}

const choiceKey = (choice: Pick<AutomationAssistantChoice, "environmentId" | "projectId">) =>
  `${choice.environmentId}:${choice.projectId}`;

/**
 * The chat the dialog was opened from (its clock panel, 29.10): then "Who"
 * offers "This chat" (each run a new message here) and "A new chat each
 * time" in its project, besides the assistants.
 */
export interface AutomationChatContext {
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
  readonly projectId: string;
  readonly projectTitle: string;
}

/** A chat the Automations screen offers for a form: picks the computer too. */
export interface AutomationChatChoice extends AutomationChatContext {
  readonly computer: string;
}

const THIS_CHAT = "chat:this";
const NEW_CHAT = "chat:new";

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const CADENCES: ReadonlyArray<{ readonly id: AutomationCadence; readonly label: string }> = [
  { id: "daily", label: "Every day" },
  { id: "weekdays", label: "Weekdays" },
  { id: "days", label: "Days…" },
  { id: "every", label: "Every…" },
  { id: "weekly", label: "Every week" },
];
/** Monday first, the way a week reads. */
const DAY_CHIPS: ReadonlyArray<{ readonly day: number; readonly label: string }> = [
  { day: 1, label: "Mo" },
  { day: 2, label: "Tu" },
  { day: 3, label: "We" },
  { day: 4, label: "Th" },
  { day: 5, label: "Fr" },
  { day: 6, label: "Sa" },
  { day: 0, label: "Su" },
];
const MINUTES = ["00", "15", "30", "45"];

function Chip(props: {
  readonly on: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly testId: string;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      aria-pressed={props.on}
      data-testid={props.testId}
      className={cn(
        "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        props.on
          ? "border-foreground/60 bg-foreground/5 font-medium text-foreground"
          : "border-input text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {props.children}
    </button>
  );
}

function Label(props: { readonly children: ReactNode }) {
  return <div className="mb-1.5 text-xs font-medium text-foreground">{props.children}</div>;
}

/** The kinds of events, as rows to pick. */
function SourceRow(props: {
  readonly on: boolean;
  readonly icon: ReactNode;
  readonly title: string;
  readonly hint: string;
  readonly soon?: boolean;
  readonly onClick: () => void;
  readonly testId: string;
}) {
  return (
    <button
      type="button"
      disabled={props.soon}
      onClick={props.onClick}
      aria-pressed={props.on}
      data-testid={props.testId}
      className={cn(
        "flex w-full cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        props.on ? "border-foreground/50 bg-foreground/[0.03]" : "border-input hover:bg-accent/50",
      )}
    >
      <span className="mt-0.5 text-muted-foreground">{props.icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2 text-sm">
          {props.title}
          {props.soon ? (
            <span className="rounded-full border border-border px-1.5 text-[10px] text-muted-foreground">
              Soon
            </span>
          ) : null}
        </span>
        <span className="text-xs text-muted-foreground">{props.hint}</span>
      </span>
    </button>
  );
}

/** The repository: type or pick from what the Uno GitHub app sees. */
function RepoPicker(props: {
  readonly environmentId: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const navigate = useNavigate();
  const repos = useQuery({
    queryKey: [...AUTOMATIONS_KEY, "repos", props.environmentId],
    queryFn: () => listAutomationRepos({ environmentId: props.environmentId as EnvironmentId }),
    retry: false,
    staleTime: 30_000,
  });
  const [focused, setFocused] = useState(false);
  const data = repos.data;
  const typed = normalizeRepo(props.value).toLowerCase();
  const list = data?.repos ?? [];
  const matches = list
    .filter((repo) => typed === "" || repo.fullName.toLowerCase().includes(typed))
    .slice(0, 6);
  const exact = list.some((repo) => repo.fullName.toLowerCase() === typed);
  const unseen = data?.connected === true && isRepoName(props.value) && !exact;
  // Not connected: the daemon gives the connect link as `manageUrl` (or `connectUrl`).
  const connectUrl =
    (data as { connectUrl?: string | null } | undefined)?.connectUrl ?? data?.manageUrl ?? null;

  if (repos.isLoading) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <LoaderCircleIcon className="size-3 animate-spin" /> Asking GitHub for your repositories…
      </p>
    );
  }
  if (data && !data.connected) {
    return (
      <div
        className="flex flex-wrap items-center gap-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-800 dark:text-amber-300"
        data-testid="automation-github-off"
      >
        <span className="min-w-0 flex-1">
          GitHub isn't connected — Uno needs it to see your pull requests.
        </span>
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            connectUrl ? openExternalUrl(connectUrl) : void navigate({ to: "/settings/connectors" })
          }
          data-testid="automation-github-connect"
        >
          Connect GitHub
        </Button>
      </div>
    );
  }
  return (
    <div className="relative flex flex-col gap-1.5">
      <Input
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => window.setTimeout(() => setFocused(false), 150)}
        placeholder="owner/repository"
        aria-label="Repository"
        autoComplete="off"
        spellCheck={false}
        data-testid="automation-repo"
      />
      {focused && matches.length > 0 && !exact ? (
        <div
          className="flex flex-col rounded-lg border border-border bg-popover py-1 shadow-md"
          data-testid="automation-repo-options"
        >
          {matches.map((repo) => (
            <button
              key={repo.fullName}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                props.onChange(repo.fullName);
                setFocused(false);
              }}
              className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
              data-testid={`automation-repo-option-${repo.fullName}`}
            >
              <GitPullRequestIcon className="size-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{repo.fullName}</span>
              {repo.private ? (
                <span className="text-[10px] text-muted-foreground">private</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      {unseen ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-800 dark:text-amber-300"
          data-testid="automation-repo-unseen"
        >
          <span className="min-w-0 flex-1">
            Uno's GitHub app can't see {normalizeRepo(props.value)}.
          </span>
          {data?.manageUrl ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => openExternalUrl(data.manageUrl!)}
              data-testid="automation-repo-add"
            >
              Add it on GitHub
              <ArrowUpRightIcon className="size-3" />
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** "After a call" needs the assistant's "Join my calls". */
function CallsHint(props: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly name: string;
}) {
  const calls = useQuery({
    queryKey: [...CALLS_KEY, props.environmentId],
    queryFn: () => getAssistantCalls({ environmentId: props.environmentId as EnvironmentId }),
    retry: false,
    staleTime: 10_000,
  });
  if (calls.isLoading) return null;
  if (joinCallsStage(calls.data, props.projectId) !== "off") {
    return (
      <p className="text-xs text-muted-foreground" data-testid="automation-calls-on">
        {props.name} joins your calls — it runs this when the notes come in.
      </p>
    );
  }
  return (
    <p
      className="rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-800 dark:text-amber-300"
      data-testid="automation-calls-off"
    >
      Turn on “Join my calls” on {props.name}'s page first — then it gets the notes after each call
      and runs this.
    </p>
  );
}

export function AutomationDialog(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Who it can be for (one on an assistant's page; all of them on the Automations screen). */
  readonly choices: ReadonlyArray<AutomationAssistantChoice>;
  /** Edit this one (its assistant stays). */
  readonly automation?: Automation | null;
  readonly automationEnvironmentId?: string | null;
  /** Opened from a chat: it can run it itself (the default then). */
  readonly chat?: AutomationChatContext | null;
  /** Opened elsewhere: chats a form can go to, on every computer. */
  readonly chatChoices?: ReadonlyArray<AutomationChatChoice>;
  readonly onSaved?: (automation: Automation, environmentId: string) => void;
}) {
  // Mounted fresh each time it opens: the draft starts from the automation or empty.
  return (
    <Dialog open={props.open} onOpenChange={(next) => (next ? undefined : props.onClose())}>
      {props.open ? <AutomationDialogBody {...props} /> : null}
    </Dialog>
  );
}

function AutomationDialogBody(props: Parameters<typeof AutomationDialog>[0]) {
  const editing = props.automation ?? null;
  const [pickedChatKey, setPickedChatKey] = useState("");
  const chatChoices = props.chatChoices ?? [];
  const chat: AutomationChatContext | null =
    props.chat ??
    chatChoices.find((item) => `${item.environmentId}:${item.threadId}` === pickedChatKey) ??
    null;
  const editingExecutor = editing ? automationExecutorOf(editing) : null;
  const firstUsable = props.choices.find((choice) => choice.available);
  const [who, setWho] = useState<string>(() =>
    editing
      ? editingExecutor?.kind === "assistant"
        ? `${props.automationEnvironmentId ?? ""}:${editing.assistant}`
        : editingExecutor?.kind === "new_chat"
          ? NEW_CHAT
          : THIS_CHAT
      : chat
        ? THIS_CHAT
        : firstUsable
          ? choiceKey(firstUsable)
          : "",
  );
  const inChat = who === THIS_CHAT || who === NEW_CHAT;
  const choice: AutomationAssistantChoice | null = inChat
    ? null
    : (props.choices.find((item) => choiceKey(item) === who) ??
      (editing && props.automationEnvironmentId
        ? {
            environmentId: props.automationEnvironmentId,
            projectId: editing.assistant,
            name: editing.assistantName,
            computer: "",
            asksFirst: false,
            available: true,
          }
        : null));
  // Where it is saved and what it is called in the lines below.
  const environmentId = inChat
    ? (chat?.environmentId ?? props.automationEnvironmentId ?? null)
    : (choice?.environmentId ?? null);
  const executor: AutomationExecutor | null = !inChat
    ? null
    : editing && editingExecutor && editingExecutor.kind !== "assistant" && !chat
      ? editingExecutor
      : chat
        ? who === THIS_CHAT
          ? { kind: "chat", threadId: chat.threadId, title: chat.title }
          : {
              kind: "new_chat",
              projectId: chat.projectId,
              fromThreadId: chat.threadId,
              title: chat.projectTitle,
            }
        : null;
  const doer = inChat ? (who === THIS_CHAT ? "This chat" : "A new chat") : (choice?.name ?? "It");
  const [draft, setDraft] = useState<AutomationDraft>(() =>
    editing ? draftOf(editing) : EMPTY_DRAFT,
  );
  const [nameTouched, setNameTouched] = useState(editing !== null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<AutomationApiError | null>(null);
  const actions = useAutomationActions(environmentId ?? "");
  const timezone = useMemo(() => browserTimeZone(), []);
  const set = (patch: Partial<AutomationDraft>) => {
    setFailure(null);
    setDraft((current) => ({ ...current, ...patch }));
  };
  const formEvent = draft.when === "event" && draft.source === "form";
  const outsideEvent = formEvent || (draft.when === "event" && draft.source === "webhook");
  const problem =
    inChat && draft.when === "event" && draft.source === "call"
      ? "After a call is for an assistant."
      : outsideEvent && (!inChat || executor === null)
        ? "Pick a chat for it."
        : draftProblem(draft);
  const listed = useAutomationsOn(environmentId);
  // Webhooks and forms show only where the console has them on, or when
  // this one already is one.
  const hooksOn = listed.data?.hooksEnabled === true || (editing !== null && outsideEvent);
  const name = nameTouched && draft.name.trim() ? draft.name.trim() : autoName(draft);
  const kind = triggerOf(draft, timezone).kind;
  const assistantName = doer;
  const navigate = useNavigate();

  const save = async () => {
    if ((!choice && !executor) || environmentId === null || problem) return;
    setSaving(true);
    setFailure(null);
    const trigger = triggerOf(draft, timezone);
    const instruction = draft.instruction.trim();
    try {
      const changedExecutor =
        editing && executor && JSON.stringify(executor) !== JSON.stringify(editingExecutor)
          ? { executor }
          : {};
      const saved = editing
        ? await actions.update(editing.id, { name, instruction, trigger, ...changedExecutor })
        : executor
          ? await actions.create({ name, instruction, trigger, executor })
          : await actions.create({ assistant: choice!.projectId, name, instruction, trigger });
      toastManager.add({
        type: "success",
        title: editing
          ? "Saved"
          : executor?.kind === "chat"
            ? "This chat will do it"
            : executor
              ? "A new chat will do it"
              : `${choice!.name} will do it`,
        description: `${name} · ${triggerLabel(saved, trigger)}`,
      });
      props.onSaved?.(saved, environmentId);
      props.onClose();
    } catch (cause) {
      setFailure(
        cause instanceof AutomationApiError
          ? cause
          : new AutomationApiError(
              "ERROR",
              cause instanceof Error ? cause.message : "Its computer didn't answer.",
              null,
            ),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogPopup className="max-w-lg" data-testid="automation-dialog">
      <DialogHeader>
        <DialogTitle>{editing ? "Edit automation" : "New automation"}</DialogTitle>
        <DialogDescription>
          {assistantName} does it by itself — on a schedule or when something happens.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-5">
        {(!editing && (props.choices.length > 1 || chat !== null)) ||
        (editing && inChat && chat !== null) ? (
          <div>
            <Label>Who</Label>
            <select
              value={who}
              onChange={(event) => {
                setWho(event.target.value);
                setFailure(null);
              }}
              className="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm"
              aria-label="Who does it"
              data-testid="automation-assistant"
            >
              {chat ? (
                <>
                  <option value={THIS_CHAT}>This chat — each run is a new message here</option>
                  <option value={NEW_CHAT}>A new chat each time — in {chat.projectTitle}</option>
                </>
              ) : null}
              {editing && inChat
                ? null
                : props.choices.map((item) => (
                    <option
                      key={choiceKey(item)}
                      value={choiceKey(item)}
                      disabled={!item.available}
                    >
                      {item.name} · {item.computer}
                      {item.available ? "" : ` — ${item.note ?? "not here"}`}
                    </option>
                  ))}
            </select>
          </div>
        ) : null}

        <div>
          <Label>When</Label>
          <div className="flex flex-wrap gap-1.5">
            <Chip
              on={draft.when === "schedule"}
              onClick={() => set({ when: "schedule" })}
              testId="automation-when-schedule"
            >
              <CalendarClockIcon className="size-3.5" /> On a schedule
            </Chip>
            <Chip
              on={draft.when === "event"}
              onClick={() => set({ when: "event" })}
              testId="automation-when-event"
            >
              <ZapIcon className="size-3.5" /> When something happens
            </Chip>
          </div>
          {draft.when === "schedule" ? (
            <div className="mt-3 flex flex-col gap-2">
              <div className="flex flex-wrap gap-1.5">
                {CADENCES.map((item) => (
                  <Chip
                    key={item.id}
                    on={draft.cadence === item.id}
                    onClick={() => set({ cadence: item.id })}
                    testId={`automation-cadence-${item.id}`}
                  >
                    {item.label}
                  </Chip>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {draft.cadence === "weekly" ? (
                  <>
                    <span className="text-muted-foreground">on</span>
                    <select
                      value={draft.weekday}
                      onChange={(event) => set({ weekday: Number(event.target.value) })}
                      className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                      aria-label="Day"
                      data-testid="automation-weekday"
                    >
                      {WEEKDAY_NAMES.map((day, index) => (
                        <option key={day} value={index}>
                          {day}
                        </option>
                      ))}
                    </select>
                  </>
                ) : null}
                {draft.cadence === "days" ? (
                  <div className="flex w-full flex-wrap gap-1" data-testid="automation-days">
                    {DAY_CHIPS.map((item) => {
                      const on = draft.weekdays.includes(item.day);
                      return (
                        <Chip
                          key={item.day}
                          on={on}
                          onClick={() =>
                            set({
                              weekdays: on
                                ? draft.weekdays.filter((d) => d !== item.day)
                                : [...draft.weekdays, item.day],
                            })
                          }
                          testId={`automation-day-${item.day}`}
                        >
                          {item.label}
                        </Chip>
                      );
                    })}
                  </div>
                ) : null}
                {draft.cadence === "every" ? (
                  <select
                    value={draft.everyMinutes}
                    onChange={(event) => set({ everyMinutes: Number(event.target.value) })}
                    className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                    aria-label="How often"
                    data-testid="automation-every"
                  >
                    {AUTOMATION_EVERY_MINUTES.map((minutes) => (
                      <option key={minutes} value={minutes}>
                        {everyLabel(minutes).replace(/^Every /, "every ")}
                      </option>
                    ))}
                  </select>
                ) : null}
                {draft.cadence === "every" && draft.everyMinutes < 60 ? null : draft.cadence ===
                    "hourly" || draft.cadence === "every" ? (
                  <>
                    <span className="text-muted-foreground">at minute</span>
                    <select
                      value={draft.time.split(":")[1] ?? "00"}
                      onChange={(event) =>
                        set({ time: `${draft.time.split(":")[0] ?? "09"}:${event.target.value}` })
                      }
                      className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                      aria-label="Minute"
                      data-testid="automation-minute"
                    >
                      {MINUTES.map((minute) => (
                        <option key={minute} value={minute}>
                          :{minute}
                        </option>
                      ))}
                    </select>
                  </>
                ) : (
                  <>
                    <span className="text-muted-foreground">at</span>
                    <input
                      type="time"
                      value={draft.time}
                      onChange={(event) => set({ time: event.target.value || "09:00" })}
                      className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                      aria-label="Time"
                      data-testid="automation-time"
                    />
                  </>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground" data-testid="automation-timezone">
                Your time · {timezone} · its computer wakes for it
              </p>
            </div>
          ) : (
            <div className="mt-3 flex flex-col gap-1.5">
              <SourceRow
                on={draft.source === "github"}
                icon={<GitPullRequestIcon className="size-4" />}
                title="GitHub: a pull request opens or updates"
                hint="In one repository. Drafts wait until they're ready for review."
                onClick={() => set({ source: "github" as EventSource })}
                testId="automation-source-github"
              />
              {draft.source === "github" && environmentId !== null ? (
                <div className="pl-1">
                  <RepoPicker
                    environmentId={environmentId}
                    value={draft.repo}
                    onChange={(repo) => set({ repo })}
                  />
                </div>
              ) : null}
              {inChat ? null : (
                <SourceRow
                  on={draft.source === "call"}
                  icon={<VideoIcon className="size-4" />}
                  title="After a call"
                  hint="When the notes of a call it joined come in."
                  onClick={() => set({ source: "call" })}
                  testId="automation-source-call"
                />
              )}
              {draft.source === "call" && choice ? (
                <CallsHint
                  environmentId={choice.environmentId}
                  projectId={choice.projectId}
                  name={choice.name}
                />
              ) : null}
              {hooksOn ? (
                <>
                  <SourceRow
                    on={draft.source === "webhook"}
                    icon={<WebhookIcon className="size-4" />}
                    title="A webhook"
                    hint="Another service calls a secret URL. It goes to one chat."
                    onClick={() => set({ source: "webhook" })}
                    testId="automation-source-webhook"
                  />
                  <SourceRow
                    on={formEvent}
                    icon={<FileTextIcon className="size-4" />}
                    title="A form on your site"
                    hint="Someone sends the form. It goes to one chat."
                    onClick={() => set({ source: "form" })}
                    testId="automation-source-form"
                  />
                  {outsideEvent ? (
                    <div className="flex flex-col gap-1.5 pl-1">
                      {formEvent ? (
                        <Input
                          value={draft.slug}
                          onChange={(event) => set({ slug: event.target.value })}
                          disabled={editing !== null}
                          placeholder="Site name, e.g. report"
                          aria-label="Site"
                          autoComplete="off"
                          spellCheck={false}
                          data-testid="automation-site"
                        />
                      ) : null}
                      {!editing && !props.chat ? (
                        <select
                          value={pickedChatKey}
                          onChange={(event) => {
                            setPickedChatKey(event.target.value);
                            setWho(THIS_CHAT);
                            setFailure(null);
                          }}
                          className="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm"
                          aria-label="Chat"
                          data-testid="automation-chat-pick"
                        >
                          <option value="">Pick a chat…</option>
                          {chatChoices.map((item) => (
                            <option
                              key={`${item.environmentId}:${item.threadId}`}
                              value={`${item.environmentId}:${item.threadId}`}
                            >
                              {item.title} · {item.computer}
                            </option>
                          ))}
                        </select>
                      ) : null}
                    </div>
                  ) : null}
                  {outsideEvent && inChat ? (
                    <label
                      className="flex cursor-pointer items-start gap-2 pl-1 text-xs text-muted-foreground"
                      data-testid="automation-ask"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={draft.ask}
                        onChange={(event) => set({ ask: event.target.checked })}
                        data-testid="automation-ask-toggle"
                      />
                      <span>
                        <span className="text-foreground">Ask me first</span> — the text comes from
                        outside, so the agent changes nothing without your Allow.
                      </span>
                    </label>
                  ) : null}
                  {draft.when === "event" && draft.source === "webhook" ? (
                    <label
                      className="flex cursor-pointer items-start gap-2 pl-1 text-xs text-muted-foreground"
                      data-testid="automation-signature"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={draft.requireSignature}
                        onChange={(event) => set({ requireSignature: event.target.checked })}
                        data-testid="automation-signature-toggle"
                      />
                      <span>
                        <span className="text-foreground">Require a signature</span> — requests
                        without it are refused. GitHub signs its webhooks this way.
                      </span>
                    </label>
                  ) : null}
                </>
              ) : null}
              <SourceRow
                on={draft.source === "gmail"}
                icon={<MailIcon className="size-4" />}
                title="Gmail: a new email from…"
                hint="Coming soon."
                soon
                onClick={() => undefined}
                testId="automation-source-gmail"
              />
            </div>
          )}
        </div>

        <div>
          <Label>What to do</Label>
          <Textarea
            value={draft.instruction}
            onChange={(event) =>
              set({ instruction: event.target.value.slice(0, AUTOMATION_INSTRUCTION_MAX_CHARS) })
            }
            placeholder={
              draft.when === "event" && draft.source === "github"
                ? "Review the PR and leave a comment"
                : "Sum up my day"
            }
            aria-label="What to do"
            data-testid="automation-instruction"
          />
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {suggestionsFor(draft.when, draft.source).map((text) => (
              <button
                key={text}
                type="button"
                onClick={() => set({ instruction: text })}
                className="cursor-pointer rounded-full border border-dashed border-input px-2 py-0.5 text-xs text-muted-foreground hover:border-solid hover:bg-accent hover:text-foreground"
                data-testid="automation-suggestion"
              >
                {text}
              </button>
            ))}
          </div>
        </div>

        <div>
          <Label>Name</Label>
          <Input
            value={nameTouched ? draft.name : name}
            onChange={(event) => {
              setNameTouched(true);
              set({ name: event.target.value.slice(0, AUTOMATION_NAME_MAX_CHARS) });
            }}
            aria-label="Name"
            data-testid="automation-name-input"
          />
        </div>

        {inChat ? (
          <p
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            data-testid="automation-mode-line"
          >
            <MessageSquareIcon className="size-3.5 text-amber-500" />
            {outsideEvent
              ? askLine(draft.ask)
              : who === THIS_CHAT
                ? "Runs in this chat, with what it already knows, in the chat's own mode"
                : "Opens a new chat in the project each time, set up like this one"}
          </p>
        ) : choice && !outsideEvent ? (
          <p
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            data-testid="automation-mode-line"
          >
            {choice.asksFirst ? (
              <HandIcon className="size-3.5 text-amber-500" />
            ) : (
              <ZapIcon className="size-3.5 text-amber-500" />
            )}
            {modeLine(choice.name, choice.asksFirst, kind)}
          </p>
        ) : null}

        {failure ? (
          <div
            className="flex flex-wrap items-center gap-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
            data-testid="automation-dialog-error"
            data-code={failure.code}
          >
            <span className="min-w-0 flex-1">{failure.message}</span>
            {failure.manageUrl ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => openExternalUrl(failure.manageUrl!)}
                data-testid="automation-dialog-error-fix"
              >
                {failure.code === "GITHUB_PR_PERMISSION_MISSING"
                  ? "Review on GitHub"
                  : "Add it on GitHub"}
                <ArrowUpRightIcon className="size-3" />
              </Button>
            ) : failure.code === "GITHUB_NOT_CONNECTED" ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  failure.connectUrl
                    ? openExternalUrl(failure.connectUrl)
                    : void navigate({ to: "/settings/connectors" })
                }
                data-testid="automation-dialog-error-fix"
              >
                Connect GitHub
              </Button>
            ) : null}
          </div>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button size="sm" variant="ghost" onClick={props.onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={saving || problem !== null || (!choice && !executor)}
          title={problem ?? undefined}
          onClick={() => void save()}
          data-testid="automation-save"
        >
          {saving ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}
          {editing ? "Save" : "Create"}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}

function triggerLabel(saved: Automation, fallback: ReturnType<typeof triggerOf>): string {
  const trigger = saved?.trigger ?? fallback;
  switch (trigger.kind) {
    case "schedule":
      return trigger.label;
    case "github.pull_request":
      return `every pull request in ${trigger.repo}`;
    case "call.ended":
      return "after each call";
    case "gmail.message":
      return "on new email";
    case "webhook":
      return "when its webhook is called";
    case "site.form":
      return `when someone sends the form on ${trigger.slug}`;
  }
}
