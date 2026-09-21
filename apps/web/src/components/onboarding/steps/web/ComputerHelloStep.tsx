import { ArrowRight, Monitor } from "lucide-react";

import { useServerConfig } from "~/rpc/serverState";
import { cn } from "~/lib/utils";
import { describeConnectedMachine, machineKindLabel } from "./connectedMachine";

function FactRow({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("truncate", mono && "font-mono text-xs")} title={value}>
        {value}
      </dd>
    </div>
  );
}

/**
 * First onboarding screen in the browser: the machine behind this tab,
 * introduced as the user's own computer. Every fact on the card comes from the
 * daemon's own descriptor — nothing is invented, and rows the daemon does not
 * report are omitted rather than faked.
 */
export function ComputerHelloStep({
  onOpenComputer,
}: {
  /** Leaves onboarding for the computer's own screen (monitor, apps, activity). */
  onOpenComputer?: () => void;
} = {}) {
  const serverConfig = useServerConfig();
  const machine = describeConnectedMachine(serverConfig);
  const kindLabel = machineKindLabel(serverConfig?.environment.machineKind);
  const connected = serverConfig !== null;
  const isUnoBox = serverConfig?.environment.machineKind === "uno_box";

  return (
    <div className="m-auto flex w-full max-w-2xl flex-col items-center gap-8 text-center">
      <img
        src="/uno-mark.svg"
        alt="Uno Work"
        className="size-16 rounded-2xl shadow-lg shadow-primary/20"
      />

      <div className="flex flex-col items-center gap-3">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">This is your computer</h1>
        <p className="max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
          A real machine with files, a terminal, and an AI that works for you.
          {isUnoBox
            ? " It lives in the Uno cloud and stays on around the clock — this tab is just its screen."
            : " It runs on its own hardware, not in this tab — the tab is just its screen."}
        </p>
      </div>

      <div className="w-full max-w-md rounded-2xl border border-border bg-muted/30 p-6 text-left">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "size-2 rounded-full",
              connected ? "bg-green-500" : "animate-pulse bg-yellow-500",
            )}
            aria-hidden
          />
          <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {connected ? "On and connected" : "Waking up…"}
          </span>
        </div>
        <div className="mt-2 truncate text-lg font-semibold">{machine.label}</div>
        <dl className="mt-5 flex flex-col gap-2.5 text-sm">
          {kindLabel ? <FactRow label="Kind" value={kindLabel} mono={false} /> : null}
          <FactRow label="System" value={machine.platformLabel} />
          {machine.workingDirectory ? (
            <FactRow label="Home folder" value={machine.workingDirectory} />
          ) : null}
          {machine.serverVersion ? (
            <FactRow label="Uno Work version" value={machine.serverVersion} />
          ) : null}
        </dl>
        {isUnoBox && onOpenComputer ? (
          <button
            type="button"
            onClick={onOpenComputer}
            className="mt-5 flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left text-sm transition hover:border-primary/50 hover:bg-primary/5"
          >
            <span className="flex items-center gap-3">
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Monitor className="size-4" />
              </span>
              <span>
                <span className="block font-medium">Look inside this computer</span>
                <span className="block text-xs text-muted-foreground">
                  Its monitor, apps and what it&apos;s doing right now
                </span>
              </span>
            </span>
            <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
