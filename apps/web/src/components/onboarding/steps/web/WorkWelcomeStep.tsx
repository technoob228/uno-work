/**
 * The browser's first screen: this is your computer, and two ways to use
 * it — just a computer (a short tour) or a computer with AI (the guided
 * setup, `/setup`). People who'd rather use their own agent or plain SSH get
 * a door to that too. Every fact on the card comes from the daemon.
 */
import { LaptopIcon, SparklesIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useServerConfig } from "~/rpc/serverState";
import { describeConnectedMachine } from "./connectedMachine";

export type WelcomeMode = "simple" | "ai";

function Choice({
  selected,
  onSelect,
  onConfirm,
  icon,
  title,
  badge,
  description,
  testId,
}: {
  selected: boolean;
  onSelect: () => void;
  onConfirm: () => void;
  icon: ReactNode;
  title: string;
  badge?: string;
  description: string;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      onDoubleClick={onConfirm}
      data-testid={testId}
      className={cn(
        "flex w-full items-start gap-4 rounded-2xl border p-4 text-left transition-colors sm:p-5",
        selected
          ? "border-primary bg-primary/[0.04] ring-1 ring-primary/40"
          : "border-border hover:bg-muted/40",
      )}
    >
      <span
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-xl",
          selected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2 font-medium">
          {title}
          {badge ? (
            <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
              {badge}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block text-sm leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
      <span
        aria-hidden
        className={cn(
          "mt-1 flex size-[18px] shrink-0 items-center justify-center rounded-full border-2",
          selected ? "border-primary" : "border-border",
        )}
      >
        {selected ? <span className="size-2 rounded-full bg-primary" /> : null}
      </span>
    </button>
  );
}

export function WorkWelcomeStep({
  mode,
  onModeChange,
  onConfirm,
  onOwnTools,
}: {
  mode: WelcomeMode;
  onModeChange: (mode: WelcomeMode) => void;
  onConfirm: (mode: WelcomeMode) => void;
  onOwnTools: (tab: "agent" | "ssh") => void;
}) {
  const serverConfig = useServerConfig();
  const machine = describeConnectedMachine(serverConfig);
  const connected = serverConfig !== null;
  const isUnoBox = serverConfig?.environment.machineKind === "uno_box";

  return (
    <div className="m-auto flex w-full max-w-xl flex-col items-center gap-6 text-center">
      <img
        src="/uno-mark.svg"
        alt="Uno Work"
        className="size-14 rounded-2xl shadow-lg shadow-primary/20"
      />
      <div className="flex flex-col items-center gap-3">
        <h1 className="text-4xl font-semibold tracking-tight">This is your computer</h1>
        <p className="max-w-lg text-base leading-relaxed text-muted-foreground">
          {isUnoBox
            ? "Your own computer in the cloud, always online. Your files, apps and AI live here; this tab is just its screen."
            : "A real computer with your files, apps and AI. It runs on its own hardware; this tab is just its screen."}
        </p>
        <span className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
          <span
            aria-hidden
            className={cn(
              "size-1.5 rounded-full",
              connected ? "bg-success" : "animate-pulse bg-yellow-500",
            )}
          />
          {machine.label} · {isUnoBox ? "Cloud computer" : "Computer"} ·{" "}
          {connected ? "On" : "Waking up…"}
        </span>
      </div>
      <div className="w-full text-left">
        <p className="mb-3 text-sm font-medium">How do you want to use it?</p>
        <div
          role="radiogroup"
          aria-label="How do you want to use it?"
          className="flex flex-col gap-3"
        >
          <Choice
            testId="welcome-simple"
            selected={mode === "simple"}
            onSelect={() => onModeChange("simple")}
            onConfirm={() => onConfirm("simple")}
            icon={<LaptopIcon className="size-5" />}
            title="Just a computer"
            description="Files, Office and apps. A short tour, no AI setup."
          />
          <Choice
            testId="welcome-ai"
            selected={mode === "ai"}
            onSelect={() => onModeChange("ai")}
            onConfirm={() => onConfirm("ai")}
            icon={<SparklesIcon className="size-5" />}
            title="A computer with AI"
            badge="Recommended"
            description="An AI that works in your projects, knows your tools and answers in Telegram or Slack. About 5 minutes."
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Prefer your own tools?{" "}
        <button
          type="button"
          className="text-primary underline-offset-4 hover:underline"
          onClick={() => onOwnTools("agent")}
        >
          Give this computer to your AI agent
        </button>{" "}
        or{" "}
        <button
          type="button"
          className="text-primary underline-offset-4 hover:underline"
          onClick={() => onOwnTools("ssh")}
        >
          just use SSH
        </button>
        .
      </p>
    </div>
  );
}
