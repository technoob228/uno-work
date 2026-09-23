import { BotIcon, CheckIcon, MessageSquareIcon, TerminalSquareIcon } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { thisDeviceWords } from "../onboardingPath";
import type { OnboardingFlow, OnboardingPath } from "../useOnboardingState";

interface PathOption {
  readonly id: OnboardingPath;
  readonly title: string;
  readonly icon: ReactNode;
  readonly description: string;
  readonly note?: string;
}

function pathOptions(flow: OnboardingFlow): ReadonlyArray<PathOption> {
  return [
    {
      id: "work",
      title: "In Uno Work",
      icon: <MessageSquareIcon className="size-5" />,
      description:
        flow === "web"
          ? "Work on this computer through its screen: chat with AI, files, office, apps."
          : `Chat with AI agents, files and apps — on ${thisDeviceWords()}, and on a cloud computer when you want one.`,
    },
    {
      id: "agent",
      title: "With my own AI agent",
      icon: <BotIcon className="size-4.5" />,
      description:
        "Give Claude, ChatGPT, Claude Code or Cursor a computer. Your agent creates servers, sites and storage for you.",
      note: "Just handing a server to your Claude is a perfectly normal way to use Uno.",
    },
    {
      id: "ssh",
      title: "Over SSH",
      icon: <TerminalSquareIcon className="size-4.5" />,
      description:
        "A clean Linux computer with root and your own key. For people who live in a terminal.",
    },
  ];
}

const ORDER: ReadonlyArray<OnboardingPath> = ["work", "agent", "ssh"];

function SelectedMark({ selected }: { selected: boolean }) {
  return (
    <span
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-full border transition",
        selected ? "border-primary bg-primary text-primary-foreground" : "border-border",
      )}
      aria-hidden
    >
      {selected ? <CheckIcon className="size-3" strokeWidth={3} /> : null}
    </span>
  );
}

/**
 * First onboarding screen: how the person wants to use Uno. Three equal doors,
 * one visually primary and pre-selected. The choice only decides which screen
 * comes next — every computer still opens in Uno Work, over SSH or by an agent.
 */
export function PathStep({
  flow,
  value,
  onChange,
  onConfirm,
}: {
  flow: OnboardingFlow;
  value: OnboardingPath;
  onChange: (path: OnboardingPath) => void;
  /** Double-click / Enter on a card: pick it and go on. */
  onConfirm: () => void;
}) {
  const options = pathOptions(flow);
  const [primary, ...secondary] = options;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? -1
          : 0;
    if (delta === 0) return;
    event.preventDefault();
    const index = ORDER.indexOf(value);
    const nextPath = ORDER[(index + delta + ORDER.length) % ORDER.length] ?? "work";
    onChange(nextPath);
    const target = event.currentTarget.querySelector<HTMLElement>(`[data-path="${nextPath}"]`);
    target?.focus();
  };

  const cardProps = (option: PathOption) => {
    const selected = value === option.id;
    return {
      type: "button" as const,
      role: "radio" as const,
      "aria-checked": selected,
      "data-path": option.id,
      tabIndex: selected ? 0 : -1,
      onClick: () => onChange(option.id),
      onDoubleClick: () => {
        onChange(option.id);
        onConfirm();
      },
    };
  };

  return (
    <div className="m-auto flex w-full max-w-2xl flex-col items-center gap-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <img
          src="/uno-mark.svg"
          alt=""
          className="size-14 rounded-2xl shadow-lg shadow-primary/20"
          onError={(event) => {
            (event.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
        <div className="mt-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-primary">
          Welcome to Uno
        </div>
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          How do you want to use Uno?
        </h1>
      </div>

      <div
        role="radiogroup"
        aria-label="How do you want to use Uno?"
        className="flex w-full flex-col gap-3"
        onKeyDown={onKeyDown}
      >
        {primary ? (
          <button
            {...cardProps(primary)}
            className={cn(
              "flex w-full items-start gap-4 rounded-2xl border p-5 text-left transition outline-none focus-visible:ring-2 focus-visible:ring-ring",
              value === primary.id
                ? "border-primary bg-primary/5 shadow-sm shadow-primary/10"
                : "border-border bg-card hover:border-primary/50",
            )}
          >
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              {primary.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-base font-semibold">{primary.title}</span>
                <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                  Recommended
                </span>
              </span>
              <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">
                {primary.description}
              </span>
            </span>
            <SelectedMark selected={value === primary.id} />
          </button>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          {secondary.map((option) => {
            const selected = value === option.id;
            return (
              <button
                key={option.id}
                {...cardProps(option)}
                className={cn(
                  "flex w-full flex-col gap-2 rounded-2xl border p-4 text-left transition outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected
                    ? "border-primary bg-primary/5"
                    : "border-border bg-card hover:border-primary/50",
                )}
              >
                <span className="flex items-center gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    {option.icon}
                  </span>
                  <span className="flex-1 text-sm font-semibold">{option.title}</span>
                  <SelectedMark selected={selected} />
                </span>
                <span className="text-sm leading-relaxed text-muted-foreground">
                  {option.description}
                </span>
                {option.note ? (
                  <span className="text-xs leading-relaxed text-muted-foreground/80 italic">
                    {option.note}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <p className="max-w-xl text-center text-xs leading-relaxed text-muted-foreground/80">
        This doesn&apos;t lock you in. You can open this computer in Uno Work, over SSH, or give it
        to your agent — any time.
      </p>
    </div>
  );
}
