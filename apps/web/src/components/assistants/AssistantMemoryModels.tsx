/**
 * "Memory & models" on the assistant page (assistants MVP, 0.0.106; spec
 * reports/day_2026-10-02/assistants/spec-projects/SPEC-memory-models.md):
 *
 * - Memory — NOTES.md as editable lines, USER.md and SOUL.md as text, the
 *   dispatcher's AGENTS.md under Advanced;
 * - Models — ROUTING.md as a table "kind of task → model, thinking";
 * - Chats it started — model, status, tokens, cost per chat;
 * - Computers it can use — the place for cross-machine chats (Soon).
 *
 * Files live on the assistant's computer: the blocks need it awake. Every
 * save sends the content it started from (`base`), so a line the assistant
 * wrote meanwhile is kept, not overwritten.
 */
import {
  ASSISTANT_PROJECT_ID,
  type AssistantChatSummary,
  type AssistantEditableFileName,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  addNote,
  editNote,
  parseNotes,
  parseRouting,
  removeLine,
  ROUTING_SELF_HARNESS,
  ROUTING_THINKING,
  thinkingOf,
  writeRouting,
  type RoutingRule,
  type RoutingThinking,
} from "@t3tools/shared/assistantMemory";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LoaderCircleIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { waitForThreadInStore } from "../../assistant/useAssistantChat";
import { useEnvironmentProviders } from "../../environments/settings/serverSettings";
import { useMachineRows } from "../../hooks/useMachineRows";
import { listAssistantChats, readAssistantFile, writeAssistantFile } from "../../lib/managerApi";
import { cn } from "../../lib/utils";
import { useStore } from "../../store";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Block } from "./AssistantBits";
import {
  chatCostText,
  choiceValue,
  formatTokens,
  formatUsd,
  modelChoices,
  weekTotals,
  type ModelChoice,
} from "./assistantMemoryModels.logic";

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** "2 Oct" for a `YYYY-MM-DD` date. */
function shortDate(date: string): string {
  const parsed = new Date(`${date}T12:00:00`);
  return Number.isNaN(parsed.getTime())
    ? date
    : parsed.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function SavedHint({ at }: { at: number }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (at === 0) return;
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [at]);
  return (
    <span
      aria-live="polite"
      className={cn(
        "text-xs text-success-foreground transition-opacity",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      Saved
    </span>
  );
}

/** One assistant file: its content, and a save that keeps crossing writes. */
function useAssistantFile(environmentId: EnvironmentId, name: AssistantEditableFileName) {
  const queryClient = useQueryClient();
  const key = ["uno-assistant-file", environmentId, name] as const;
  const file = useQuery({
    queryKey: key,
    retry: false,
    queryFn: () =>
      readAssistantFile({ environmentId, projectId: ASSISTANT_PROJECT_ID, name }).then(
        (result) => result.content,
      ),
  });
  const [savedAt, setSavedAt] = useState(0);
  const save = async (next: string, base: string) => {
    if (next === base) return;
    try {
      const result = await writeAssistantFile({
        environmentId,
        projectId: ASSISTANT_PROJECT_ID,
        name,
        content: next,
        base,
      });
      queryClient.setQueryData(key, result.content ?? next);
      setSavedAt(Date.now());
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Couldn't save",
        description: errorText(cause, "The assistant's computer didn't answer."),
      });
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };
  return { file, save, savedAt };
}

// ── Memory ───────────────────────────────────────────────────────────

type MemoryTab = "notes" | "user" | "soul";

export function MemoryBlock({
  name,
  environmentId,
  waking,
  onWake,
}: {
  name: string;
  environmentId: EnvironmentId | null;
  waking: boolean;
  onWake: () => void;
}) {
  if (!environmentId) {
    return (
      <Block title="Memory" testId="assistant-memory">
        <AsleepLine name={name} waking={waking} onWake={onWake} what="Its memory" />
      </Block>
    );
  }
  return <AwakeMemory name={name} environmentId={environmentId} />;
}

function AsleepLine({
  name,
  waking,
  onWake,
  what,
}: {
  name: string;
  waking: boolean;
  onWake: () => void;
  what: string;
}) {
  return (
    <div className="flex items-center gap-3 py-1">
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">
        {name} is asleep. {what} lives on its computer.
      </p>
      <Button size="xs" variant="outline" onClick={onWake} disabled={waking}>
        {waking ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}
        Wake to see it
      </Button>
    </div>
  );
}

function AwakeMemory({ name, environmentId }: { name: string; environmentId: EnvironmentId }) {
  const [tab, setTab] = useState<MemoryTab>("notes");
  const notes = useAssistantFile(environmentId, "NOTES.md");
  const user = useAssistantFile(environmentId, "USER.md");
  const soul = useAssistantFile(environmentId, "SOUL.md");
  const agents = useAssistantFile(environmentId, "AGENTS.md");
  const savedAt = Math.max(notes.savedAt, user.savedAt, soul.savedAt, agents.savedAt);

  return (
    <Block title="Memory" action={<SavedHint at={savedAt} />} testId="assistant-memory">
      <p className="pb-2 text-sm text-muted-foreground">
        What {name} knows in every chat, including the chats it starts.
      </p>
      <div
        role="tablist"
        className="mb-3 inline-flex rounded-lg border border-border bg-muted/40 p-0.5"
      >
        {(
          [
            ["notes", `What ${name} remembers`],
            ["user", "About you"],
            ["soul", `Who ${name} is`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              "cursor-pointer rounded-md px-2.5 py-1 text-xs transition-colors",
              tab === id
                ? "bg-background font-medium text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
            data-testid={`assistant-memory-tab-${id}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "notes" ? (
        <NotesList name={name} file={notes} />
      ) : tab === "user" ? (
        <TextFile
          file={user}
          placeholder="Who you are, how you like answers, what matters to you."
          testId="assistant-memory-user"
        />
      ) : (
        <TextFile
          file={soul}
          placeholder={`${name}'s job and its rules, in your words.`}
          testId="assistant-memory-soul"
        />
      )}
      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          Advanced: system instructions (AGENTS.md)
        </summary>
        <p className="pt-2 pb-1 text-xs text-muted-foreground">
          Written by Uno for every assistant. Your own rules fit better in “Who {name} is”: Uno
          won't touch them there.
        </p>
        <TextFile file={agents} placeholder="" testId="assistant-memory-agents" rows={12} mono />
      </details>
    </Block>
  );
}

type AssistantFile = ReturnType<typeof useAssistantFile>;

function NotesList({ name, file }: { name: string; file: AssistantFile }) {
  const [draft, setDraft] = useState("");
  const content = file.file.data ?? "";
  const notes = useMemo(() => parseNotes(content), [content]);
  if (file.file.isLoading) return <p className="py-1 text-sm text-muted-foreground">Loading…</p>;
  if (file.file.isError) {
    return (
      <p className="py-1 text-sm text-muted-foreground">
        Couldn't read the notes: {errorText(file.file.error, "the computer didn't answer.")}
      </p>
    );
  }
  const remember = () => {
    const text = draft.trim();
    if (text.length === 0) return;
    setDraft("");
    void file.save(addNote(content, text, today()), content);
  };
  return (
    <div data-testid="assistant-memory-notes">
      {notes.length === 0 ? (
        <p className="py-1 text-sm text-muted-foreground">Nothing yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border/50">
          {notes.map((note) => (
            <li key={`${note.line}-${note.text}`} className="group flex items-start gap-2 py-1.5">
              <span
                contentEditable
                suppressContentEditableWarning
                role="textbox"
                aria-label="Note"
                className="min-w-0 flex-1 rounded px-1 text-sm outline-none focus:bg-muted/60"
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                }}
                onBlur={(event) => {
                  const text = event.currentTarget.textContent ?? "";
                  if (text.trim() === note.text) return;
                  void file.save(editNote(content, note.line, text, today()), content);
                }}
              >
                {note.text}
              </span>
              <span className="shrink-0 pt-0.5 text-xs whitespace-nowrap text-muted-foreground">
                {note.fromPerson ? "You told me" : name}
                {note.date ? ` · ${shortDate(note.date)}` : ""}
              </span>
              <button
                type="button"
                aria-label="Forget this"
                title="Forget this"
                onClick={() => void file.save(removeLine(content, note.line), content)}
                className="cursor-pointer rounded p-0.5 text-muted-foreground opacity-60 hover:bg-accent hover:text-foreground group-hover:opacity-100"
              >
                <XIcon className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-2 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          remember();
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Remember something…"
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-ring"
          data-testid="assistant-memory-add"
        />
        <Button size="sm" variant="outline" type="submit" disabled={draft.trim().length === 0}>
          Remember
        </Button>
      </form>
      <p className="pt-1.5 text-xs text-muted-foreground">
        Or say “remember that…” in any chat with {name}.
      </p>
    </div>
  );
}

function TextFile({
  file,
  placeholder,
  testId,
  rows = 6,
  mono = false,
}: {
  file: AssistantFile;
  placeholder: string;
  testId: string;
  rows?: number;
  mono?: boolean;
}) {
  const content = file.file.data;
  const [text, setText] = useState<string | null>(null);
  // A fresh read replaces the local text only when nothing is being typed.
  const [base, setBase] = useState<string | null>(null);
  useEffect(() => {
    if (content !== undefined && (text === null || text === base)) {
      setText(content);
      setBase(content);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);
  if (file.file.isLoading || text === null || base === null) {
    return <p className="py-1 text-sm text-muted-foreground">Loading…</p>;
  }
  return (
    <textarea
      value={text}
      rows={rows}
      placeholder={placeholder}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        if (text === base) return;
        const sent = text;
        void file.save(sent, base).then(() => setBase(sent));
      }}
      className={cn(
        "w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm leading-relaxed outline-none focus:border-ring",
        mono && "font-mono text-xs",
      )}
      data-testid={testId}
    />
  );
}

// ── Models ───────────────────────────────────────────────────────────

const SOURCE_LABEL: Record<RoutingRule["source"], string> = {
  you: "You set",
  learned: "Learned",
  default: "Starting point",
};

export function ModelsBlock({
  name,
  environmentId,
  waking,
  onWake,
}: {
  name: string;
  environmentId: EnvironmentId | null;
  waking: boolean;
  onWake: () => void;
}) {
  if (!environmentId) {
    return (
      <Block title="Models" testId="assistant-models">
        <AsleepLine name={name} waking={waking} onWake={onWake} what="Its model table" />
      </Block>
    );
  }
  return <AwakeModels name={name} environmentId={environmentId} />;
}

function AwakeModels({ name, environmentId }: { name: string; environmentId: EnvironmentId }) {
  const routing = useAssistantFile(environmentId, "ROUTING.md");
  const providers = useEnvironmentProviders(environmentId);
  const choices = useMemo(() => modelChoices(providers, name), [providers, name]);
  const [newTask, setNewTask] = useState("");
  const content = routing.file.data ?? "";
  const parsed = useMemo(() => parseRouting(content), [content]);

  const saveRules = (rules: ReadonlyArray<RoutingRule>) =>
    void routing.save(writeRouting(content, rules), content);
  const updateRule = (index: number, patch: Partial<RoutingRule>) =>
    saveRules(
      parsed.rules.map((rule, at) => (at === index ? { ...rule, ...patch, source: "you" } : rule)),
    );

  const body = routing.file.isLoading ? (
    <p className="py-1 text-sm text-muted-foreground">Loading…</p>
  ) : routing.file.isError ? (
    <p className="py-1 text-sm text-muted-foreground">
      Couldn't read the table: {errorText(routing.file.error, "the computer didn't answer.")}
    </p>
  ) : (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="assistant-models-table">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-1.5 pr-2 font-normal">Kind of task</th>
              <th className="py-1.5 pr-2 font-normal">Model</th>
              <th className="py-1.5 pr-2 font-normal">Thinking</th>
              <th className="py-1.5 font-normal" />
              <th className="w-6" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {parsed.rules.map((rule, index) => (
              <RuleRow
                key={`${rule.taskType}|${rule.harness}|${rule.model}`}
                rule={rule}
                choices={choices}
                onChange={(patch) => updateRule(index, patch)}
                onRemove={() => saveRules(parsed.rules.filter((_, at) => at !== index))}
              />
            ))}
          </tbody>
        </table>
      </div>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const taskType = newTask.trim();
          if (taskType.length === 0) return;
          setNewTask("");
          const first = choices.find((choice) => choice.reason === null && choice.model !== "");
          saveRules([
            ...parsed.rules,
            {
              taskType,
              harness: first?.harness ?? ROUTING_SELF_HARNESS,
              model: first?.model ?? "",
              effort: "",
              source: "you",
              note: "",
            },
          ]);
        }}
      >
        <input
          value={newTask}
          onChange={(event) => setNewTask(event.target.value)}
          placeholder="New kind of task, e.g. Emails to clients"
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-ring"
          data-testid="assistant-models-add"
        />
        <Button size="sm" variant="outline" type="submit" disabled={newTask.trim().length === 0}>
          Add
        </Button>
      </form>
      <p className="pt-1.5 text-xs text-muted-foreground">
        Or tell {name} in chat: “remember: UI — Opus, high”. Rows you set stay as you set them.
      </p>
      {parsed.outcomes.length > 0 ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            What happened last time ({parsed.outcomes.length})
          </summary>
          <ul className="mt-1.5 flex flex-col gap-0.5 pl-1 text-xs text-muted-foreground">
            {parsed.outcomes
              .slice(-10)
              .toReversed()
              .map((outcome) => (
                <li key={outcome.text}>{outcome.text}</li>
              ))}
          </ul>
        </details>
      ) : null}
    </>
  );

  return (
    <Block title="Models" action={<SavedHint at={routing.savedAt} />} testId="assistant-models">
      <p className="pb-2 text-sm text-muted-foreground">
        Which AI {name} uses for which task. {name} tunes the rows you didn't set when a cheaper
        model keeps doing the job.
      </p>
      {body}
    </Block>
  );
}

function RuleRow({
  rule,
  choices,
  onChange,
  onRemove,
}: {
  rule: RoutingRule;
  choices: ReadonlyArray<ModelChoice>;
  onChange: (patch: Partial<RoutingRule>) => void;
  onRemove: () => void;
}) {
  const value = choiceValue(rule);
  const current = choices.find((choice) => choice.value === value) ?? null;
  const thinking = thinkingOf(rule.effort);
  const canThink = current
    ? current.driver === "claudeAgent" || current.driver === "codex"
    : rule.harness === "claudeAgent" || rule.harness === "codex";
  return (
    <tr className="align-middle">
      <td className="py-1.5 pr-2">
        <input
          defaultValue={rule.taskType}
          aria-label="Kind of task"
          className="w-full min-w-32 rounded bg-transparent px-1 py-0.5 outline-none focus:bg-muted/60"
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          onBlur={(event) => {
            const taskType = event.currentTarget.value.trim();
            if (taskType.length > 0 && taskType !== rule.taskType) onChange({ taskType });
          }}
        />
      </td>
      <td className="py-1.5 pr-2">
        <select
          value={value}
          aria-label="Model"
          className="max-w-56 rounded-md border border-border bg-background px-1.5 py-1 text-xs"
          onChange={(event) => {
            const next = choices.find((choice) => choice.value === event.target.value);
            if (!next) return;
            onChange({
              harness: next.harness,
              model: next.model,
              effort: next.harness === ROUTING_SELF_HARNESS ? "" : rule.effort,
            });
          }}
        >
          {current ? null : (
            <option value={value}>{rule.model || rule.harness} (not on this computer)</option>
          )}
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value} disabled={choice.reason !== null}>
              {choice.label}
              {choice.reason ? ` — ${choice.reason}` : ""}
            </option>
          ))}
        </select>
      </td>
      <td className="py-1.5 pr-2">
        {canThink ? (
          <select
            value={thinking ?? ""}
            aria-label="Thinking"
            className="rounded-md border border-border bg-background px-1.5 py-1 text-xs"
            onChange={(event) =>
              onChange({ effort: (event.target.value as RoutingThinking | "") || "" })
            }
          >
            <option value="">default</option>
            {ROUTING_THINKING.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
      <td className="py-1.5 pr-1">
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px] whitespace-nowrap",
            rule.source === "you"
              ? "bg-primary/10 text-primary"
              : rule.source === "learned"
                ? "bg-success/12 text-success-foreground"
                : "bg-muted text-muted-foreground",
          )}
        >
          {SOURCE_LABEL[rule.source]}
        </span>
      </td>
      <td className="py-1.5">
        <button
          type="button"
          aria-label="Remove this rule"
          title="Remove this rule"
          onClick={onRemove}
          className="cursor-pointer rounded p-0.5 text-muted-foreground opacity-60 hover:bg-accent hover:text-foreground hover:opacity-100"
        >
          <XIcon className="size-3.5" />
        </button>
      </td>
    </tr>
  );
}

