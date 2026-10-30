/**
 * Settings → AI → "Your AI plans" (T3 port 30.10; upstream's Usage → Limits,
 * 19d8ab2ae9 #9507, pooled across accounts and environments b273d1cfe9
 * #10300): every Claude / ChatGPT plan the person is signed in to on any of
 * their computers, once per account, with where it's signed in, the room
 * left now and when a full one comes back — plus what a new chat does when
 * the plan on its computer is at its limit.
 *
 * Home's "AI plan limits" widget stays the detailed view of one computer.
 */
import { memo } from "react";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useMinuteClock } from "../../hooks/useMinuteClock";
import { cn } from "../../lib/utils";
import {
  PLAN_PROVIDER_NAME,
  planAccountName,
  planUntilText,
  poolPlans,
  type PooledPlan,
} from "../../planRoom/planRoom.logic";
import { usePlanComputers } from "../../planRoom/usePlanComputers";
import { ClaudeAI, OpenAI } from "../Icons";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const SWITCH_LABEL = {
  ask: "Ask me",
  auto: "Switch by itself",
} as const;

/** Under the provider's name: "Room on 1 of 2 accounts. More from 4:40 AM." */
function planSummary(plan: PooledPlan, now: number): string {
  const total = plan.accounts.length;
  if (plan.withRoom === total) {
    return total === 1 ? "Room now." : `Room on all ${total} accounts.`;
  }
  const until = planUntilText(plan.nextResetAt, now);
  const back = until ? ` More from ${until}.` : "";
  if (plan.withRoom === 0) {
    return total === 1 ? `At its limit.${back}` : `All at their limit.${back}`;
  }
  return `Room on ${plan.withRoom} of ${total} accounts.${back}`;
}

export const AiPlansSection = memo(function AiPlansSection() {
  const { computers, pending } = usePlanComputers();
  const clock = useMinuteClock();
  const now = Math.max(Date.parse(clock), Date.now());
  const plans = poolPlans(computers, now);
  const mode = useSettings((settings) => settings.planLimitSwitch);
  const { updateSettings } = useUpdateSettings();
  const save = (next: "ask" | "auto") =>
    void Promise.resolve(updateSettings({ planLimitSwitch: next })).catch((error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Couldn't save",
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  // Nothing to say before any computer has a plan of its own signed in.
  if (plans.length === 0 && !pending) return null;
  const several = plans.some((plan) => plan.accounts.length > 1);

  return (
    <SettingsSection title="Your AI plans">
      {plans.map((plan) => {
        const Icon = plan.provider === "claude" ? ClaudeAI : OpenAI;
        return (
          <SettingsRow
            key={plan.provider}
            title={
              <span className="inline-flex items-center gap-1.5">
                <Icon className="size-3.5" aria-hidden />
                {PLAN_PROVIDER_NAME[plan.provider]}
              </span>
            }
            description={planSummary(plan, now)}
          >
            <ul className="mt-3 flex flex-col gap-2 pb-4" data-testid={`ai-plans-${plan.provider}`}>
              {plan.accounts.map((entry) => {
                const until = entry.hit ? planUntilText(entry.hit.resetsAt, now) : null;
                const room = entry.roomPercent;
                return (
                  <li
                    key={`${entry.account.id}:${entry.computers[0]?.environmentId ?? ""}`}
                    className="flex min-w-0 items-center gap-3 text-xs"
                    data-testid="ai-plans-account"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-foreground">
                        {planAccountName(entry.account)}
                        {entry.account.email ? (
                          <span className="ml-1.5 font-normal text-muted-foreground">
                            {entry.account.email}
                          </span>
                        ) : null}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        On {entry.computers.map((computer) => computer.name).join(", ")}
                      </div>
                    </div>
                    <div className="flex w-36 shrink-0 flex-col items-end gap-1">
                      <span
                        className={cn(
                          "whitespace-nowrap text-[11px] tabular-nums",
                          entry.hit ? "font-medium text-warning" : "text-muted-foreground",
                        )}
                      >
                        {entry.hit
                          ? until
                            ? `At its limit until ${until}`
                            : "At its limit"
                          : room === null
                            ? "No numbers yet"
                            : `${room}% left`}
                      </span>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn(
                            "h-full rounded-full",
                            entry.hit
                              ? "bg-warning"
                              : (room ?? 100) <= 30
                                ? "bg-warning/70"
                                : "bg-success",
                          )}
                          style={{ width: `${entry.hit ? 100 : Math.max(2, room ?? 0)}%` }}
                        />
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </SettingsRow>
        );
      })}
      <SettingsRow
        title="When a plan is at its limit"
        description={
          mode === "auto"
            ? "A new chat starts by itself on another computer of yours whose plan has room, and says so. Chats already running stay where they are."
            : several || computers.length > 1
              ? "A new chat offers to start on another computer of yours whose plan has room. Uno AI is always one click away."
              : "A new chat says when your plan is back and offers Uno AI meanwhile. With a second computer signed in to another plan, it can start there."
        }
        control={
          <Select value={mode} onValueChange={(value) => value && save(value)}>
            <SelectTrigger
              className="w-full sm:w-44"
              aria-label="When a plan is at its limit"
              data-testid="settings-plan-limit-switch"
            >
              <SelectValue>{SWITCH_LABEL[mode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="ask">
                {SWITCH_LABEL.ask}
              </SelectItem>
              <SelectItem hideIndicator value="auto">
                {SWITCH_LABEL.auto}
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
});
