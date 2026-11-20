/**
 * The one query behind Settings → Security's Protection
 * (GET /api/v1/security/protection), shared by the page and the Security row
 * in Settings → Computer. Kept apart from ProtectionSection.tsx so the row
 * doesn't pull the whole section in.
 */
import { useQuery } from "@tanstack/react-query";

import { accountRequest, accountTransport } from "../../../account/unoAccount";
import { type Protection, protectionPath } from "./protectionModel";
import { type ProtectionStatus, protectionNotEnabled, protectionStatus } from "./protectionStatus";

export const protectionKey = ["account", "security", "protection"] as const;

export function useProtection() {
  return useQuery({
    queryKey: protectionKey,
    queryFn: async () => (await accountRequest("GET", protectionPath)) as Protection,
    enabled: accountTransport() !== "none",
    // 404 = not on for this account: asking again won't change it.
    retry: (count, error) => !protectionNotEnabled(error) && count < 2,
  });
}

/** What the server said about Protection for this account (protectionStatus.ts). */
export function useProtectionStatus(): ProtectionStatus {
  return protectionStatus(useProtection());
}
