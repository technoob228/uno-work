/**
 * Needs you (Misha 13.11, the Pult redo): the one screen that answers "am I
 * needed?". On top, the verdict in one line — where and about how long; under
 * it only what waits on the person, by what it takes: decide (one tap),
 * accept a result (before / after), look at a chat an agent called them into,
 * and, quieter, chats that finished what they asked. What runs without them
 * is one line at the bottom. Rows answer in place, like Home's Needs you;
 * the chat opens when the answer needs more than a tap.
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  BellRingIcon,
  CheckCheckIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  ExternalLinkIcon,
  HourglassIcon,
  ListChecksIcon,
  MessageCircleQuestionIcon,
  MessagesSquareIcon,
  ShieldAlertIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { markChatDone } from "../../inbox/inboxDone";
import { usePendingApproval } from "../../inbox/usePendingApproval";
import {
  askAnswerLine,
  type ExternalAsk,
  type ReviewAsk,
  useExternalAsksStore,
} from "../../needsYou/externalAsks";
import {
  MINUTES,
  SECTION_TITLE,
  needsYouVerdict,
  quietLine,
  type NeedsYouRow,
  type NeedsYouSection,
} from "../../needsYou/needsYou.logic";
import { useNeedsYouBoard } from "../../needsYou/useNeedsYouBoard";
import { usePendingQuestion } from "../../needsYou/usePendingQuestion";
import type { SidebarThreadSummary } from "../../types";
import { approvalQuestion, shortAgo } from "../computer/home/homeModel";
import { useOpenThread } from "../computer/home/HomeThreads";
import { SidebarShowButton } from "../sidebar/SidebarShowButton";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";

const SECTION_ICON: Record<NeedsYouSection, ReactNode> = {
  decide: <MessageCircleQuestionIcon />,
  accept: <ListChecksIcon />,
  look: <BellRingIcon />,
  ready: <CheckCheckIcon />,
};

function sent(line: string) {
  toastManager.add({ type: "success", title: "Sent", description: line });
}

/** "6 min · task of “Pricing page”" under a row. */
function Meta({ row, extra }: { row: NeedsYouRow; extra?: string }) {
  const ago = shortAgo(Date.parse(row.at), Date.now());
  const when =
    !ago || ago === "now"
      ? "just now"
      : row.type === "ready"
        ? `finished ${ago} ago`
        : `waiting ${ago}`;
  const parts = [extra, row.where, when].filter(Boolean);
  return <span className="block truncate text-xs text-muted-foreground">{parts.join(" · ")}</span>;
}

function RowShell(props: {
  icon: ReactNode;
  tone: string;
  children: ReactNode;
  actions?: ReactNode;
  testId: string;
  onOpen?: () => void;
}) {
  return (
    <div
      className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3"
      data-testid={props.testId}
    >
      <button
        type="button"
        onClick={props.onOpen}
        disabled={!props.onOpen}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left disabled:cursor-default"
      >
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-lg [&_svg]:size-4",
            props.tone,
          )}
        >
          {props.icon}
        </span>
        <span className="min-w-0 flex-1">{props.children}</span>
      </button>
      {props.actions ? (
        <span className="flex shrink-0 flex-wrap items-center gap-1.5 pl-11 sm:pl-0">
          {props.actions}
        </span>
      ) : null}
    </div>
  );
}

function ApprovalRow({ row, thread }: { row: NeedsYouRow; thread: SidebarThreadSummary }) {
  const open = useOpenThread();
  const { approval, responding, respond } = usePendingApproval(thread.environmentId, thread.id);
  const question = approval ? approvalQuestion(approval) : null;
  return (
    <RowShell
      testId="needs-you-approval"
      icon={<ShieldAlertIcon />}
      tone="bg-amber-500/10 text-amber-600 dark:text-amber-300"
      onOpen={() => open(thread)}
      actions={
        <>
          <Button
            size="xs"
            disabled={responding || !approval}
            onClick={() => void respond("accept").then(() => sent(`Allowed in “${thread.title}”`))}
          >
            Allow
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={responding || !approval}
            onClick={() =>
              void respond("decline").then(() => sent(`Declined in “${thread.title}”`))
            }
          >
            Decline
          </Button>
        </>
      }
    >
      <span className="block truncate text-sm font-medium">
        {question ? (
          <>
            {question.lead}
            {question.subject ? (
              <>
                {" "}
                <span className="font-mono text-[13px]">{question.subject}</span>
              </>
            ) : null}
            ?
          </>
        ) : (
          "Wants your OK to go on"
        )}
      </span>
      <Meta row={row} extra={thread.title} />
    </RowShell>
  );
}

