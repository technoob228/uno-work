/**
 * Where share links live: the computer's own public address
 * (`https://<computer>.app.uno4.dev`), which reaches this daemon without a
 * login and wakes a sleeping computer. A laptop running Uno Work has no public
 * address, so its links only work where that laptop is reachable — the share
 * dialog says so instead of handing out a link that won't open.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";

import { isPrimaryEnvironmentId } from "../../environments/http/target";
import { getEnvironmentHttpBaseUrl } from "../../environments/runtime/catalog";
import { isWorkProxyHost } from "../../hooks/useDirectMachineAddress";
import { computerStateQueryOptions } from "../computer/computerQueries";

export interface ShareBase {
  /** Origin to put in front of `/s/<token>`, or null while unknown. */
  readonly origin: string | null;
  /** True for the computer's public address; false for a local/LAN one. */
  readonly isPublic: boolean;
}

function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).origin;
  } catch {
    return null;
  }
}

export function useShareBaseUrl(environmentId: EnvironmentId | null): ShareBase {
  const computer = useQuery(computerStateQueryOptions(environmentId, null)).data;
  const address = computer?.own ? originOf(computer.box?.address) : null;
  if (address) return { origin: address, isPublic: true };
  if (environmentId === null) return { origin: null, isPublic: false };
  if (isPrimaryEnvironmentId(environmentId) && typeof window !== "undefined") {
    const origin = window.location.origin;
    // Behind the app.uno4.work proxy the page origin needs a console login.
    if (isWorkProxyHost(origin)) return { origin: null, isPublic: false };
    return { origin, isPublic: origin.startsWith("https://") && origin.includes(".app.uno4.dev") };
  }
  const saved = originOf(getEnvironmentHttpBaseUrl(environmentId));
  return { origin: saved, isPublic: saved?.includes(".app.uno4.dev") ?? false };
}

export function shareUrl(base: ShareBase, urlPath: string): string | null {
  return base.origin ? `${base.origin}${urlPath}` : null;
}
