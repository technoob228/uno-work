/**
 * Phone pairing calls against one computer of the workspace.
 *
 * The same owner routes as `environments/primary/auth` (`/api/auth/pairing-token`,
 * `/api/auth/clients`, …), but addressed by `environmentId` through
 * `environmentFetchJson`: the primary daemon with its cookie, any other
 * connected computer with its saved bearer session. That is what lets the Mac
 * desktop mint a phone code on the cloud computer instead of on itself.
 *
 * The code is minted with the route's default role, `client`: through the
 * mobile-compat shim it gets chats, the terminal and reviews, but not access
 * management, so a lost phone cannot mint more codes or cut off other devices.
 *
 * @module components/settings/phoneComputerApi
 */
import type { AuthPairingCredentialResult, AuthSessionId, EnvironmentId } from "@t3tools/contracts";

import { environmentFetchJson } from "../../environments/http/target";
import type { ServerClientSessionRecord } from "../../environments/primary/auth";

export function listPhoneComputerSessions(
  environmentId: EnvironmentId,
): Promise<ReadonlyArray<ServerClientSessionRecord>> {
  return environmentFetchJson<ReadonlyArray<ServerClientSessionRecord>>({
    environmentId,
    pathname: "/api/auth/clients",
  });
}

export function mintPhoneComputerCode(
  environmentId: EnvironmentId,
  label: string,
): Promise<AuthPairingCredentialResult> {
  return environmentFetchJson<AuthPairingCredentialResult>({
    environmentId,
    pathname: "/api/auth/pairing-token",
    method: "POST",
    body: { label },
  });
}

export async function retirePhoneComputerCode(
  environmentId: EnvironmentId,
  pairingLinkId: string,
): Promise<void> {
  await environmentFetchJson<unknown>({
    environmentId,
    pathname: "/api/auth/pairing-links/revoke",
    method: "POST",
    body: { id: pairingLinkId },
  });
}

export async function disconnectPhoneComputerSession(
  environmentId: EnvironmentId,
  sessionId: AuthSessionId,
): Promise<void> {
  await environmentFetchJson<unknown>({
    environmentId,
    pathname: "/api/auth/clients/revoke",
    method: "POST",
    body: { sessionId },
  });
}
