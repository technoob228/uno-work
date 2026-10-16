/**
 * What the person picked for AI in onboarding — console `GET /auth/me`
 * `default_ai` (uno | claude | codex | opencode | byok). Null when there is
 * no account connection or the console doesn't say. Quiet on failure.
 */
import { useQuery } from "@tanstack/react-query";

import { accountRequest, accountTransport } from "../account/unoAccount";

export function useAccountDefaultAi(enabled: boolean): string | null {
  return useAccountDefaultAiState(enabled).value;
}

/**
 * The same, and whether the answer is in: `ready` once the account answered
 * (or failed), or right away where there is no account connection.
 */
export function useAccountDefaultAiState(enabled: boolean): {
  readonly value: string | null;
  readonly ready: boolean;
} {
  const on = enabled && accountTransport() !== "none";
  const query = useQuery({
    queryKey: ["uno-account", "default-ai"],
    queryFn: async () => {
      const me = (await accountRequest("GET", "/auth/me")) as Record<string, unknown> | null;
      const value = me?.["default_ai"];
      return typeof value === "string" && value.length > 0 ? value : null;
    },
    enabled: on,
    staleTime: 10 * 60_000,
    retry: false,
  });
  return { value: query.data ?? null, ready: !on || query.isFetched || query.isError };
}
