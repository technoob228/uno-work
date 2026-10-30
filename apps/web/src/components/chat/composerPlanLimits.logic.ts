/** What the chat's plan chip shows: pure, so the rule is tested without React. */
import type { PlanLimitsAccount } from "@t3tools/contracts";
import { planAccountForInstance, planProviderForDriver } from "@t3tools/shared/planLimitRules";

import { planRoomPercent } from "../../planRoom/planRoom.logic";

export interface ChatPlanLimits {
  /** What this chat runs on; null for Uno AI and anything without a plan. */
  readonly account: PlanLimitsAccount | null;
  /** Every sign-in on the chat's computer, this chat's first. */
  readonly accounts: ReadonlyArray<PlanLimitsAccount>;
  readonly roomPercent: number | null;
  readonly now: number;
}

const NO_ACCOUNTS: ReadonlyArray<PlanLimitsAccount> = [];

export function chatPlanLimitsFrom(input: {
  readonly accounts: ReadonlyArray<PlanLimitsAccount> | null | undefined;
  readonly driver: string | null;
  readonly instanceId: string | null;
  readonly now: number;
}): ChatPlanLimits {
  const provider = planProviderForDriver(input.driver);
  const all = input.accounts ?? NO_ACCOUNTS;
  const account = provider ? planAccountForInstance(all, provider, input.instanceId) : null;
  if (!account) return { account: null, accounts: NO_ACCOUNTS, roomPercent: null, now: input.now };
  return {
    account,
    accounts: [account, ...all.filter((other) => other.id !== account.id)],
    roomPercent: planRoomPercent(account, input.now),
    now: input.now,
  };
}