function QuestionRow({ row, thread }: { row: NeedsYouRow; thread: SidebarThreadSummary }) {
  const open = useOpenThread();
  const { question, responding, answer } = usePendingQuestion(
    thread.environmentId as EnvironmentId,
    thread.id as ThreadId,
  );
  return (
    <RowShell
      testId="needs-you-question"
      icon={<MessageCircleQuestionIcon />}
      tone="bg-indigo-500/10 text-indigo-600 dark:text-indigo-300"
      onOpen={() => open(thread)}
      actions={
        question ? (
          question.options.map((option, index) => (
            <Button
              key={option.label}
              size="xs"
              variant={index === 0 ? "default" : "outline"}
              disabled={responding}
              title={option.description}
              onClick={() =>
                void answer(option.label).then(
                  (ok) => ok && sent(`“${question.question}” → ${option.label}`),
                )
              }
            >
              {option.label}
            </Button>
          ))
        ) : (
          <Button size="xs" variant="outline" onClick={() => open(thread)}>
            Open chat
          </Button>
        )
      }
    >
      <span className="block text-sm font-medium">
        {question?.question ?? "Asked you a question"}
      </span>
      <Meta row={row} extra={thread.title} />
    </RowShell>
  );
}

function AskQuestionRow({
  row,
  ask,
}: {
  row: NeedsYouRow;
  ask: ExternalAsk & { kind: "question" };
}) {
  const answerAsk = useExternalAsksStore((state) => state.answer);
  return (
    <RowShell
      testId="needs-you-ask"
      icon={<MessageCircleQuestionIcon />}
      tone="bg-indigo-500/10 text-indigo-600 dark:text-indigo-300"
      actions={ask.options.map((option, index) => (
        <Button
          key={option}
          size="xs"
          variant={index === 0 ? "default" : "outline"}
          onClick={() => {
            const answer = { kind: "option", option } as const;
            answerAsk(ask.id, answer);
            sent(`${askAnswerLine(ask, answer)} — to ${ask.from}`);
          }}
        >
          {option}
        </Button>
      ))}
    >
      <span className="block text-sm font-medium">{ask.title}</span>
      {ask.detail ? <span className="block text-xs text-foreground/80">{ask.detail}</span> : null}
      <Meta row={row} />
    </RowShell>
  );
}

function CallRow({
  row,
  thread,
  reason,
}: {
  row: NeedsYouRow;
  thread: SidebarThreadSummary;
  reason: string;
}) {
  const open = useOpenThread();
  return (
    <RowShell
      testId="needs-you-call"
      icon={<BellRingIcon />}
      tone="bg-warning/12 text-warning"
      onOpen={() => open(thread)}
      actions={
        <Button size="xs" onClick={() => open(thread)}>
          Open chat
        </Button>
      }
    >
      <span className="block text-sm font-medium">{reason}</span>
      <Meta row={row} extra={thread.title} />
    </RowShell>
  );
}

function ReadyRow({ row, thread }: { row: NeedsYouRow; thread: SidebarThreadSummary }) {
  const open = useOpenThread();
  const [busy, setBusy] = useState(false);
  return (
    <RowShell
      testId="needs-you-ready"
      icon={<CheckCheckIcon />}
      tone="bg-success/10 text-success"
      onOpen={() => open(thread)}
      actions={
        <>
          <Button size="xs" variant="outline" onClick={() => open(thread)}>
            Read
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void markChatDone(thread.environmentId, thread.id).finally(() => setBusy(false));
            }}
          >
            <CheckIcon /> Done
          </Button>
        </>
      }
    >
      <span className="block truncate text-sm font-medium">{thread.title}</span>
      <Meta row={row} />
    </RowShell>
  );
}

function CopyPassword({ password }: { password: string }) {
  return (
    <button
      type="button"
      className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border/70 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
      onClick={() => {
        void navigator.clipboard?.writeText(password).catch(() => undefined);
        toastManager.add({ type: "success", title: "Password copied" });
      }}
      title="Copy the page's password"
    >
      <CopyIcon className="size-3" /> password
    </button>
  );
}