// ── Chats it started ─────────────────────────────────────────────────

const CHAT_STATUS: Record<AssistantChatSummary["status"], { label: string; tone: string }> = {
  working: { label: "Working", tone: "text-primary" },
  waiting: { label: "Waiting for you", tone: "text-warning-foreground" },
  done: { label: "Done", tone: "text-success-foreground" },
  failed: { label: "Failed", tone: "text-destructive" },
};

/**
 * Tokens and price of each chat (decision 02.10: keep the code, hide it in
 * the UI for now). Flip to true to bring back the Tokens/Cost columns and the
 * "This week" line; the daemon and the console keep counting either way.
 */
export const SHOW_CHAT_COST = false;

export function ChatsBlock({
  name,
  environmentId,
  waking,
  onWake,
}: {
  name: string;
  environmentId: EnvironmentId | null;
  waking: boolean;
  onWake: () => void;
}) {
  const navigate = useNavigate();
  const setActiveEnvironmentId = useStore((state) => state.setActiveEnvironmentId);
  const chats = useQuery({
    queryKey: ["uno-assistant-chats", environmentId],
    enabled: environmentId !== null,
    retry: false,
    refetchInterval: 20_000,
    queryFn: () => listAssistantChats({ environmentId: environmentId! }),
  });

  const open = async (threadId: AssistantChatSummary["threadId"]) => {
    if (!environmentId) return;
    setActiveEnvironmentId(environmentId);
    await waitForThreadInStore(environmentId, threadId, 5_000);
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({ environmentId, threadId }),
    });
  };

  let body: ReactNode;
  if (!environmentId) {
    body = <AsleepLine name={name} waking={waking} onWake={onWake} what="Its chat list" />;
  } else if (chats.isLoading) {
    body = <p className="py-1 text-sm text-muted-foreground">Loading…</p>;
  } else if (chats.isError) {
    body = (
      <p className="py-1 text-sm text-muted-foreground">
        This list needs Uno Work 0.0.106 on {name}'s computer. Update it from Settings.
      </p>
    );
  } else if ((chats.data?.chats.length ?? 0) === 0) {
    body = (
      <p className="py-1 text-sm text-muted-foreground">
        No chats yet. When {name} hands a task to another AI, it shows up here.
      </p>
    );
  } else {
    const data = chats.data!;
    const totals = SHOW_CHAT_COST ? weekTotals(data.chats, Date.now()) : null;
    body = (
      <>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="assistant-chats-table">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1.5 pr-2 font-normal">Chat</th>
                <th className="py-1.5 pr-2 font-normal">Where</th>
                <th className="py-1.5 pr-2 font-normal">Model</th>
                <th className="py-1.5 pr-2 font-normal">Status</th>
                {SHOW_CHAT_COST ? (
                  <>
                    <th className="py-1.5 pr-2 text-right font-normal">Tokens</th>
                    <th className="py-1.5 text-right font-normal">Cost</th>
                  </>
                ) : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {data.chats.map((chat) => (
                <tr key={chat.threadId}>
                  <td className="max-w-56 py-1.5 pr-2">
                    <button
                      type="button"
                      className="block w-full cursor-pointer truncate text-left font-medium hover:underline"
                      onClick={() => void open(chat.threadId)}
                    >
                      {chat.title}
                    </button>
                  </td>
                  <td className="py-1.5 pr-2 text-xs whitespace-nowrap text-muted-foreground">
                    {name}'s computer{chat.projectTitle ? ` · ${chat.projectTitle}` : ""}
                  </td>
                  <td className="py-1.5 pr-2 text-xs whitespace-nowrap">
                    {chat.harness} · {chat.model}
                    {chat.effort ? ` · ${chat.effort}` : ""}
                  </td>
                  <td
                    className={cn(
                      "py-1.5 pr-2 text-xs whitespace-nowrap",
                      CHAT_STATUS[chat.status].tone,
                    )}
                  >
                    {CHAT_STATUS[chat.status].label}
                  </td>
                  {SHOW_CHAT_COST ? (
                    <>
                      <td className="py-1.5 pr-2 text-right text-xs tabular-nums">
                        {formatTokens(chat.tokens)}
                      </td>
                      <td className="py-1.5 text-right text-xs whitespace-nowrap tabular-nums">
                        {chatCostText(chat, data.gateway)}
                      </td>
                    </>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {totals ? (
          <p className="pt-2 text-xs text-muted-foreground">
            This week: {totals.count} chats · {formatUsd(totals.usd)} from your balance
            {totals.aiHoursChats > 0 ? ` · ${totals.aiHoursChats} in AI hours` : ""}
            {totals.planChats > 0 ? ` · ${totals.planChats} in your plan` : ""}
          </p>
        ) : null}
        {SHOW_CHAT_COST && data.gateway === "unavailable" ? (
          <p className="pt-1 text-xs text-muted-foreground">
            Prices of Uno AI chats aren't on for your account yet. Billing shows the computer's
            total.
          </p>
        ) : null}
      </>
    );
  }

  return (
    <Block title={`Chats ${name} started`} testId="assistant-chats">
      <p className="pb-2 text-sm text-muted-foreground">
        Each task runs as its own chat. Open one to step in: {name} sees what you write.
      </p>
      {body}
    </Block>
  );
}

// ── Computers (Soon) ─────────────────────────────────────────────────

export function ComputersBlock({ name, boxId }: { name: string; boxId: number }) {
  const rows = useMachineRows();
  const others = rows.filter((row) => row.box?.id !== boxId);
  return (
    <Block
      title={`Computers ${name} can use`}
      action={
        <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
          Soon
        </span>
      }
      testId="assistant-computers"
    >
      <p className="pb-1 text-sm text-muted-foreground">
        A chat runs where its project lives. Only you can allow a computer, and Uno checks it on
        every chat.
      </p>
      <ul className="flex flex-col divide-y divide-border/50">
        <li className="flex items-center gap-3 py-2 text-sm">
          <span className="min-w-0 flex-1">{name}'s computer</span>
          <span className="text-xs text-muted-foreground">Always</span>
        </li>
        {others.map((row) => (
          <li key={row.key} className="flex items-center gap-3 py-2 text-sm">
            <span className="min-w-0 flex-1">
              <span className="block truncate">{row.label}</span>
              {row.projects.length > 0 ? (
                <span className="block truncate text-xs text-muted-foreground">
                  {row.projects.slice(0, 3).join(", ")}
                </span>
              ) : null}
            </span>
            <span className="text-xs text-muted-foreground">Off</span>
          </li>
        ))}
      </ul>
      <p className="pt-1 text-xs text-muted-foreground">
        For now {name} starts chats only on its own computer. If a bad email tricks {name}, the
        damage stays on the computers you allow here.
      </p>
    </Block>
  );
}
