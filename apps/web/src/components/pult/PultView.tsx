/**
 * Pult — the owner's board of agent work, inside Uno Work. Three levels:
 * 1) a glance: one line "where you are needed and how many minutes", the
 *    questions with answer buttons, and tasks as name · dot · progress · where;
 * 2) a task: what it needs from you, link + password, prod/stage, what is left;
 * 3) details on request: the original ask, docs, chats, stages, feed, priority.
 * A click on a task opens its chat in the middle (the real chat of Work); the
 * Pult stays on the right. Lives as a tab of the right panel or as a screen.
 */
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  FileTextIcon,
  GitBranchIcon,
  GlobeIcon,
  GripVerticalIcon,
  ImageIcon,
  LinkIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import {
  CHAT_STATE,
  DISPATCH_SUGGEST,
  TASK_STATUS,
  dayTime,
  dispatch,
  glanceLine,
  groupTasks,
  hasOpenNeed,
  indexPult,
  leftActions,
  machineWord,
  openNeeds,
  openableArtifacts,
  ownerChatId,
  relTime,
  whereWord,
  type PultAct,
  type PultAnswer,
  type PultCard,
  type PultIndex,
  type PultTone,
  type PultView as PultScreen,
} from "~/pult/pult.logic";
import type { PultArtifact, PultTask } from "~/pult/pult.types";
import { sendToThread, threadRouteParams } from "~/pult/pultBridge";
import { effectiveTasks, usePultStore } from "~/pult/pultStore";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { makePultFile, usePreviewPane } from "../preview/PreviewPaneContext";
import { useHomeLaunchers } from "../computer/useHomeLaunchers";

export type PultLayout = "panel" | "center";

const TONE_DOT: Record<PultTone, string> = {
  amber: "bg-amber-500",
  red: "bg-red-500",
  blue: "bg-blue-500",
  violet: "bg-violet-500",
  grey: "bg-muted-foreground/40",
  green: "bg-emerald-500",
};

const SCREENS: ReadonlyArray<{ readonly id: PultScreen; readonly label: string }> = [
  { id: "board", label: "Задачи" },
  { id: "releases", label: "Выкатки" },
  { id: "wishes", label: "Мои просьбы" },
  { id: "limits", label: "Лимиты" },
  { id: "alerts", label: "Алерты" },
  { id: "decisions", label: "Решения" },
];

/* ───────── Data ───────── */

function usePult() {
  const data = usePultStore((s) => s.data);
  const answers = usePultStore((s) => s.answers);
  const order = usePultStore((s) => s.order);
  const priority = usePultStore((s) => s.priority);
  return useMemo(() => {
    if (!data) return null;
    const tasks = effectiveTasks({ data, answers, order, priority });
    // An answered chat goes back to work.
    const answeredChats = new Set(Object.keys(answers).map((id) => data.tasks.find((t) => t.id === id)?.owner));
    const chats = data.chats.map((c) => (answeredChats.has(c.id) && c.state === "needs_you" ? { ...c, state: "working" as const } : c));
    const ix = indexPult({ ...data, tasks, chats });
    return { ix, tasks, answers, original: indexPult(data) };
  }, [data, answers, order, priority]);
}

/** Open a task: its chat in the middle, the Pult on the right with this task. */
function useOpenTask(layout: PultLayout) {
  const navigate = useNavigate();
  const pane = usePreviewPane();
  const openTaskInStore = usePultStore((s) => s.openTask);
  return useCallback(
    (task: PultTask, ix: PultIndex, chatId?: string) => {
      openTaskInStore(task.id);
      const chat = ix.chat(chatId ?? ownerChatId(task));
      if (!chat?.thread) return;
      const file = makePultFile();
      // The Pult tab is "everywhere": put it there first, then show it in the
      // chat we are going to.
      openPultTabIn(pane);
      if (layout === "center" || pane.currentChatThreadId !== chat.thread.threadId) {
        pane.queueAppTab(file, chat.thread.threadId);
      }
      void navigate({ to: "/$environmentId/$threadId", params: threadRouteParams(chat.thread) });
    },
    [layout, navigate, openTaskInStore, pane],
  );
}

function useOpenChat() {
  const navigate = useNavigate();
  return useCallback(
    (ix: PultIndex, chatId: string | null | undefined) => {
      const chat = ix.chat(chatId);
      if (chat?.thread) void navigate({ to: "/$environmentId/$threadId", params: threadRouteParams(chat.thread) });
    },
    [navigate],
  );
}

/** Answer a request of a task: mark it here and write the answer into its chat. */
function useAnswer() {
  const answer = usePultStore((s) => s.answer);
  return useCallback(
    (task: PultTask, ix: PultIndex, label: string) => {
      answer(task.id, label);
      const chat = ix.chat(ownerChatId(task));
      if (chat?.thread) {
        const text = task.needs?.kind === "do" ? `(Пульт) Готово: ${task.needs.title}` : `(Пульт) Выбрал: ${label}`;
        void sendToThread(chat.thread, text);
      }
      toastManager.add({ type: "success", title: chat ? `Ответ ушёл в «${chat.title}»` : "Отмечено" });
    },
    [answer],
  );
}

/* ───────── Small pieces ───────── */

function Dot({ tone, pulse }: { tone: PultTone; pulse?: boolean }) {
  return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tone], pulse && "animate-pulse")} />;
}

