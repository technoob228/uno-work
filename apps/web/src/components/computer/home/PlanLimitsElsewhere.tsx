/**
 * Under Home's "AI plan limits" (one computer): the plans signed in on the
 * person's OTHER computers, one line each — so "Claude here is full" is read
 * next to "Claude Pro on MacBook · 65% left" (T3 port 30.10, upstream's
 * pooled Limits b273d1cfe9 in a sentence). The same account as here is not
 * repeated. Nothing when there are no other plans.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { memo } from "react";

import { cn } from "../../../lib/utils";
import { planAccountName, planUntilText, poolPlans } from "../../../planRoom/planRoom.logic";
import { usePlanComputers } from "../../../planRoom/usePlanComputers";

export const PlanLimitsElsewhere = memo(function PlanLimitsElsewhere({
  environmentId,
  now,
}: {
  environmentId: EnvironmentId | null;
  now: number;
}) {
  const { computers } = usePlanComputers();
  const here = computers.find((computer) => computer.environmentId === environmentId);
  const hereIds = new Set((here?.accounts ?? []).map((account) => account.id));
  const others = poolPlans(
    computers.filter((computer) => computer.environmentId !== environmentId),
    now,
  ).flatMap((plan) =>
    plan.accounts.filter(
      (entry) => !hereIds.has(entry.account.id) || entry.account.id.endsWith(":default"),
    ),
  );
  if (others.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 border-t pt-3" data-testid="home-plan-limits-elsewhere">
      <span className="text-[11px] font-medium text-muted-foreground">On your other computers</span>
      {others.map((entry) => {
        const until = entry.hit ? planUntilText(entry.hit.resetsAt, now) : null;
        return (
          <div
            key={`${entry.account.id}:${entry.computers[0]?.environmentId ?? ""}`}
            className="flex min-w-0 items-baseline justify-between gap-2 text-xs"
          >
            <span className="min-w-0 truncate">
              {planAccountName(entry.account)}
              <span className="text-muted-foreground">
                {" "}
                on {entry.computers.map((computer) => computer.name).join(", ")}
              </span>
            </span>
            <span
              className={cn(
                "shrink-0 text-[11px] tabular-nums",
                entry.hit ? "font-medium text-warning" : "text-muted-foreground",
              )}
            >
              {entry.hit
                ? until
                  ? `Full until ${until}`
                  : "Full"
                : entry.roomPercent === null
                  ? "—"
                  : `${entry.roomPercent}% left`}
            </span>
          </div>
        );
      })}
    </div>
  );
});
