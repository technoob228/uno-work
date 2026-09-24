/**
 * Step 3 — "Tell your AI how you work": four questions, a live AGENTS.md
 * next to them, and a real file at the end. AGENTS.md is what every agent
 * here reads first (Codex and OpenCode natively; Claude through the
 * workspace instructions). The daemon's own instructions reach the project
 * through a pointer block in the same file (Settings → Workspace → "Write to
 * project"); an existing block is kept when the file is written again.
 */
import { ArrowUpIcon, FileTextIcon, PencilIcon, SparklesIcon } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { ensureEnvironmentApi } from "../../../environmentApi";
import { usePrimaryEnvironmentId } from "../../../environments/primary";
import { useHomeFolderPath } from "../../../hooks/useFolderChats";
import { cn } from "../../../lib/utils";
import { UnoIcon } from "../../Icons";
import { Textarea } from "../../ui/textarea";
import {
  AGENTS_MD_WAITING,
  NO_PREFERENCE,
  SETUP_QUESTIONS,
  buildAgentsMd,
  mergeAgentsMd,
  nextQuestionIndex,
  parseWorkKind,
  tildePath,
} from "../setupModel";
import { SetupHeading, SetupShell } from "../SetupShell";
import { useSetupNavigation } from "../useSetupNavigation";
import { useSetupProgress, useUpdateSetupProgress } from "../useSetupProgress";

