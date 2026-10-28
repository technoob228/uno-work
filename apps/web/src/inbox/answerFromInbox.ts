/**
 * Allow / Decline right from an Inbox row (assistants D, 28.10): an "Asks
 * first" request that waits with no chat card to answer it — the daemon
 * finds the request by the row (`POST /api/uno-work/approval/from-inbox`,
 * owner session). False: nothing waits behind the row any more (404).
 */
import type { EnvironmentId } from "@t3tools/contracts";

import { environmentFetchJson, isEnvironmentHttpError } from "~/environments/http/target";

export async function answerFromInbox(input: {
  readonly environmentId: string;
  readonly inboxItemId: string;
  readonly approved: boolean;
}): Promise<boolean> {
  try {
    await environmentFetchJson({
      environmentId: input.environmentId as EnvironmentId,
      pathname: "/api/uno-work/approval/from-inbox",
      method: "POST",
      body: { inboxItemId: input.inboxItemId, approved: input.approved },
    });
    return true;
  } catch (cause) {
    if (isEnvironmentHttpError(cause) && cause.status === 404) return false;
    throw cause;
  }
}
