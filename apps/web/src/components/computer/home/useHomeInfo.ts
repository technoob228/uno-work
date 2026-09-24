/**
 * What Home reads for its greeting and the "Uno AI spend" widget — all from
 * calls the app already makes (`/auth/me` through the account, the daemon's
 * account state, the home folder), plus the daemon's spend ledger.
 */
import type { EnvironmentId, UnoAiSpend } from "@t3tools/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";

import { ensureEnvironmentApi } from "../../../environmentApi";
import { unoCloudStateQueryOptions } from "../../../lib/workspaceReactQuery";
import { accountReachable, balanceQuery } from "../../myuno/myUnoQueries";
import { homeFolderUser, personFirstName } from "./homeInfo";

function homePathQueryOptions(environmentId: EnvironmentId | null) {
  return queryOptions({
    queryKey: ["home", "home-path", environmentId] as const,
    queryFn: async () =>
      (await ensureEnvironmentApi(environmentId!).filesystem.browse({ partialPath: "~" }))
        .parentPath ?? null,
    enabled: environmentId !== null,
    staleTime: Infinity,
    retry: false,
  });
}

/** "Mikhail", or null to greet without a name. */
export function usePersonFirstName(environmentId: EnvironmentId | null): string | null {
  const account = useQuery(balanceQuery()).data;
  const cloud = useQuery(unoCloudStateQueryOptions(environmentId)).data?.account ?? null;
  const homePath = useQuery(homePathQueryOptions(environmentId)).data ?? null;
  return personFirstName({
    accountName: account?.name ?? null,
    username: account?.username ?? cloud?.username ?? null,
    osUser: homeFolderUser(homePath),
    email: account?.email ?? cloud?.email ?? null,
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