function inline(text: string): ReactNode {
  const parts = text.split(/(`[^`]+`|_[^_]+_)/g);
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      return (
        <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("_") && part.endsWith("_") && part.length > 1) {
      return (
        <span key={index} className="text-muted-foreground/70">
          {part.slice(1, -1)}
        </span>
      );
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}

/** Just enough markdown for the preview: `#`, `##`, `- `, paragraphs, code, _placeholder_. */
function MarkdownPreview({ source, flash }: { source: string; flash: string | null }) {
  const sections = source.split(/\n(?=## )/);
  return (
    <div className="flex flex-col gap-1 text-sm leading-relaxed">
      {sections.map((section, index) => {
        const lines = section.split("\n");
        const title = lines.find((line) => line.startsWith("## "))?.slice(3) ?? null;
        const items: ReactNode[] = [];
        let list: string[] = [];
        const flush = () => {
          if (list.length === 0) return;
          items.push(
            <ul key={`ul-${items.length}`} className="ml-5 list-disc">
              {list.map((item, k) => (
                <li key={k}>{inline(item)}</li>
              ))}
            </ul>,
          );
          list = [];
        };
        for (const line of lines) {
          if (line.startsWith("# ")) {
            flush();
            items.push(
              <h1 key={`h1-${items.length}`} className="mb-2 text-lg font-semibold">
                {inline(line.slice(2))}
              </h1>,
            );
          } else if (line.startsWith("## ")) {
            flush();
            items.push(
              <h2 key={`h2-${items.length}`} className="mt-2 font-semibold">
                {inline(line.slice(3))}
              </h2>,
            );
          } else if (line.startsWith("- ")) {
            list.push(line.slice(2));
          } else if (line.trim()) {
            flush();
            items.push(<p key={`p-${items.length}`}>{inline(line)}</p>);
          }
        }
        flush();
        return (
          <div
            key={index}
            className={cn(
              "rounded-lg px-2 py-1.5 transition-colors duration-700",
              title !== null && flash === title ? "bg-primary/10" : "bg-transparent",
            )}
          >
            {items}
          </div>
        );
      })}
    </div>
  );
}

const SECTION_OF_QUESTION: Readonly<Record<string, string>> = {
  who: "About me",
  what: "This project",
  how: "How to answer",
  never: "Never",
};

export function InstructionsStep() {
  const environmentId = usePrimaryEnvironmentId();
  const home = useHomeFolderPath(environmentId);
  const progress = useSetupProgress();
  const update = useUpdateSetupProgress();
  const { completeStep } = useSetupNavigation();
  const project = progress.project;
  const folder = project?.path ?? home;
  const answers = progress.answers;
  const questionIndex = nextQuestionIndex(answers);
  const question = questionIndex >= 0 ? SETUP_QUESTIONS[questionIndex] : undefined;
  const kind = parseWorkKind(project?.kind);
  const projectName = project?.name ?? "Home folder";

  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<"preview" | "edit">("preview");
  const [custom, setCustom] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const displayFolder = folder ? tildePath(folder, home) : "~";
  const generated = useMemo(
    () => buildAgentsMd({ answers, projectName, projectFolder: displayFolder, kind, final: false }),
    [answers, displayFolder, kind, projectName],
  );
  const source = custom ?? generated;

  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), 900);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const answer = (raw: string) => {
    const value = raw.trim();
    if (!value || !question) return;
    setDraft("");
    setFlash(SECTION_OF_QUESTION[question.id] ?? null);
    void update((current) => ({
      ...current,
      answers: { ...current.answers, [question.id]: value },
    }));
    if (questionIndex < SETUP_QUESTIONS.length - 1) {
      setTyping(true);
      window.setTimeout(() => {
        setTyping(false);
        inputRef.current?.focus({ preventScroll: true });
      }, 520);
    }
  };

  const clearAnswer = (id: string) => {
    void update((current) => {
      const { [id]: _removed, ...rest } = current.answers;
      return { ...current, answers: rest };
    });
  };

  const anyAnswer = Object.keys(answers).length > 0;
  const allAnswered = questionIndex === -1;

  const save = async () => {
    if (!anyAnswer && custom === null) {
      await completeStep("instructions");
      return;
    }
    if (!environmentId || !folder) {
      setError("Couldn't reach this computer. Give it a moment and try again.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const api = ensureEnvironmentApi(environmentId);
      const existing = await api.filesystem
        .readFile({ path: `${folder}/AGENTS.md` })
        .then((result) => (result.encoding === "utf8" ? result.content : null))
        .catch(() => null);
      const text =
        custom ??
        buildAgentsMd({ answers, projectName, projectFolder: displayFolder, kind, final: true });
      await api.projects.writeFile({
        cwd: folder,
        relativePath: "AGENTS.md",
        contents: mergeAgentsMd(existing, text.replaceAll(AGENTS_MD_WAITING, "").trimEnd() + "\n"),
        encoding: "utf8",
      });
      await completeStep("instructions");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't save AGENTS.md.");
    } finally {
      setPending(false);
    }
  };

  return (
    <SetupShell
      step="instructions"
      wide
      primary={{
        label: allAnswered || custom !== null ? "Save AGENTS.md" : "Continue",
        onClick: () => void save(),
        pending,
      }}
    >
      <SetupHeading
        title="Tell your AI how you work"
        lead={
          <>
            Four quick questions. Your answers become <b className="text-foreground">AGENTS.md</b>,
            the note your AI reads before every task.
          </>
        }
      />
      <div className="grid items-start gap-6 lg:grid-cols-[1fr_1fr]">
        <div className="flex flex-col gap-3" data-testid="setup-interview">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <UnoIcon className="size-4" />
            Uno AI
          </div>
          {SETUP_QUESTIONS.map((entry, index) => {
            if (questionIndex !== -1 && index > questionIndex) return null;
            const hidden = typing && index === questionIndex;
            const reply = answers[entry.id];
            return (
              <Fragment key={entry.id}>
                {hidden ? null : (
                  <div className="max-w-[85%] self-start rounded-2xl rounded-tl-md bg-muted px-3.5 py-2.5 text-sm">
                    {entry.question(projectName)}
                  </div>
                )}
                {reply ? (
                  <div className="group flex max-w-[85%] items-center gap-2 self-end">
                    <button
                      type="button"
                      aria-label="Change answer"
                      onClick={() => clearAnswer(entry.id)}
                      className="rounded-md p-1 text-muted-foreground opacity-60 hover:bg-muted hover:opacity-100"
                    >
                      <PencilIcon className="size-3" />
                    </button>
                    <div className="rounded-2xl rounded-tr-md border border-border bg-background px-3.5 py-2.5 text-sm">
                      {reply}
                    </div>
                  </div>
                ) : null}
              </Fragment>
            );
          })}
          {typing ? (
            <div
              className="flex w-fit gap-1 rounded-2xl rounded-tl-md bg-muted px-3.5 py-3"
              aria-label="Typing"
            >
              {[0, 1, 2].map((dot) => (
                <span
                  key={dot}
                  className="size-1.5 animate-pulse rounded-full bg-muted-foreground/60"
                  style={{ animationDelay: `${dot * 150}ms` }}
                />
              ))}
            </div>
          ) : null}
          {question ? (
            <>
              <div className="rounded-2xl border border-primary/40 bg-background p-2.5 shadow-xs">
                <div className="flex items-center gap-2">
                  <input
                    ref={inputRef}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") answer(draft);
                    }}
                    placeholder={question.placeholder}
                    aria-label={question.question(projectName)}
                    className="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-sm outline-hidden placeholder:text-muted-foreground/70"
                    autoComplete="off"
                    data-testid="setup-answer"
                  />
                  <button
                    type="button"
                    aria-label="Send"
                    onClick={() => answer(draft)}
                    className="flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"
                    disabled={draft.trim().length === 0}
                  >
                    <ArrowUpIcon className="size-3.5" />
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {question.chips(kind).map((chip) => (
                    <button
                      key={chip}
                      type="button"
                      onClick={() => answer(chip)}
                      className="rounded-full border border-border px-3 py-1 text-sm hover:bg-muted/60"
                    >
                      {chip}
                    </button>
                  ))}
                </div>
              </div>
              <div className="text-xs text-muted-foreground">
                Question {questionIndex + 1} of {SETUP_QUESTIONS.length} ·{" "}
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => answer(NO_PREFERENCE)}
                >
                  Skip question
                </button>
              </div>
            </>
          ) : (
            <div className="max-w-[85%] self-start rounded-2xl rounded-tl-md bg-muted px-3.5 py-2.5 text-sm">
              Done. I read this file before every task. It’s a normal file in your project, so
              change it any time — here or in Files.
            </div>
          )}
        </div>
        <div className="flex min-h-[420px] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-xs">
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <FileTextIcon className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">AGENTS.md</span>
            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
              {displayFolder}/
            </span>
            <div role="tablist" className="ml-auto flex rounded-lg bg-muted/60 p-0.5">
              {(["preview", "edit"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={tab === value}
                  onClick={() => setTab(value)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium capitalize",
                    tab === value
                      ? "bg-background text-foreground shadow-xs"
                      : "text-muted-foreground",
                  )}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 p-4" data-testid="setup-agents-md">
            {tab === "edit" ? (
              <Textarea
                className="h-full min-h-[340px] font-mono text-xs"
                value={source}
                spellCheck={false}
                onChange={(event) => setCustom(event.target.value)}
                aria-label="AGENTS.md"
              />
            ) : (
              <MarkdownPreview source={source} flash={flash} />
            )}
          </div>
          <div className="flex items-center gap-1.5 border-t border-border px-4 py-2 text-xs text-muted-foreground">
            {custom !== null ? (
              <>
                <PencilIcon className="size-3" />
                Edited by hand ·
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => setCustom(null)}
                >
                  Rebuild from answers
                </button>
              </>
            ) : (
              <>
                <SparklesIcon className="size-3" />
                Written from your answers · edit anything
              </>
            )}
          </div>
        </div>
      </div>
      {error ? <p className="mt-4 text-sm text-destructive-foreground">{error}</p> : null}
    </SetupShell>
  );
}