function Bar({ value }: { value: number }) {
  return (
    <span className="h-1 w-10 shrink-0 overflow-hidden rounded-full bg-muted" title={`${value}%`}>
      <span className="block h-full rounded-full bg-foreground/45" style={{ width: `${Math.max(4, value)}%` }} />
    </span>
  );
}

function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-2 pt-4 pb-1 text-xs font-medium text-muted-foreground">
      <span>{children}</span>
      {right ? <span className="ml-auto font-normal">{right}</span> : null}
    </div>
  );
}

/** `**bold**` inside a short answer. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
        part.startsWith("**") ? (
          <strong key={i} className="font-semibold">
            {part.slice(2, -2)}
          </strong>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function copy(text: string, what: string) {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
  toastManager.add({ type: "success", title: `${what} скопирован` });
}

/* ───────── Level 1: the board ───────── */

function NeedRow({ task, ix, onOpen }: { task: PultTask; ix: PultIndex; onOpen: () => void }) {
  const answerTask = useAnswer();
  const need = task.needs;
  if (!need) return null;
  const options = need.options ?? [];
  return (
    <div className="rounded-lg px-2 py-2 hover:bg-accent/40" data-testid={`pult-need-${task.id}`}>
      <button type="button" onClick={onOpen} className="block w-full cursor-pointer text-left text-sm font-medium leading-snug">
        {need.title}
      </button>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {options.length > 0 ? (
          options.map((option) => (
            <Button
              key={option.label}
              size="xs"
              variant={option.recommended ? "default" : "outline"}
              title={option.hint}
              onClick={() => answerTask(task, ix, option.label)}
            >
              {option.label}
            </Button>
          ))
        ) : (
          <>
            <Button size="xs" variant="default" onClick={() => answerTask(task, ix, "Готово")}>
              Готово
            </Button>
            <Button size="xs" variant="ghost" onClick={onOpen}>
              Как сделать
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function AnsweredRow({ title, label, onUndo }: { title: string; label: string; onUndo: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted-foreground">
      <CheckIcon className="size-3.5 shrink-0 text-emerald-600" />
      <span className="min-w-0 flex-1 truncate">
        {title} — <span className="text-foreground">{label}</span>
      </span>
      <button type="button" onClick={onUndo} className="shrink-0 cursor-pointer text-xs hover:text-foreground">
        Отменить
      </button>
    </div>
  );
}

function TaskRow({
  task,
  ix,
  onOpen,
  onDropBefore,
}: {
  task: PultTask;
  ix: PultIndex;
  onOpen: () => void;
  onDropBefore: (draggedId: string) => void;
}) {
  const chat = ix.chat(ownerChatId(task));
  const live = chat ? CHAT_STATE[chat.state] : { tone: "grey" as const, label: "никто не делает" };
  const move = usePultStore((s) => s.move);
  const order = usePultStore((s) => s.order);
  const [over, setOver] = useState(false);
  const step = (dir: -1 | 1) => {
    const i = order.indexOf(task.id);
    const target = dir < 0 ? order[i - 1] : order[i + 2];
    move(task.id, target ?? null);
  };
  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/pult-task", task.id)}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer.getData("text/pult-task");
        if (id && id !== task.id) onDropBefore(id);
      }}
      className={cn("group/row relative flex items-center rounded-md hover:bg-accent/60", over && "shadow-[inset_0_2px_0_var(--color-primary)]")}
      data-testid={`pult-task-${task.id}`}
    >
      <GripVerticalIcon className="absolute -left-0.5 size-3 cursor-grab text-muted-foreground/0 group-hover/row:text-muted-foreground/60" />
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-2 py-1.5 text-left" title={`${chat?.title ?? "Без исполнителя"} · ${live.label}`}>
        <Dot tone={live.tone} pulse={chat?.state === "working"} />
        <span className="min-w-0 flex-1 truncate text-sm">{task.title}</span>
        <Bar value={task.progress} />
        <span className="w-[70px] shrink-0 truncate text-right text-xs text-muted-foreground">{whereWord(task, ix)}</span>
      </button>
      <Menu>
        <MenuTrigger
          aria-label="Порядок и приоритет"
          className="mr-1 grid size-6 shrink-0 cursor-pointer place-items-center rounded text-muted-foreground opacity-0 outline-hidden group-hover/row:opacity-100 hover:bg-accent data-[popup-open]:opacity-100 max-md:opacity-60"
        >
          <MoreHorizontalIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-44">
          <MenuItem onClick={() => step(-1)}>Выше</MenuItem>
          <MenuItem onClick={() => step(1)}>Ниже</MenuItem>
          <MenuItem onClick={() => move(task.id, order[0] ?? null)}>Наверх</MenuItem>
          <MenuSeparator />
          {(["P0", "P1", "P2", "P3"] as const).map((p) => (
            <MenuItem key={p} onClick={() => usePultStore.getState().setPriority(task.id, p)}>
              <span className="flex-1">Приоритет {p}</span>
              {task.priority === p ? <CheckIcon className="size-3.5" /> : null}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </div>
  );
}

function Board({ layout }: { layout: PultLayout }) {
  const pult = usePult();
  const openTask = useOpenTask(layout);
  const undo = usePultStore((s) => s.undoAnswer);
  const move = usePultStore((s) => s.move);
  const [allNeeds, setAllNeeds] = useState(false);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  if (!pult) return null;
  const { ix, tasks, answers, original } = pult;
  const needs = openNeeds(tasks);
  const shownNeeds = allNeeds ? needs : needs.slice(0, 4);
  const answered = Object.entries(answers)
    .toSorted((a, b) => b[1].at - a[1].at)
    .map(([id, mark]) => ({ task: original.task(id), mark }))
    .filter((x) => x.task?.needs);
  const groups = groupTasks(tasks);
  return (
    <div className="pb-6">
      {needs.length + answered.length > 0 ? (
        <>
          <SectionLabel>Нужен ты</SectionLabel>
          {shownNeeds.map((t) => (
            <NeedRow key={t.id} task={t} ix={ix} onOpen={() => openTask(t, ix)} />
          ))}
          {needs.length > shownNeeds.length ? (
            <button type="button" onClick={() => setAllNeeds(true)} className="cursor-pointer px-2 py-1 text-xs text-muted-foreground hover:text-foreground">
              Ещё {needs.length - shownNeeds.length}
            </button>
          ) : null}
          {answered.map(({ task, mark }) => (
            <AnsweredRow key={task!.id} title={task!.needs!.title} label={mark.label} onUndo={() => undo(task!.id)} />
          ))}
        </>
      ) : null}
      {groups
        .filter((g) => !g.folded)
        .map((g) => (
          <div key={g.id}>
            <SectionLabel right={g.tasks.length}>{g.label}</SectionLabel>
            {g.tasks.map((t) => (
              <TaskRow key={t.id} task={t} ix={ix} onOpen={() => openTask(t, ix)} onDropBefore={(id) => move(id, t.id)} />
            ))}
          </div>
        ))}
      <div className="mt-3 flex flex-col">
        {groups
          .filter((g) => g.folded)
          .map((g) => {
            const open = unfolded.has(g.id);
            return (
              <div key={g.id}>
                <button
                  type="button"
                  onClick={() => setUnfolded((s) => (open ? new Set([...s].filter((x) => x !== g.id)) : new Set([...s, g.id])))}
                  className="flex w-full cursor-pointer items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  {open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
                  {g.label} · {g.tasks.length}
                </button>
                {open
                  ? g.tasks.map((t) => (
                      <TaskRow key={t.id} task={t} ix={ix} onOpen={() => openTask(t, ix)} onDropBefore={(id) => move(id, t.id)} />
                    ))
                  : null}
              </div>
            );
          })}
      </div>
    </div>
  );
}

/* ───────── Level 2–3: one task ───────── */

function ArtifactRow({ artifact, onOpen }: { artifact: PultArtifact; onOpen: () => void }) {
  const Icon = artifact.kind === "site" ? GlobeIcon : artifact.kind === "branch" ? GitBranchIcon : artifact.kind === "file" ? FileTextIcon : artifact.kind === "screen" ? ImageIcon : LinkIcon;
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/60">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 cursor-pointer truncate text-left text-sm" title={artifact.url ?? artifact.path}>
        {artifact.title}
      </button>
      {artifact.password ? (
        <button
          type="button"
          onClick={() => copy(artifact.password!, "Пароль")}
          className="flex shrink-0 cursor-pointer items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
          title="Скопировать пароль страницы"
        >
          {artifact.password}
          <CopyIcon className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

function Details({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full cursor-pointer items-center gap-1 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground">
        {open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
        {title}
        {count ? <span className="text-muted-foreground/70">· {count}</span> : null}
      </button>
      {open ? <div className="pb-2 pl-6 pr-2 text-sm">{children}</div> : null}
    </div>
  );
}

function TaskCard({ task, layout }: { task: PultTask; layout: PultLayout }) {
  const pult = usePult();
  const pane = usePreviewPane();
  const openTaskInStore = usePultStore((s) => s.openTask);
  const openChat = useOpenChat();
  const openTask = useOpenTask(layout);
  const answerTask = useAnswer();
  const undo = usePultStore((s) => s.undoAnswer);
  if (!pult) return null;
  const { ix, answers, original } = pult;
  const now = ix.now;
  const status = TASK_STATUS[task.status];
  const need = hasOpenNeed(task) ? task.needs : undefined;
  const answered = answers[task.id];
  const originalNeed = original.task(task.id)?.needs;
  const owner = ix.chat(ownerChatId(task));
  const arts = openableArtifacts(task);
  const left = leftActions(task);
  const docs = (task.docs ?? []).map((path) => ({ path, doc: ix.data.docs[path] })).filter((d) => d.doc);

  const openArtifact = (a: PultArtifact) => {
    if (a.url) pane.openUrl(a.url);
    else if (a.path && ix.data.docs[a.path]) openDoc(a.path);
    else if (a.path) toastManager.add({ type: "info", title: "Файл на компьютере", description: a.path });
  };
  const openDoc = (path: string) => {
    const doc = ix.data.docs[path];
    if (!doc) return;
    pane.openFile({ id: `pult-doc:${path}`, name: path.split("/").at(-1) ?? doc.title, kind: "md", content: doc.md });
  };

  return (
    <div className="pb-8" data-testid="pult-task-card">
      <div className="flex items-center gap-1 px-1 pt-1">
        <Button size="xs" variant="ghost" onClick={() => openTaskInStore(null)} className="text-muted-foreground">
          <ArrowLeftIcon />
          Задачи
        </Button>
        {owner?.thread && layout === "center" ? (
          <Button size="xs" variant="ghost" className="ml-auto text-muted-foreground" onClick={() => openTask(task, ix)}>
            <MessageSquareIcon />
            Открыть чат
          </Button>
        ) : null}
      </div>
      <div className="px-2 pt-2">
        <h2 className="text-base font-semibold leading-snug">{task.title}</h2>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5 text-foreground">
            <Dot tone={status.tone} />
            {status.label}
          </span>
          <span>{task.progress}%</span>
          {task.eta?.left ? <span>осталось {task.eta.left}</span> : null}
          {task.deadline ? <span>срок {dayTime(task.deadline, now)}</span> : null}
        </div>
      </div>

      {need ? (
        <div className="mx-2 mt-3 rounded-lg bg-muted/60 p-3" data-testid="pult-task-need">
          <div className="text-xs font-medium text-amber-700 dark:text-amber-400">Нужно от тебя</div>
          <div className="mt-1 text-sm font-medium leading-snug">{need.title}</div>
          {need.explain ? <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{need.explain}</p> : null}
          {need.steps ? (
            <ol className="mt-1.5 list-decimal space-y-0.5 pl-4 text-xs text-muted-foreground">
              {need.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          ) : null}
          <div className="mt-2 flex flex-col gap-1.5">
            {(need.options ?? [{ label: "Готово", recommended: true }]).map((o) => (
              <button
                key={o.label}
                type="button"
                onClick={() => answerTask(task, ix, o.label)}
                className={cn(
                  "cursor-pointer rounded-md border px-2.5 py-1.5 text-left text-sm transition-colors",
                  o.recommended ? "border-primary/50 bg-background hover:bg-primary/5" : "border-border bg-background hover:bg-accent",
                )}
              >
                <span className="font-medium">{o.label}</span>
                {o.recommended ? <span className="ml-1.5 text-[11px] text-primary">советую</span> : null}
                {o.hint ? <span className="block text-xs text-muted-foreground">{o.hint}</span> : null}
              </button>
            ))}
          </div>
          {need.autoText ? <p className="mt-2 text-[11px] text-muted-foreground">{need.autoText}</p> : null}
        </div>
      ) : answered && originalNeed ? (
        <div className="mx-2 mt-3 flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-sm">
          <CheckIcon className="size-3.5 text-emerald-600" />
          <span className="min-w-0 flex-1">
            Ты ответил: <span className="font-medium">{answered.label}</span>
          </span>
          <button type="button" onClick={() => undo(task.id)} className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            Отменить
          </button>
        </div>
      ) : null}

      {task.status === "blocked" && task.blocker ? (
        <p className="mx-2 mt-3 text-sm leading-snug">
          <span className="font-medium">{need ? "Ещё стоит из-за: " : "Стоит не из-за тебя: "}</span>
          <span className="text-muted-foreground">{task.blocker}</span>
        </p>
      ) : null}
      {task.status === "paused" && task.pause ? (
        <p className="mx-2 mt-3 text-sm leading-snug text-muted-foreground">{task.pause}</p>
      ) : null}

      {arts.length > 0 ? (
        <>
          <SectionLabel>Где смотреть</SectionLabel>
          {arts.map((a) => (
            <ArtifactRow key={a.title} artifact={a} onOpen={() => openArtifact(a)} />
          ))}
        </>
      ) : null}

      {task.env ? (
        <>
          <SectionLabel>Прод и стейдж</SectionLabel>
          <div className="space-y-1 px-2 text-sm">
            <div className="flex gap-2">
              <span className="w-16 shrink-0 text-muted-foreground">Прод</span>
              <span className="min-w-0">{task.env.prod ? task.env.prod.what : <span className="text-muted-foreground">ещё нет</span>}</span>
            </div>
            {task.env.stage ? (
              <div className="flex gap-2">
                <span className="w-16 shrink-0 text-muted-foreground">Стейдж</span>
                <span className="min-w-0">{task.env.stage.what}</span>
              </div>
            ) : null}
            {task.env.prod?.rollback ? (
              <div className="flex gap-2 text-xs text-muted-foreground">
                <span className="w-16 shrink-0">Откат</span>
                <span>{task.env.prod.rollback}</span>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {left.length > 0 ? (
        <>
          <SectionLabel>Осталось</SectionLabel>
          <ul className="space-y-0.5 px-2 text-sm">
            {left.map((a) => (
              <li key={a.text} className="flex items-start gap-2">
                <span className="mt-1.5 size-2 shrink-0 rounded-full border border-muted-foreground/50" aria-hidden />
                <span className="min-w-0">
                  {a.text}
                  {a.who === "misha" ? <span className="ml-1.5 text-xs text-amber-700 dark:text-amber-400">ты</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <div className="mt-4 border-t border-border/60 pt-1">
        {task.request ? (
          <Details title="Что ты просил">
            <p className="text-muted-foreground">
              {task.request.by} · {dayTime(task.request.at, now)}
            </p>
            <p className="mt-1 leading-relaxed">{task.request.text}</p>
            {task.request.wishes?.length ? (
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
                {task.request.wishes.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            ) : null}
          </Details>
        ) : null}
        <Details title="Кто делает и где" count={task.chats.length}>
          {task.chats.length === 0 ? <p className="text-muted-foreground">Никто — задача ждёт исполнителя.</p> : null}
          {task.chats.map((id) => {
            const c = ix.chat(id);
            if (!c) return null;
            const state = CHAT_STATE[c.state];
            return (
              <button key={id} type="button" onClick={() => openChat(ix, id)} className="-mx-2 block w-[calc(100%+1rem)] cursor-pointer rounded-md px-2 py-1 text-left hover:bg-accent/60">
                <span className="flex items-center gap-2">
                  <Dot tone={state.tone} pulse={c.state === "working"} />
                  <span className="truncate font-medium">{c.title}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">{state.label}</span>
                </span>
                <span className="block truncate pl-3.5 text-xs text-muted-foreground">
                  {c.agent} · {c.model} · {ix.machineName(c.machine)} · {ix.subLabel(c.subscription)}
                </span>
              </button>
            );
          })}
        </Details>
        {docs.length > 0 ? (
          <Details title="Доки" count={docs.length}>
            {docs.map(({ path, doc }) => (
              <button key={path} type="button" onClick={() => openDoc(path)} className="-mx-2 flex w-[calc(100%+1rem)] cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-accent/60">
                <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{doc!.title}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{relTime(doc!.updatedAt, now)}</span>
              </button>
            ))}
          </Details>
        ) : null}
        {task.stages?.length ? (
          <Details title="Этапы">
            <ol className="space-y-0.5">
              {task.stages.map((s) => (
                <li key={s.name} className={cn("flex items-center gap-2", s.done ? "text-muted-foreground" : s.now ? "font-medium" : "")}>
                  {s.done ? <CheckIcon className="size-3.5 text-emerald-600" /> : <span className={cn("ml-1 mr-0.5 size-1.5 rounded-full", s.now ? "bg-primary" : "bg-muted-foreground/40")} />}
                  {s.name}
                </li>
              ))}
            </ol>
          </Details>
        ) : null}
        {task.feed?.length ? (
          <Details title="Лента" count={task.feed.length}>
            <ul className="space-y-1">
              {task.feed.map((f) => (
                <li key={f.at + f.text} className="flex gap-2">
                  <span className="w-20 shrink-0 text-xs text-muted-foreground">{relTime(f.at, now)}</span>
                  <span className="min-w-0">{f.text}</span>
                </li>
              ))}
            </ul>
          </Details>
        ) : null}
        <Details title={`Приоритет · ${task.priority}`}>
          <div className="flex gap-1">
            {(["P0", "P1", "P2", "P3"] as const).map((p) => (
              <Button key={p} size="xs" variant={task.priority === p ? "secondary" : "ghost"} onClick={() => usePultStore.getState().setPriority(task.id, p)}>
                {p}
              </Button>
            ))}
          </div>
        </Details>
      </div>

      <div className="mt-2 px-2">
        <NewChatMenu ix={ix} task={task} />
      </div>
    </div>
  );
}

/** "New chat for this task" — on any computer, the freest subscription marked. */
function NewChatMenu({ ix, task }: { ix: PultIndex; task: PultTask }) {
  const subs = new Map(ix.data.subscriptions.map((s) => [s.id, s]));
  const free = (subId: string | undefined) => {
    const s = subId ? subs.get(subId) : undefined;
    return 100 - Math.max(0, ...(s?.windows ?? []).map((w) => w.pct));
  };
  const machines = ix.data.machines;
  const best = machines.toSorted((a, b) => free(b.subscription) - free(a.subscription))[0];
  const envOf = (machineId: string) =>
    ix.data.chats.find((c) => c.machine === machineId && c.thread)?.thread?.environmentId ?? null;
  return (
    <Menu>
      <MenuTrigger
        data-testid="pult-new-chat"
        className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 text-xs outline-hidden hover:bg-accent data-[popup-open]:bg-accent"
      >
        <SquarePenIcon className="size-3.5" />
        Новый чат по задаче
        <ChevronDownIcon className="size-3 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-64">
        {machines.map((m) => (
          <NewChatItem
            key={m.id}
            environmentId={envOf(m.id)}
            name={m.name}
            note={m.id === best?.id ? `свободнее всего · ${free(m.subscription)}%` : `лимит свободен на ${free(m.subscription)}%`}
            prompt={`По задаче «${task.title}»: `}
          />
        ))}
        <MenuSeparator />
        <div className="max-w-64 px-2 py-1 text-[11px] leading-snug text-muted-foreground">
          Новый чат на этом компьютере, текст про задачу уже в поле. ИИ и модель выбираешь в самом чате.
        </div>
      </MenuPopup>
    </Menu>
  );
}

function NewChatItem(props: { environmentId: string | null; name: string; note: string; prompt: string }) {
  const { askUno } = useHomeLaunchers(props.environmentId as EnvironmentId | null);
  return (
    <MenuItem disabled={!props.environmentId} onClick={() => void askUno(props.prompt)}>
      <span className="flex-1">{props.name}</span>
      <span className="text-[11px] text-muted-foreground">{props.note}</span>
    </MenuItem>
  );
}

/* ───────── Other screens (from the "headquarters" version) ───────── */

function Screens({ screen }: { screen: Exclude<PultScreen, "board"> }) {
  const pult = usePult();
  const openTask = useOpenTask("panel");
  if (!pult) return null;
  const { ix } = pult;
  const now = ix.now;
  const row = (key: string, left: ReactNode, right: ReactNode, onClick?: () => void, sub?: ReactNode) => (
    <button key={key} type="button" disabled={!onClick} onClick={onClick} className="block w-full rounded-md px-2 py-1.5 text-left enabled:cursor-pointer enabled:hover:bg-accent/60">
      <span className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-sm leading-snug">{left}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{right}</span>
      </span>
      {sub ? <span className="block text-xs leading-snug text-muted-foreground">{sub}</span> : null}
    </button>
  );
  const goTask = (id: string | null | undefined) => {
    const t = ix.task(id);
    return t ? () => openTask(t, ix) : undefined;
  };
  if (screen === "releases") {
    const env = (e: "prod" | "stage" | "plan", label: string) => {
      const list = ix.data.releases.filter((r) => r.env === e);
      return list.length ? (
        <div key={e}>
          <SectionLabel>{label}</SectionLabel>
          {list.map((r) =>
            row(r.what, <span className="flex items-center gap-2">{r.state === "rolling" ? <Dot tone="blue" pulse /> : null}{r.what}</span>, e === "plan" ? relTime(r.at, now) : relTime(r.at, now), goTask(r.task), r.rollback ? `Откат: ${r.rollback}` : r.state === "rolling" ? "катится сейчас" : undefined),
          )}
        </div>
      ) : null;
    };
    return <div className="pb-6">{[env("prod", "В проде"), env("stage", "На стейдже"), env("plan", "Запланировано")]}</div>;
  }
  if (screen === "wishes") {
    const WHERE = { prod: "в проде", stage: "на стейдже", doing: "в работе", lost: "потерялось", declined: "отказались" } as const;
    const lost = ix.data.wishes.filter((w) => w.where === "lost");
    const coordinator = ix.data.chats.find((c) => c.title === "Координатор");
    const rest = ix.data.wishes.filter((w) => w.where !== "lost");
    return (
      <div className="pb-6">
        {lost.length ? <SectionLabel>Потерялось</SectionLabel> : null}
        {lost.map((w) => row(w.text, w.text, dayTime(w.at, now).replace(/ \d\d:\d\d$/, ""), goTask(w.task), w.note))}
        {lost.length && coordinator?.thread ? (
          <div className="px-2 pt-1">
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                void sendToThread(coordinator.thread!, `(Пульт) Потерялись просьбы — раздай исполнителям:\n${lost.map((w) => `- ${w.text}`).join("\n")}`);
                toastManager.add({ type: "success", title: `Ушло в «${coordinator.title}»` });
              }}
            >
              Отдать координатору
            </Button>
          </div>
        ) : null}
        <SectionLabel>Остальные</SectionLabel>
        {rest.map((w) => row(w.text, w.text, WHERE[w.where], goTask(w.task)))}
      </div>
    );
  }
  if (screen === "limits") {
    return (
      <div className="pb-6 pt-2">
        {ix.data.subscriptions.map((s) => {
          const peak = s.windows.reduce((a, w) => (w.pct > a ? w.pct : a), 0);
          return (
            <div key={s.id} className="px-2 py-2">
              <div className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{s.label}</span>
                <span className={cn("text-xs", s.state === "warn" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
                  {s.windows.length ? `занято ${peak}%` : "без лимита"}
                </span>
              </div>
              {s.windows.length ? (
                <span className="mt-1 block h-1 overflow-hidden rounded-full bg-muted">
                  <span className={cn("block h-full rounded-full", s.state === "warn" ? "bg-amber-500" : "bg-foreground/40")} style={{ width: `${peak}%` }} />
                </span>
              ) : null}
              {s.state === "warn" ? <p className="mt-1 text-xs text-muted-foreground">{s.windows[0]?.forecast}. {s.advice}</p> : null}
            </div>
          );
        })}
      </div>
    );
  }
  if (screen === "alerts") {
    return (
      <div className="pb-6 pt-2">
        {ix.data.alerts.map((a) =>
          row(a.raw, <span className={cn(a.needYou && "font-medium")}>{a.plain}</span>, relTime(a.at, now), goTask(a.task), `${a.source}${a.needYou ? " · нужен ты" : ""}`),
        )}
      </div>
    );
  }
  return (
    <div className="pb-6 pt-2">
      {ix.data.decisions.map((d) => row(d.text, d.text, dayTime(d.at, now).replace(/ \d\d:\d\d$/, ""), goTask(d.task)))}
    </div>
  );
}

/* ───────── Dispatcher: one field for the whole Pult ───────── */

function Dispatcher({ layout }: { layout: PultLayout }) {
  const pult = usePult();
  const openTask = useOpenTask(layout);
  const openChat = useOpenChat();
  const setView = usePultStore((s) => s.setView);
  const [text, setText] = useState("");
  const [shots, setShots] = useState(0);
  const [focused, setFocused] = useState(false);
  const [answer, setAnswer] = useState<PultAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && e.shiftKey) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handoff = usePultStore((s) => s.handoff);
  useEffect(() => {
    if (!handoff || !pult) return;
    setText(handoff.text);
    setShots(handoff.shots);
    setBusy(true);
    setAnswer(null);
    const timer = window.setTimeout(() => {
      setAnswer(dispatch(handoff.text, handoff.shots, pult.ix));
      setBusy(false);
    }, 500);
    return () => window.clearTimeout(timer);
    // Only a new handoff asks again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoff?.at]);

  if (!pult) return null;
  const { ix } = pult;

  const ask = (q: string) => {
    setBusy(true);
    setAnswer(null);
    const n = shots;
    window.setTimeout(() => {
      setAnswer(dispatch(q, n, ix));
      setBusy(false);
    }, 500);
  };
  const submit = () => {
    if (!text.trim() && !shots) return;
    ask(text);
  };
  const run = (act: PultAct) => {
    switch (act.type) {
      case "open-chat":
        openChat(ix, act.chat);
        break;
      case "open-task": {
        const t = ix.task(act.task);
        if (t) openTask(t, ix);
        break;
      }
      case "view":
        setView(act.view);
        setAnswer(null);
        break;
      case "ask":
        setText(act.text);
        ask(act.text);
        break;
      case "send": {
        const c = ix.chat(act.chat);
        if (c?.thread) void sendToThread(c.thread, `(Пульт) ${act.text}${act.files.length ? `\n\nСкрин: ${act.files.join(", ")}` : ""}`);
        toastManager.add({ type: "success", title: `Ушло в «${c?.title ?? "чат"}»` });
        setAnswer(null);
        setText("");
        setShots(0);
        break;
      }
      case "broadcast": {
        for (const id of act.chats) {
          const c = ix.chat(id);
          if (c?.thread) void sendToThread(c.thread, `(Пульт) ${act.text}`);
        }
        toastManager.add({ type: "success", title: `Отправлено в ${act.chats.length} чатов` });
        setAnswer(null);
        setText("");
        break;
      }
      default:
        toastManager.add({ type: "info", title: "В моке это только отмечается" });
        setAnswer(null);
    }
  };

  const card = (c: PultCard, i: number) => {
    const taskOf = "task" in c && typeof c.task === "string" ? ix.task(c.task) : undefined;
    if ((c.type === "task" || c.type === "need" || c.type === "route") && taskOf) {
      const chat = ix.chat(c.type === "route" ? c.chat : ownerChatId(taskOf));
      return (
        <button key={i} type="button" onClick={() => openTask(taskOf, ix)} className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent/60">
          <Dot tone={c.type === "need" ? "amber" : TASK_STATUS[taskOf.status].tone} />
          <span className="min-w-0 flex-1 truncate">{c.type === "need" && taskOf.needs ? taskOf.needs.title : taskOf.title}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{c.type === "route" ? `→ ${chat?.title ?? "новая задача"}` : machineWord(ix.machineName(chat?.machine))}</span>
        </button>
      );
    }
    if (c.type === "artifact") return <ArtifactRow key={i} artifact={c.artifact} onOpen={() => c.artifact.url && window.open(c.artifact.url, "_blank")} />;
    if (c.type === "release" || c.type === "wish" || c.type === "alert") {
      const label = c.type === "release" ? c.release.what : c.type === "wish" ? c.wish.text : c.alert.plain;
      return (
        <div key={i} className="truncate px-2 py-1 text-sm text-muted-foreground">
          {label}
        </div>
      );
    }
    if (c.type === "chat") {
      const chat = ix.chat(c.chat);
      return (
        <button key={i} type="button" onClick={() => openChat(ix, c.chat)} className="block w-full cursor-pointer truncate rounded-md px-2 py-1 text-left text-sm hover:bg-accent/60">
          {chat?.title}
        </button>
      );
    }
    return null;
  };

  return (
    <div className="px-2">
      <div
        className={cn("rounded-lg border border-border bg-background transition-colors", focused && "border-ring/60")}
        onPaste={(e) => {
          if ([...e.clipboardData.items].some((it) => it.type.startsWith("image/"))) {
            e.preventDefault();
            setShots((n) => n + 1);
          }
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files.length) setShots((n) => n + e.dataTransfer.files.length);
        }}
      >
        <div className="flex items-start gap-2 px-2.5 py-1.5">
          <textarea
            ref={inputRef}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => window.setTimeout(() => setFocused(false), 150)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
              if (e.key === "Escape") {
                setAnswer(null);
                inputRef.current?.blur();
              }
            }}
            placeholder="Спросить или передать в чат…"
            className="min-h-6 flex-1 resize-none bg-transparent py-0.5 text-sm outline-hidden placeholder:text-muted-foreground/70"
            data-testid="pult-dispatch-input"
          />
          {shots ? (
            <button type="button" onClick={() => setShots(0)} className="mt-0.5 flex shrink-0 cursor-pointer items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground" title="Убрать">
              <ImageIcon className="size-3" />
              {shots} скрин
              <XIcon className="size-3" />
            </button>
          ) : (
            <kbd className="mt-1 shrink-0 text-[10px] text-muted-foreground/70">⇧⌘K</kbd>
          )}
        </div>
      </div>
      {focused && !text && !answer ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {DISPATCH_SUGGEST.map((s) => (
            <button
              key={s}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setText(s);
                ask(s);
              }}
              className="cursor-pointer rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}
      {busy ? <p className="px-1 pt-2 text-xs text-muted-foreground">Смотрю все чаты…</p> : null}
      {answer ? (
        <div className="mt-2 rounded-lg bg-muted/50 p-2" data-testid="pult-dispatch-answer">
          <div className="flex items-start gap-2 px-1">
            <p className="min-w-0 flex-1 text-sm leading-relaxed">
              <Rich text={answer.text} />
            </p>
            <button type="button" aria-label="Закрыть ответ" onClick={() => setAnswer(null)} className="cursor-pointer text-muted-foreground hover:text-foreground">
              <XIcon className="size-3.5" />
            </button>
          </div>
          {answer.cards.length ? <div className="mt-1">{answer.cards.map(card)}</div> : null}
          {answer.actions.length ? (
            <div className="mt-2 flex flex-wrap gap-1.5 px-1">
              {answer.actions.map((a) => (
                <Button key={a.label} size="xs" variant={a.primary ? "default" : "outline"} onClick={() => run(a.act)}>
                  {a.label}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ───────── While you were away ───────── */

function SinceLastSeen() {
  const pult = usePult();
  const [open, setOpen] = useState(false);
  const openTask = useOpenTask("panel");
  if (!pult) return null;
  const { ix } = pult;
  const events = ix.data.sinceLastSeen.toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at));
  if (!events.length) return null;
  const good = events.filter((e) => e.kind === "release").length;
  const bad = events.filter((e) => e.bad).length;
  const summary = [good ? `${good} в проде` : null, bad ? `${bad} плохо` : null, `${events.length} событий`].filter(Boolean).join(" · ");
  return (
    <div className="px-2 pt-2">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        {open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
        Пока тебя не было: {summary}
      </button>
      {open ? (
        <ul className="mt-1 space-y-0.5">
          {events.map((e) => {
            const t = ix.task(e.task);
            return (
              <li key={e.at + e.text}>
                <button type="button" onClick={() => t && openTask(t, ix)} className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-left text-sm hover:bg-accent/60">
                  <Dot tone={e.bad ? "red" : e.kind === "release" ? "green" : "grey"} />
                  <span className="min-w-0 flex-1 truncate">{e.text}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{relTime(e.at, ix.now)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/* ───────── The whole thing ───────── */

export function PultView({ layout }: { layout: PultLayout }) {
  const pult = usePult();
  const view = usePultStore((s) => s.view);
  const setView = usePultStore((s) => s.setView);
  const openTaskId = usePultStore((s) => s.openTaskId);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [openTaskId, view]);

  if (!pult) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-sm text-muted-foreground">
        Здесь будут задачи агентов — когда они начнут отчитываться в Пульт.
      </div>
    );
  }
  const { ix, tasks } = pult;
  const glance = glanceLine(tasks);
  const openTask = openTaskId ? ix.task(openTaskId) : undefined;
  const screenLabel = SCREENS.find((s) => s.id === view)?.label ?? "Задачи";
  const lostWishes = ix.data.wishes.filter((w) => w.where === "lost").length;
  const alertsForYou = ix.data.alerts.filter((a) => a.needYou).length;
  const hint: Partial<Record<PultScreen, string>> = {
    wishes: lostWishes ? `${lostWishes} потерялись` : "",
    alerts: alertsForYou ? `${alertsForYou} для тебя` : "",
    limits: ix.data.subscriptions.some((s) => s.state !== "ok") ? "одна горит" : "",
  };

  return (
    <div ref={scrollRef} className={cn("h-full overflow-y-auto", layout === "center" && "px-3 py-4 md:px-6 md:py-6")} data-testid={`pult-${layout}`}>
      <div className={cn(layout === "center" ? "mx-auto max-w-2xl" : "px-2 pt-3")}>
        {openTask ? (
          <TaskCard task={openTask} layout={layout} />
        ) : (
          <>
            <div className="flex items-center gap-2 px-2 pb-3">
              {view === "board" ? (
                <p className={cn("min-w-0 font-semibold tracking-tight", layout === "center" ? "text-[15px] md:text-lg" : "text-[15px]")} data-testid="pult-glance">
                  {glance.count ? (
                    <>
                      Ты нужен в <span className="text-amber-700 dark:text-amber-400">{glance.count} {glance.count === 1 ? "месте" : "местах"}</span>
                      <span className="font-normal text-muted-foreground"> · ≈ {glance.minutes} мин</span>
                    </>
                  ) : (
                    glance.text
                  )}
                </p>
              ) : (
                <Button size="xs" variant="ghost" onClick={() => setView("board")} className="-ml-2 text-muted-foreground">
                  <ArrowLeftIcon />
                  Задачи
                </Button>
              )}
              <Menu>
                <MenuTrigger
                  className={cn(
                    "ml-auto inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-sm text-muted-foreground outline-hidden hover:bg-accent hover:text-foreground data-[popup-open]:bg-accent",
                  )}
                  data-testid="pult-screen-menu"
                >
                  {screenLabel}
                  <ChevronDownIcon className="size-3.5" />
                </MenuTrigger>
                <MenuPopup align="end" className="min-w-52">
                  {SCREENS.map((s) => (
                    <MenuItem key={s.id} onClick={() => setView(s.id)}>
                      <span className="flex-1">{s.label}</span>
                      {hint[s.id] ? <span className="text-[11px] text-amber-700 dark:text-amber-400">{hint[s.id]}</span> : null}
                      {view === s.id ? <CheckIcon className="size-3.5" /> : null}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
                        </div>
            {view === "board" ? (
              <>
                <Dispatcher layout={layout} />
                <SinceLastSeen />
                <Board layout={layout} />
              </>
            ) : (
              <Screens screen={view} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Open the Pult as a tab of the right panel, pinned "everywhere". */
export function openPultTabIn(pane: ReturnType<typeof usePreviewPane>) {
  pane.openFileForTarget(
    { projectKey: pane.currentProjectKey, threadId: pane.currentChatThreadId },
    "global",
    makePultFile(),
  );
}
