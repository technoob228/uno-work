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
  localUrlToPortPreviewUrl,
  urlPathAndQuery,
} from "@t3tools/shared/portPreview";
import { useEffect, useMemo, useState } from "react";

import { AccountHttpError, accountRequest, accountTransport } from "../../account/unoAccount";
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

// ------------------------------------------------------- port sessions --
//
// The one-time link sets the port's cookie (`__Host-uno_port`, 12 h, one per
// port address — whichever computer it was minted for). While it lives, a
// frame can load the port's address straight away: no new link, and no new
// "Opened a preview of port N" line in Security for every Home visit
// (P16, 28.10). Only on the web, where every frame of Work shares the
// cookie; the desktop's webviews keep their own jars and always mint.

export const PORT_SESSIONS_KEY = "uno-work:port-sessions:v1";
/** A little under the cookie's 12 h, so a reused session never just expired. */
export const PORT_SESSION_REUSE_MS = 11 * 60 * 60 * 1000;

export interface PortSessionRecord {
  readonly origin: string;
  readonly boxId: number;
  readonly at: number;
}

type PortSessionStore = Pick<Storage, "getItem" | "setItem">;

function readSessions(store: PortSessionStore): Record<string, PortSessionRecord> {
  try {
    const parsed: unknown = JSON.parse(store.getItem(PORT_SESSIONS_KEY) ?? "{}");
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, PortSessionRecord>)
      : {};
  } catch {
    return {};
  }
}

/** The port's live session for this computer, if this browser has one. */
export function readPortSession(
  store: PortSessionStore,
  input: { readonly port: number; readonly boxId: number; readonly now: number },
): PortSessionRecord | null {
  const record = readSessions(store)[String(input.port)];
  if (!record || typeof record.origin !== "string" || record.boxId !== input.boxId) return null;
  if (!(input.now - record.at >= 0 && input.now - record.at < PORT_SESSION_REUSE_MS)) return null;
  return record;
}

export function rememberPortSession(
  store: PortSessionStore,
  input: {
    readonly port: number;
    readonly boxId: number;
    readonly origin: string;
    readonly now: number;
  },
): void {
  try {
    const sessions = readSessions(store);
    sessions[String(input.port)] = { origin: input.origin, boxId: input.boxId, at: input.now };
    store.setItem(PORT_SESSIONS_KEY, JSON.stringify(sessions));
  } catch {
    // storage full or blocked: the next frame mints a link, as before
  }
}

export function forgetPortSession(store: PortSessionStore, port: number): void {
  try {
    const sessions = readSessions(store);
    if (!(String(port) in sessions)) return;
    delete sessions[String(port)];
    store.setItem(PORT_SESSIONS_KEY, JSON.stringify(sessions));
  } catch {
    // nothing to forget
  }
}

