/**
 * How much of the person's own Claude or ChatGPT plan is left, right in the
 * chat (upstream `ComposerUsageLimits`, `/usage-limits`; here the daemon's
 * `planLimits`, the same numbers as Home's widget): a quiet chip beside Send,
 * details on click or with `/limits`. Nothing shows for chats on Uno AI, or
 * where the computer doesn't read limits.
 */
import type { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { GaugeIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { useEnvironmentSupportsPlanLimits } from "../../environments/planLimitsSupport";
import { useMinuteClock } from "../../hooks/useMinuteClock";
import { cn } from "../../lib/utils";
import { planProviderForDriver } from "../../planRoom/planRoom.logic";
import { PlanLimitsAccountBlock } from "../computer/home/PlanLimitsAccountBlock";
import { planLimitsQueryOptions } from "../computer/home/useHomeInfo";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { type ChatPlanLimits, chatPlanLimitsFrom } from "./composerPlanLimits.logic";

/** The daemon re-reads limits every 5 minutes; a chat needn't ask more often. */
const CHAT_PLAN_LIMITS_REFETCH_MS = 5 * 60_000;

export function useChatPlanLimits(input: {
  readonly environmentId: EnvironmentId;
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
}): ChatPlanLimits {
  const supported = useEnvironmentSupportsPlanLimits(input.environmentId);
  const hasPlan = planProviderForDriver(input.driver) !== null;
  const { data } = useQuery({
    ...planLimitsQueryOptions(input.environmentId, {
      signInsOnly: false,
      enabled: supported && hasPlan,
    }),
    refetchInterval: CHAT_PLAN_LIMITS_REFETCH_MS,
  });
  const clock = useMinuteClock();
  return useMemo(
    () =>
      chatPlanLimitsFrom({
        accounts: data?.accounts,
        driver: input.driver,
        instanceId: input.instanceId,
        now: Date.parse(clock),
      }),
    [clock, data?.accounts, input.driver, input.instanceId],
  );
}

function roomToneClass(roomPercent: number): string {
  if (roomPercent <= 10) return "text-destructive";
  if (roomPercent <= 30) return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground";
}

export const ComposerPlanLimits = memo(function ComposerPlanLimits(props: {
  readonly limits: ChatPlanLimits;
  readonly compact: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { account, accounts, roomPercent, now } = props.limits;
  if (!account) return null;
  const label = roomPercent === null ? "AI plan limits" : `${roomPercent}% of your plan left`;
  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange}>
      <PopoverTrigger
        aria-label={label}
        title={label}
        data-chat-composer-plan-limits="true"
        className={cn(
          "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full px-1.5 text-xs tabular-nums transition-colors hover:bg-accent/60",
          roomPercent === null ? "text-muted-foreground" : roomToneClass(roomPercent),
        )}
      >
        <GaugeIcon className="size-3.5" aria-hidden />
        {!props.compact && roomPercent !== null ? <span>{roomPercent}% left</span> : null}
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" className="w-80">
        <div className="flex flex-col gap-3" data-testid="composer-plan-limits">
          {accounts.map((entry) => (
            <PlanLimitsAccountBlock key={entry.id} account={entry} now={now} />
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
});
