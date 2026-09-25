/**
 * What Home reads for its greeting and the "Uno AI spend" widget — all from
 * calls the app already makes (`/auth/me` through the account, the daemon's
 * account state, the home folder), plus the daemon's spend ledger.
 */
import type { EnvironmentId, UnoAiSpend } from "@t3tools/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";

import { isElectron } from "../../../env";
import { ensureEnvironmentApi } from "../../../environmentApi";
import { unoCloudStateQueryOptions } from "../../../lib/workspaceReactQuery";
import { aiHoursSummary, type AiHoursSummary } from "../../../account/aiHours";
import { useAiStatus } from "../../../lib/aiStatusReactQuery";
import { accountReachable, balanceQuery, subscriptionQuery } from "../../myuno/myUnoQueries";
import { homeFolderUser, personFirstName } from "./homeInfo";

/**
 * The environment's home folder. Read on desktop only: there the environment
 * is the person's own machine, so its user can be their name; in the browser
 * it is the Work box's user (`uno`), never the person's.
 */
function homePathQueryOptions(environmentId: EnvironmentId | null) {
  return queryOptions({
    queryKey: ["home", "home-path", environmentId] as const,
    queryFn: async () =>
      (await ensureEnvironmentApi(environmentId!).filesystem.browse({ partialPath: "~" }))
        .parentPath ?? null,
    enabled: isElectron && environmentId !== null,
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * "Mikhail", or null to greet without a name: Telegram's first name, the
 * email, the username, then (desktop only) the computer's user.
 */
export function usePersonFirstName(environmentId: EnvironmentId | null): string | null {
  const account = useQuery(balanceQuery()).data;
  const cloud = useQuery(unoCloudStateQueryOptions(environmentId)).data?.account ?? null;
  const homePath = useQuery(homePathQueryOptions(environmentId)).data ?? null;
  return personFirstName({
    accountName: account?.name ?? null,
    email: account?.email ?? cloud?.email ?? null,
    username: account?.username ?? cloud?.username ?? null,
    osUser: isElectron ? homeFolderUser(homePath) : null,
  });
}

export function aiSpendQueryOptions(environmentId: EnvironmentId | null) {
  return queryOptions({
    queryKey: ["home", "ai-spend", environmentId] as const,
    queryFn: (): Promise<UnoAiSpend> =>
      ensureEnvironmentApi(environmentId!).unoComputer.appAiSpend(),
    enabled: environmentId !== null,
    refetchInterval: 60_000,
  });
}

/** The daemon's reading, and the account's credits as a second source. */
export function useAiSpend(environmentId: EnvironmentId | null) {
  const spend = useQuery(aiSpendQueryOptions(environmentId));
  const account = useQuery({ ...balanceQuery(), enabled: accountReachable() });
  const creditsUsd = spend.data?.creditsUsd ?? account.data?.aiBalanceUsd ?? null;
  return { spend, creditsUsd };
}

/**
 * Uno AI hours for Home: the account's subscription and balance, with today's
 * use from the machine's `/v1/ai/status` when the subscription doesn't say.
 * Null when the account has no AI hours (the widget then shows credits).
 */
export function useAiHours(environmentId: EnvironmentId | null): AiHoursSummary | null {
  const reachable = accountReachable();
  const subscription = useQuery({ ...subscriptionQuery(), enabled: reachable }).data ?? null;
  const balance = useQuery({ ...balanceQuery(), enabled: reachable }).data ?? null;
  const status = useAiStatus(environmentId);
  const summary = aiHoursSummary({
    subscription,
    balance,
    usedTodayMinutes: status?.usedTodayMinutes ?? null,
  });
  if (summary || !status) return summary;
  // No account reachable (desktop without sign-in): the machine's own reading.
  if (status.unlimited) {
    return {
      unlimited: true,
      leftMinutes: null,
      monthlyHours: 0,
      usedTodayMinutes: status.usedTodayMinutes,
      premiumUsd: 0,
      power: status.power,
    };
  }
  return status.hoursLeftMinutes !== null
    ? {
        unlimited: false,
        leftMinutes: status.hoursLeftMinutes,
        monthlyHours: 0,
        usedTodayMinutes: status.usedTodayMinutes,
        premiumUsd: 0,
        power: status.power,
      }
    : null;
}