function sessionStore(): PortSessionStore | null {
  if (accountTransport() !== "work-proxy") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Forget a port's session (its frame said the cookie is gone). */
export function forgetPortSessionHere(port: number): void {
  const store = sessionStore();
  if (store) forgetPortSession(store, port);
}

/**
 * Why there is no link: `disabled` — this account doesn't show computer
 * pages in its own browser yet (the console's WORK_PORT_PREVIEW);
 * `unavailable` — anything else (no account here, the computer isn't
 * reachable, a network error).
 */
export type PortLinkFailure = "disabled" | "unavailable";

export type PortLinkResult =
  | { readonly ok: true; readonly link: PortPreviewLink }
  | { readonly ok: false; readonly reason: PortLinkFailure };

function failureOf(cause: unknown): PortLinkFailure {
  if (cause instanceof AccountHttpError && cause.status === 404) {
    const body = cause.body as { error?: unknown } | null;
    if (body && typeof body === "object" && body.error === "port_preview_disabled") {
      return "disabled";
    }
  }
  return "unavailable";
}

/**
 * A way into a computer-local address from this browser: the port's
 * address straight away while this browser holds its session, else a fresh
 * one-time link. `fresh` skips the remembered session.
 */
export async function requestPortPreviewLink(input: {
  readonly localUrl: string;
  readonly computer: CloudComputer;
  readonly fresh?: boolean;
}): Promise<PortLinkResult> {
  const port = computerLocalPort(input.localUrl);
  if (port === null || !isPreviewablePort(port)) return { ok: false, reason: "unavailable" };
  const transport = accountTransport();
  if (transport === "none") return { ok: false, reason: "unavailable" };
  const store = sessionStore();
  const boxId = input.computer.boxId;
  if (store && boxId !== null && input.fresh !== true) {
    const session = readPortSession(store, { port, boxId, now: Date.now() });
    const direct = session ? localUrlToPortPreviewUrl(input.localUrl, session.origin) : null;
    if (session && direct) return { ok: true, link: { url: direct, origin: session.origin, port } };
  }
  const body = {
    port,
    path: urlPathAndQuery(input.localUrl),
    ...(boxId !== null ? { box_id: boxId } : {}),
  };
  try {
    const answer = await accountRequest(
      "POST",
      transport === "desktop" ? "/api/v1/work/port-preview" : "/port-preview",
      body,
    );
    const link = parseLink(answer, port);
    if (!link) return { ok: false, reason: "unavailable" };
    if (store && boxId !== null) {
      rememberPortSession(store, { port, boxId, origin: link.origin, now: Date.now() });
    }
    return { ok: true, link };
  } catch (cause) {
    return { ok: false, reason: failureOf(cause) };
  }
}

/** A fresh link for a computer-local address; null — not available (open it on the computer). */
export async function mintPortPreviewLink(input: {
  readonly localUrl: string;
  readonly computer: CloudComputer;
}): Promise<PortPreviewLink | null> {
  const result = await requestPortPreviewLink(input);
  return result.ok ? result.link : null;
}

/**
 * What a port's "Open this page from Uno Work" answer tells the frame's
 * parent (the console's 401 page, P16): the cookie is gone — forget the
 * session and come in with a fresh link.
 */
export const PORT_PREVIEW_REENTER_MESSAGE = "uno-port-preview:reenter";

export function isPortReenterMessage(data: unknown): boolean {
  return (
    !!data &&
    typeof data === "object" &&
    (data as { __unoPortPreview?: unknown }).__unoPortPreview === PORT_PREVIEW_REENTER_MESSAGE
  );
}

export type PortPreviewState =
  /** Not a computer-local address of a cloud computer: the tab works as always. */
  | { readonly kind: "off" }
  | { readonly kind: "minting"; readonly port: number }
  | { readonly kind: "ready"; readonly link: PortPreviewLink }
  /** No link: the page can't be shown in this browser (the panel says so). */
  | { readonly kind: "failed"; readonly port: number | null; readonly reason: PortLinkFailure };

/**
 * The tab's "Your site" state: a link per port, kept while the tab stays on
 * that port (later pages of it load from the link's origin, the port's
 * cookie is already there). `attempt` bumps to try again after a failure.
 */
export function usePortPreview(input: {
  readonly url: string;
  readonly computer: CloudComputer | null;
  readonly enabled: boolean;
  readonly attempt?: number;
}): PortPreviewState {
  const { url, computer, enabled } = input;
  const attempt = input.attempt ?? 0;
  const applies = enabled && computer !== null && url !== "" && isComputerLocalUrl(url);
  const port = applies ? computerLocalPort(url) : null;
  const boxId = computer?.boxId ?? null;
  const [state, setState] = useState<{
    readonly key: string;
    readonly link: PortPreviewLink | null;
    readonly failure: PortLinkFailure | null;
  } | null>(null);
  const key = `${boxId ?? "this"}:${port ?? ""}:${attempt}`;

  useEffect(() => {
    if (!applies || port === null || computer === null) return;
    if (state?.key === key && (state.link !== null || state.failure !== null)) return;
    let cancelled = false;
    setState({ key, link: null, failure: null });
    void requestPortPreviewLink({ localUrl: url, computer, fresh: attempt > 0 }).then((result) => {
      if (cancelled) return;
      setState(
        result.ok
          ? { key, link: result.link, failure: null }
          : { key, link: null, failure: result.reason },
      );
    });
    return () => {
      cancelled = true;
    };
    // `url` only matters for the first page of a port: later ones reuse the link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applies, key]);

  if (!applies) return { kind: "off" };
  if (port === null || !isPreviewablePort(port)) {
    return { kind: "failed", port, reason: "unavailable" };
  }
  if (state?.key !== key || (state.link === null && state.failure === null))
    return { kind: "minting", port };
  return state.link
    ? { kind: "ready", link: state.link }
    : { kind: "failed", port, reason: state.failure ?? "unavailable" };
}

export type PortFrameState =
  | { readonly kind: "off" }
  | { readonly kind: "opening" }
  /**
   * `firstSrc` — what the frame loads first (the one-time link, or the
   * port's address when this browser already holds its session); `url` —
   * the port's address itself, for reloads.
   */
  | { readonly kind: "ready"; readonly firstSrc: string; readonly url: string }
  | { readonly kind: "failed"; readonly reason: PortLinkFailure };

/**
 * A computer-local page of a cloud computer as a frame of this browser (an
 * app's window, its Home widget, an app tab in the panel): the same port
 * address as "Your site". A frame that comes back with "Open this page from
 * Uno Work" (the cookie is gone) gets a fresh link by itself.
 */
export function usePortFrame(input: {
  readonly localUrl: string | null;
  readonly computer: CloudComputer | null;
}): { readonly state: PortFrameState; readonly retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const preview = usePortPreview({
    url: input.localUrl ?? "",
    computer: input.computer,
    enabled: input.localUrl !== null,
    attempt,
  });
  const link = preview.kind === "ready" ? preview.link : null;
  useEffect(() => {
    if (!link) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== link.origin || !isPortReenterMessage(event.data)) return;
      forgetPortSessionHere(link.port);
      setAttempt((value) => value + 1);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [link]);
  const retry = useMemo(() => () => setAttempt((value) => value + 1), []);
  const state: PortFrameState = useMemo(() => {
    switch (preview.kind) {
      case "off":
        return { kind: "off" };
      case "minting":
        return { kind: "opening" };
      case "failed":
        return { kind: "failed", reason: preview.reason };
      case "ready": {
        const url =
          input.localUrl !== null
            ? (localUrlToPortPreviewUrl(input.localUrl, preview.link.origin) ?? preview.link.url)
            : preview.link.url;
        return { kind: "ready", firstSrc: preview.link.url, url };
      }
    }
  }, [preview, input.localUrl]);
  return { state, retry };
}
