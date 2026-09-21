/**
 * The address another device should use to reach the machine serving this page.
 *
 * Opened through app.uno4.work (the single entry point), the page origin is the
 * Uno control plane's proxy: it lets a browser in on the console's cookie and
 * turns everyone else away to the console login. A phone app or a second
 * browser handed `https://app.uno4.work/pair#token=…` therefore never reaches
 * the daemon. The box itself is published at its own hostname
 * (`https://<box>.app.uno4.dev`), which serves the daemon directly — that is
 * the address QR codes and pairing links must carry.
 *
 * @module hooks/useDirectMachineAddress
 */
import type { UnoBox } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { usePrimaryEnvironmentDescriptor } from "../environments/primary";
import { unoCloudStateQueryOptions } from "../lib/workspaceReactQuery";

/** Hosts that proxy Uno Work behind the console login (no direct daemon access). */
export function isWorkProxyHost(urlOrHost: string): boolean {
  let host = urlOrHost;
  try {
    host = new URL(urlOrHost).hostname;
  } catch {
    // already a hostname
  }
  return /(^|\.)app\.uno4\.work$/i.test(host.trim());
}

/** The box's own https origin, or null when it has no published address. */
export function boxDirectOrigin(box: Pick<UnoBox, "hostname" | "url">): string | null {
  const candidate = box.url ?? (box.hostname ? `https://${box.hostname}` : null);
  if (!candidate) return null;
  try {
    return new URL(candidate).origin;
  } catch {
    return null;
  }
}

/**
 * The box's direct origin when this page is *not* already served from it
 * (i.e. it came through a proxy); null when the page origin is fine as is or
 * the box is unknown.
 */
export function resolveDirectMachineBaseUrl(input: {
  readonly pageUrl: string;
  readonly box: Pick<UnoBox, "hostname" | "url"> | null;
}): string | null {
  if (!input.box) return null;
  const direct = boxDirectOrigin(input.box);
  if (!direct) return null;
  try {
    return new URL(input.pageUrl).host === new URL(direct).host ? null : direct;
  } catch {
    return direct;
  }
}

export function useDirectMachineBaseUrl(): string | null {
  const descriptor = usePrimaryEnvironmentDescriptor();
  const environmentId = descriptor?.environmentId ?? null;
  const cloud = useQuery(unoCloudStateQueryOptions(environmentId)).data;
  const boxId = descriptor?.unoBoxId ?? null;
  return useMemo(() => {
    if (boxId === null || !cloud?.connected || typeof window === "undefined") return null;
    const box = cloud.boxes.find((candidate) => candidate.id === boxId) ?? null;
    return resolveDirectMachineBaseUrl({ pageUrl: window.location.href, box });
  }, [boxId, cloud]);
}