function ReviewCard({ row, ask }: { row: NeedsYouRow; ask: ReviewAsk }) {
  const answerAsk = useExternalAsksStore((state) => state.answer);
  const [expanded, setExpanded] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [zoom, setZoom] = useState<string | null>(null);
  const side = (which: "before" | "after") => (
    <div className="min-w-0 flex-1 rounded-xl border border-border/70 bg-background/60 p-3">
      <div
        className={cn(
          "mb-1.5 text-[11px] font-semibold tracking-wide uppercase",
          which === "after" ? "text-success" : "text-muted-foreground",
        )}
      >
        {which === "before" ? "Before" : "After"}
      </div>
      <ul className="flex list-disc flex-col gap-1 pl-4 text-sm">
        {(which === "before" ? ask.before : ask.after).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {ask.images
          .filter((image) => image.side === which)
          .map((image) => (
            <button
              key={image.url}
              type="button"
              className="group/shot flex cursor-zoom-in flex-col gap-1 text-left"
              onClick={() => setZoom(image.url)}
            >
              <img
                src={image.url}
                alt={image.caption}
                loading="lazy"
                className="aspect-[16/10] w-full rounded-lg border border-border/70 object-cover object-top transition-opacity group-hover/shot:opacity-90"
              />
              <span className="line-clamp-2 text-[11px] text-muted-foreground">
                {image.caption}
              </span>
            </button>
          ))}
      </div>
    </div>
  );
  return (
    <div
      className="px-3 py-2.5"
      data-testid="needs-you-review"
      data-expanded={expanded || undefined}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full min-w-0 cursor-pointer items-center gap-3 text-left"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary [&_svg]:size-4">
          <ListChecksIcon />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{ask.title}</span>
          <span className="block text-xs text-foreground/80">{ask.summary}</span>
          <Meta row={row} extra={`${ask.where} · v${ask.version}`} />
        </span>
        <ChevronDownIcon
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded ? (
        <div className="mt-3 flex flex-col gap-3 pl-0 sm:pl-11">
          <div className="flex flex-col gap-2 md:flex-row">
            {side("before")}
            {side("after")}
          </div>
          {ask.checks.length > 0 ? (
            <div className="text-sm">
              <div className="mb-1 text-xs font-medium text-muted-foreground">What to check</div>
              <ul className="flex list-disc flex-col gap-0.5 pl-4">
                {ask.checks.map((check) => (
                  <li key={check}>{check}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {ask.links.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              {ask.links.map((link) => (
                <span key={link.url} className="inline-flex items-center gap-1.5">
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                  >
                    {link.label} <ExternalLinkIcon className="size-3.5" />
                  </a>
                  {link.password ? <CopyPassword password={link.password} /> : null}
                </span>
              ))}
            </div>
          ) : null}
          {rejecting ? (
            <div className="flex flex-col gap-2">
              <Textarea
                autoFocus
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                placeholder="What's wrong — the agent gets it as is"
                rows={2}
              />
              <div className="flex gap-1.5">
                <Button
                  size="xs"
                  variant="destructive-outline"
                  disabled={feedback.trim().length === 0}
                  onClick={() => {
                    const answer = { kind: "reject", feedback: feedback.trim() } as const;
                    answerAsk(ask.id, answer);
                    sent(`${askAnswerLine(ask, answer)} — to ${ask.from}`);
                  }}
                >
                  Send: not accepted
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setRejecting(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-1.5">
              <Button
                size="xs"
                onClick={() => {
                  const answer = { kind: "accept" } as const;
                  answerAsk(ask.id, answer);
                  sent(`${askAnswerLine(ask, answer)} — to ${ask.from}`);
                }}
                data-testid="needs-you-accept"
              >
                <CheckIcon /> Accept
              </Button>
              <Button size="xs" variant="outline" onClick={() => setRejecting(true)}>
                Not accept…
              </Button>
            </div>
          )}
        </div>
      ) : null}
      {zoom ? (
        <div
          role="dialog"
          aria-label="Screenshot"
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/70 p-4"
          onClick={() => setZoom(null)}
        >
          <img src={zoom} alt="" className="max-h-full max-w-full rounded-lg shadow-2xl" />
          <button
            type="button"
            aria-label="Close"
            className="absolute top-4 right-4 rounded-full bg-black/50 p-1.5 text-white"
          >
            <XIcon className="size-5" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Row({ row }: { row: NeedsYouRow }) {
  switch (row.type) {
    case "approval":
      return <ApprovalRow row={row} thread={row.thread} />;
    case "question":
      return <QuestionRow row={row} thread={row.thread} />;
    case "ask-question":
      return <AskQuestionRow row={row} ask={row.ask} />;
    case "review":
      return <ReviewCard row={row} ask={row.ask} />;
    case "call":
      return <CallRow row={row} thread={row.thread} reason={row.reason} />;
    case "ready":
      return <ReadyRow row={row} thread={row.thread} />;
  }
}

function sectionMinutes(rows: ReadonlyArray<NeedsYouRow>): number {
  return rows.reduce((sum, row) => sum + MINUTES[row.type], 0);
}

function WithoutYou({
  working,
  waiting,
  line,
}: {
  working: ReadonlyArray<SidebarThreadSummary>;
  waiting: ReadonlyArray<SidebarThreadSummary>;
  line: string;
}) {
  const open = useOpenThread();
  const [expanded, setExpanded] = useState(false);
  const all = [
    ...working.map((thread) => ({ thread, waiting: false })),
    ...waiting.map((thread) => ({ thread, waiting: true })),
  ];
  return (
    <section
      className="rounded-2xl border border-border/60 bg-muted/30"
      data-testid="needs-you-quiet"
    >
      <button
        type="button"
        disabled={all.length === 0}
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-left text-sm text-muted-foreground disabled:cursor-default"
      >
        <SparklesIcon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{line}</span>
        {all.length > 0 ? (
          <ChevronDownIcon
            className={cn("size-4 shrink-0 transition-transform", expanded && "rotate-180")}
          />
        ) : null}
      </button>
      {expanded ? (
        <ul className="border-t border-border/60 py-1">
          {all.map(({ thread, waiting: isWaiting }) => (
            <li key={`${thread.environmentId}:${thread.id}`}>
              <button
                type="button"
                onClick={() => open(thread)}
                className="flex w-full cursor-pointer items-center gap-2 px-4 py-1.5 text-left text-sm hover:bg-accent/50"
              >
                {isWaiting ? (
                  <HourglassIcon className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <Spinner className="size-3.5 shrink-0 text-info" />
                )}
                <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {isWaiting ? "waiting on its tasks" : "working"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function NeedsYouView() {
  const board = useNeedsYouBoard();
  const verdict = needsYouVerdict(board);
  const quiet = quietLine(board);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        data-testid="needs-you-view"
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 sm:px-5">
          <SidebarShowButton />
          <BellRingIcon className="size-4 text-muted-foreground" />
          <h1 className="text-sm font-medium">Needs you</h1>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
            <div className="flex flex-col gap-1">
              <h2
                className={cn(
                  "flex items-center gap-2 text-xl font-semibold tracking-tight sm:text-2xl",
                  board.count === 0 && "text-success",
                )}
                data-testid="needs-you-verdict"
              >
                {board.count === 0 ? <CheckCheckIcon className="size-6 shrink-0" /> : null}
                {verdict}
              </h2>
              {board.count > 0 ? (
                <p className="text-sm text-muted-foreground">
                  Oldest first. Answer here; a chat opens only when it needs more than a tap.
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Nothing waits on you. Agents tell you here when they do.
                </p>
              )}
            </div>
            {board.sections.map(({ section, rows }) => (
              <section
                key={section}
                className={cn(
                  "flex flex-col rounded-2xl border",
                  section === "ready"
                    ? "border-border/50 bg-transparent"
                    : "border-border/70 bg-card/50",
                )}
                data-testid={`needs-you-section-${section}`}
              >
                <header className="flex items-center gap-2 px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground [&_svg]:size-3.5">
                  {SECTION_ICON[section]}
                  <span className="text-foreground">{SECTION_TITLE[section]}</span>
                  <span>· {rows.length}</span>
                  {section === "ready" ? (
                    <span className="ml-auto">nothing is stuck on you — read when you like</span>
                  ) : (
                    <span className="ml-auto">≈ {sectionMinutes(rows)} min</span>
                  )}
                </header>
                <div className="flex flex-col divide-y divide-border/50 pb-1">
                  {rows.map((row) => (
                    <Row key={row.key} row={row} />
                  ))}
                </div>
              </section>
            ))}
            <WithoutYou working={board.working} waiting={board.waitingOnAgents} line={quiet} />
            {board.answered > 0 ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <MessagesSquareIcon className="size-3.5" />
                {board.answered} answered here — the agents have it.
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
