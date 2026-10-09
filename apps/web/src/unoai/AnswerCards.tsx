/**
 * Uno's question with answers to tap — drawn like the uno.place chat
 * (assets/chat.js choicesEl): answer cards in two columns (a colored icon,
 * the words, a line under them, a chevron), a tap sends the answer at once,
 * "Or answer in your own words" puts the cursor in the box below. Uno AI adds
 * its two answers of its own: "You decide" and "Just build it" (icp3 09.10,
 * n2/3: "make it work like the onboarding on the landing").
 */
import {
  AppWindowIcon,
  BotIcon,
  CalendarIcon,
  ChevronRightIcon,
  CircleDollarSignIcon,
  ClipboardListIcon,
  ClockIcon,
  CodeIcon,
  DatabaseIcon,
  FolderIcon,
  GlobeIcon,
  HammerIcon,
  LayoutGridIcon,
  LockIcon,
  MailIcon,
  MessageSquareIcon,
  PencilIcon,
  SendIcon,
  ServerIcon,
  SparklesIcon,
  StoreIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";

import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { chatLanguage, standardAnswers, type AiChoiceIcon, type AiQuestion } from "./unoAiModel";

const ICONS: Readonly<Record<AiChoiceIcon, LucideIcon>> = {
  site: AppWindowIcon,
  bot: BotIcon,
  agent: SparklesIcon,
  team: UsersIcon,
  code: CodeIcon,
  server: ServerIcon,
  db: DatabaseIcon,
  form: ClipboardListIcon,
  lock: LockIcon,
  telegram: SendIcon,
  mail: MailIcon,
  calendar: CalendarIcon,
  money: CircleDollarSignIcon,
  clock: ClockIcon,
  chat: MessageSquareIcon,
  store: StoreIcon,
  spark: SparklesIcon,
  folder: FolderIcon,
  apps: LayoutGridIcon,
  globe: GlobeIcon,
  users: UsersIcon,
  edit: PencilIcon,
};

/** The landing's icon colors (chat.css .ico-*), as tints that also work in dark mode. */
const TINT: Readonly<Record<AiChoiceIcon, string>> = {
  telegram: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  bot: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  chat: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  users: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  agent: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  clock: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  calendar: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  team: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  money: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  store: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  apps: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  code: "bg-muted text-foreground",
  lock: "bg-muted text-foreground",
  server: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  db: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  folder: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  mail: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  edit: "bg-pink-500/10 text-pink-600 dark:text-pink-400",
  spark: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
  globe: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
  form: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
  site: "bg-primary/10 text-primary",
};

export function AnswerCards({
  question,
  onAnswer,
  onOwnWords,
}: {
  question: AiQuestion;
  onAnswer: (answer: string) => void;
  /** "Or answer in your own words": focus the message box (sends nothing). */
  onOwnWords: () => void;
}) {
  const std = standardAnswers(chatLanguage(question.question));
  return (
    <div className="flex flex-col items-start gap-2.5" data-testid="uno-ai-answers">
      <div
        role="group"
        aria-label="Suggested answers"
        className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2"
      >
        {question.choices.map((c) => {
          const Icon = c.icon ? ICONS[c.icon] : null;
          const recommended = c.label === question.recommended;
          return (
            <button
              key={c.label}
              type="button"
              onClick={() => onAnswer(c.label)}
              className={cn(
                "group flex min-w-0 items-center gap-3 rounded-[14px] border bg-card py-2.5 ps-2.5 pe-3 text-left transition-[border-color,background-color,box-shadow,transform]",
                "hover:border-primary/40 hover:bg-primary/[0.03] hover:shadow-[0_10px_22px_-16px] hover:shadow-primary/50 active:translate-y-px",
                recommended ? "border-primary/40" : "border-border",
              )}
              data-testid="uno-ai-answer"
              data-recommended={recommended ? "1" : undefined}
            >
              {Icon && c.icon ? (
                <span
                  className={cn(
                    "grid size-[34px] shrink-0 place-items-center rounded-[10px]",
                    TINT[c.icon],
                  )}
                  aria-hidden
                >
                  <Icon className="size-[19px]" strokeWidth={1.8} />
                </span>
              ) : null}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm leading-snug font-semibold text-foreground">
                  {c.label}
                  {recommended ? (
                    <span className="ms-2 inline-block rounded-full bg-primary/10 px-[7px] py-0.5 align-[1px] text-[11px] font-semibold text-primary">
                      {std.recommended}
                    </span>
                  ) : null}
                </span>
                {c.hint ? (
                  <span className="text-[13px] leading-snug text-muted-foreground">{c.hint}</span>
                ) : null}
              </span>
              <ChevronRightIcon
                className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
                strokeWidth={1.9}
                aria-hidden
              />
            </button>
          );
        })}
      </div>
      <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          onClick={onOwnWords}
          className="inline-flex items-center gap-1.5 rounded-md px-0.5 py-1 text-[13.5px] text-muted-foreground transition-colors hover:text-primary"
          data-testid="uno-ai-own-words"
        >
          <PencilIcon className="size-3.5" strokeWidth={1.9} />
          {std.ownWords}
        </button>
        <span className="flex flex-wrap items-center gap-2 sm:ms-auto">
          <Button
            size="xs"
            variant="outline"
            onClick={() => onAnswer(std.youDecide)}
            data-testid="uno-ai-you-decide"
          >
            <SparklesIcon className="text-primary" />
            {std.youDecide}
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() => onAnswer(std.justBuild)}
            data-testid="uno-ai-just-build"
          >
            <HammerIcon />
            {std.justBuild}
          </Button>
        </span>
      </div>
    </div>
  );
}
