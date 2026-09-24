/**
 * What Test connection found, for the Harnesses screen and the Add dialog.
 *
 * @module components/settings/HarnessTestResult
 */
import type { CustomHarnessTestResult } from "@t3tools/contracts";
import { CheckCircle2Icon, LoaderIcon, XCircleIcon } from "lucide-react";

import { cn } from "../../lib/utils";

const STAGE_LABEL: Record<CustomHarnessTestResult["stage"], string> = {
  validate: "checking the settings",
  spawn: "starting the program",
  initialize: "the ACP handshake (initialize)",
  authenticate: "authenticate",
  session: "creating a session (session/new)",
  prompt: "the test prompt",
  done: "done",
};

export function HarnessTestRunning() {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      <LoaderIcon className="size-3.5 animate-spin" />
      Starting the agent and asking it to reply with OK…
    </div>
  );
}

export function HarnessTestResultView({ result }: { readonly result: CustomHarnessTestResult }) {
  const facts = [
    result.agentName
      ? `${result.agentName}${result.agentVersion ? ` ${result.agentVersion}` : ""}`
      : null,
    result.protocolVersion !== undefined ? `ACP v${result.protocolVersion}` : null,
    result.loadSession ? "resumes chats" : null,
    result.images ? "accepts images" : null,
    result.mcpHttp ? "HTTP MCP" : null,
    result.models.length > 0 ? `${result.models.length} models` : null,
    `${(result.durationMs / 1000).toFixed(1)} s`,
  ].filter((fact): fact is string => fact !== null);

  return (
    <div
      className={cn(
        "space-y-2 rounded-lg border px-3 py-2.5 text-xs",
        result.ok
          ? "border-emerald-500/30 bg-emerald-500/5"
          : "border-destructive/30 bg-destructive/5",
      )}
      data-testid="harness-test-result"
    >
      <div className="flex items-start gap-2">
        {result.ok ? (
          <CheckCircle2Icon className="mt-px size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <XCircleIcon className="mt-px size-4 shrink-0 text-destructive" />
        )}
        <div className="min-w-0 space-y-1">
          <p className="font-medium text-foreground">
            {result.ok
              ? "Connected — the agent answered."
              : `Failed at ${STAGE_LABEL[result.stage]}.`}
          </p>
          {result.error ? (
            <p className="whitespace-pre-wrap break-words text-muted-foreground">{result.error}</p>
          ) : null}
          <p className="text-muted-foreground">{facts.join(" · ")}</p>
        </div>
      </div>
      {result.reply ? (
        <div className="rounded-md bg-background/70 px-2.5 py-1.5">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Reply
          </span>
          <p className="line-clamp-4 whitespace-pre-wrap break-words text-foreground">
            {result.reply}
          </p>
        </div>
      ) : null}
      {result.permissionRequested ? (
        <p className="text-muted-foreground">
          The agent asked for permission during the test — it was denied, as tests never allow
          changes.
        </p>
      ) : null}
      {result.stderr ? (
        <details className="group">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Agent log (stderr)
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background/70 p-2 font-mono text-[11px] text-muted-foreground">
            {result.stderr}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
