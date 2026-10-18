/**
 * "Your site" from a cloud computer, in the panel of the person's own browser
 * (18.10, reports/day_2026-10-18/local-preview/CONTRACT.md). A tab at the
 * computer's `http://localhost:PORT/...` loads
 * `https://p{PORT}--{LABEL}.uno4.work/...` instead: the console lets the
 * person in with a one-time link and the computer's daemon relays the page
 * from the port (apps/server portPreview.ts). The address bar keeps the
 * localhost address.
 *
 * The link comes from the account: on the web, `POST /_account/port-preview`
 * on Work's own address; in the desktop app, the console's
 * `POST /api/v1/work/port-preview` through the signed-in account (main
 * process). No link (the account doesn't have it yet, a self-hosted daemon,
 * an error) → the page opens in the computer's browser, as before — never the
 * person's own localhost.
 */
import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import {
  computerLocalPort,
  isComputerLocalUrl,
  isPreviewablePort,
  urlPathAndQuery,
} from "@t3tools/shared/portPreview";
import { useEffect, useMemo, useState } from "react";

import { accountRequest, accountTransport } from "../../account/unoAccount";
import {
  readPrimaryEnvironmentDescriptor,
  usePrimaryEnvironmentDescriptor,
} from "../../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";

export interface PortPreviewLink {
  /** One-time entry (`…/enter?t=…&next=/path`): the frame loads it first. */
  readonly url: string;
  /** `https://p{PORT}--{LABEL}.uno4.work`: later pages of the same port go here directly. */
  readonly origin: string;
  readonly port: number;
}

/** A cloud computer (an Uno box): its id in the console when known. */
export interface CloudComputer {
  readonly boxId: number | null;
}

/** What the panel knows about a machine; null — not an Uno box (the Mac, a self-hosted server). */
export function cloudComputerFromDescriptor(
  descriptor: Pick<ExecutionEnvironmentDescriptor, "machineKind" | "unoBoxId"> | null | undefined,
  recordBoxId?: number,
): CloudComputer | null {
  const boxId = recordBoxId ?? descriptor?.unoBoxId ?? null;
  if (boxId !== null) return { boxId };
  return descriptor?.machineKind === "uno_box" ? { boxId: null } : null;
}

/** The chat's computer, if it is a cloud one (read from the stores now). */
export function readCloudComputer(environmentId: EnvironmentId | null): CloudComputer | null {
  const primary = readPrimaryEnvironmentDescriptor();
  if (environmentId === null || primary?.environmentId === environmentId) {
    return cloudComputerFromDescriptor(primary);
  }
  const record = useSavedEnvironmentRegistryStore.getState().byId[environmentId];
  const runtime = useSavedEnvironmentRuntimeStore.getState().byId[environmentId];
  return cloudComputerFromDescriptor(runtime?.descriptor, record?.unoBoxId);
}

/** {@link readCloudComputer}, following the stores. */
export function useCloudComputer(environmentId: EnvironmentId | null): CloudComputer | null {
  const primary = usePrimaryEnvironmentDescriptor();
  const recordBoxId = useSavedEnvironmentRegistryStore((state) =>
    environmentId === null ? undefined : state.byId[environmentId]?.unoBoxId,
  );
  const descriptor = useSavedEnvironmentRuntimeStore((state) =>
    environmentId === null ? null : (state.byId[environmentId]?.descriptor ?? null),
  );
  const isPrimary = environmentId === null || primary?.environmentId === environmentId;
  const boxId = isPrimary
    ? cloudComputerFromDescriptor(primary)?.boxId
    : cloudComputerFromDescriptor(descriptor, recordBoxId)?.boxId;
  return useMemo(() => (boxId === undefined ? null : { boxId }), [boxId]);
}

function parseLink(body: unknown, port: number): PortPreviewLink | null {
  if (!body || typeof body !== "object") return null;
  const { url, origin } = body as { url?: unknown; origin?: unknown };
  if (typeof url !== "string" || typeof origin !== "string") return null;
  try {
    if (new URL(url).protocol !== "https:" || new URL(origin).origin !== origin) return null;
  } catch {
    return null;
  }
  return { url, origin, port };
}

/** A fresh link for a computer-local address; null — not available (open it on the computer). */
export async function mintPortPreviewLink(input: {
  readonly localUrl: string;
  readonly computer: CloudComputer;
}): Promise<PortPreviewLink | null> {
  const port = computerLocalPort(input.localUrl);
  if (port === null || !isPreviewablePort(port)) return null;
  const transport = accountTransport();
  if (transport === "none") return null;
  const body = {
    port,
    path: urlPathAndQuery(input.localUrl),
    ...(input.computer.boxId !== null ? { box_id: input.computer.boxId } : {}),
  };
  try {
    const answer = await accountRequest(
      "POST",
      transport === "desktop" ? "/api/v1/work/port-preview" : "/port-preview",
      body,
    );
    return parseLink(answer, port);
  } catch {
    return null;
  }
}

export type PortPreviewState =
  /** Not a computer-local address of a cloud computer: the tab works as always. */
  | { readonly kind: "off" }
  | { readonly kind: "minting"; readonly port: number }
  | { readonly kind: "ready"; readonly link: PortPreviewLink }
  /** No link: the page belongs in the computer's browser. */
  | { readonly kind: "failed"; readonly port: number | null };

/**
 * The tab's "Your site" state: a link per port, kept while the tab stays on
 * that port (later pages of it load from the link's origin, the port's
 * cookie is already there).
 */
export function usePortPreview(input: {
  readonly url: string;
  readonly computer: CloudComputer | null;
  readonly enabled: boolean;
}): PortPreviewState {
  const { url, computer, enabled } = input;
  const applies = enabled && computer !== null && url !== "" && isComputerLocalUrl(url);
  const port = applies ? computerLocalPort(url) : null;
  const boxId = computer?.boxId ?? null;
  const [state, setState] = useState<{
    readonly key: string;
    readonly link: PortPreviewLink | null;
    readonly failed: boolean;
  } | null>(null);
  const key = `${boxId ?? "this"}:${port ?? ""}`;

  useEffect(() => {
    if (!applies || port === null || computer === null) return;
    if (state?.key === key && (state.link !== null || state.failed)) return;
    let cancelled = false;
    setState({ key, link: null, failed: false });
    void mintPortPreviewLink({ localUrl: url, computer }).then((link) => {
      if (cancelled) return;
      setState({ key, link, failed: link === null });
    });
    return () => {
      cancelled = true;
    };
    // `url` only matters for the first page of a port: later ones reuse the link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applies, key]);

  if (!applies) return { kind: "off" };
  if (port === null || !isPreviewablePort(port)) return { kind: "failed", port };
  if (state?.key !== key || (state.link === null && !state.failed))
    return { kind: "minting", port };
  return state.link ? { kind: "ready", link: state.link } : { kind: "failed", port };
}
