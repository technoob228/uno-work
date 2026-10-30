/** One plan's limits: what each is, how much is used, when it resets. */
import type { PlanLimitsAccount, PlanLimitsWindow } from "@t3tools/contracts";

import { cn } from "../../../lib/utils";
import { ClaudeAI, OpenAI } from "../../Icons";
import {
  planAccountTitle,
  planHasNoLimits,
  planProblemText,
  planResetText,
  planStaleText,
  planUsageTone,
  planUsedPercent,
  planWindowTitle,
  type PlanUsageTone,
} from "./planLimitsModel";

const PLAN_TONE_CLASS: Record<PlanUsageTone, string> = {
  ok: "bg-sky-500",
  high: "bg-amber-500",
  full: "bg-destructive",
};

/** One limit: what it is and when it resets, then a bar with the percent used. */
function PlanLimitRow({
  window,
  now,
  scoped,
}: {
  window: PlanLimitsWindow;
  now: number;
  scoped: boolean;
}) {
  const percent = planUsedPercent(window);
  const reset = planResetText(window.resetsAt, now);
  return (
    <div className="flex flex-col gap-1" data-testid={`home-plan-limit-${window.id}`}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className={cn("truncate", scoped ? "text-muted-foreground" : "font-medium")}>
          {planWindowTitle(window)}
        </span>
        {reset ? <span className="shrink-0 text-[11px] text-muted-foreground">{reset}</span> : null}
      </div>
      <div className="flex items-center gap-2">
        <div
          className={cn("w-full overflow-hidden rounded-full bg-muted", scoped ? "h-1" : "h-1.5")}
        >
          <div
            className={cn("h-full rounded-full", PLAN_TONE_CLASS[planUsageTone(window)])}
            style={{ width: `${Math.max(2, percent)}%` }}
          />
        </div>
        <span className="w-16 shrink-0 whitespace-nowrap text-right text-[11px] tabular-nums text-muted-foreground">
          {percent}% used
        </span>
      </div>
    </div>
  );
}

export function PlanLimitsAccountBlock({
  account,
  now,
}: {
  account: PlanLimitsAccount;
  now: number;
}) {
  const Icon = account.provider === "claude" ? ClaudeAI : OpenAI;
  const stale = planStaleText(account, now);
  const problem = planProblemText(account);
  const note = [stale, problem].filter(Boolean).join(". ");
  return (
    <section className="flex flex-col gap-2" data-testid={`home-plan-account-${account.provider}`}>
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="shrink-0 text-sm font-medium">{planAccountTitle(account)}</span>
        {account.email ? (
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            {account.email}
          </span>
        ) : null}
      </div>
      {account.windows.length > 0 ? (
        <div className={cn("flex flex-col gap-2", account.stale && "opacity-60")}>
          {account.windows.map((window) => (
            <PlanLimitRow
              key={window.id}
              window={window}
              now={now}
              scoped={window.scope !== undefined}
            />
          ))}
        </div>
      ) : null}
      {planHasNoLimits(account) ? (
        <p className="text-xs text-muted-foreground">No usage limits to show for this plan.</p>
      ) : note ? (
        <p className="text-xs text-muted-foreground">{note}</p>
      ) : null}
    </section>
  );
}
