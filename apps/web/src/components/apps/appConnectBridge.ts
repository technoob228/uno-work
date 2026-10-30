/**
 * "Connect" from inside an app's frame (Notetaker → Settings → Calendars,
 * contract 29.10 notetaker-ecosystem): the app posts
 * `window.parent.postMessage({type: "uno-work:connect", provider}, "*")`,
 * and Uno Work starts its usual Connect (the provider's sign-in window, the
 * same as Settings → Connectors).
 *
 * Accepted only when all of it holds:
 * - the message comes from THIS frame's window (`event.source`), not from
 *   another frame or tab;
 * - the frame shows the installed Uno Notetaker (the caller knows its tile);
 * - the provider is a calendar one (gmail | microsoft) — an app can't make
 *   Uno Work open sign-ins of anything else.
 *
 * Electron's `<webview>` has no `window.parent` to post to: there the
 * Notetaker shows its fallback ("Open Uno Work → Settings → Connectors").
 */
import { useEffect, useRef, type RefObject } from "react";

import { useActiveMachine } from "../../hooks/useActiveMachine";
import { useConnectorActions } from "../setup/steps/ConnectorsStep";
import { appPrimaryAction, computerLocalUrl } from "../computer/appPrimaryAction";
import { isNotetakerTile } from "../computer/notetakerApp";
import type { ProgramTile } from "../computer/programModel";
import { useProgramTiles } from "../computer/useProgramTiles";
import { belongsToComputer } from "./appAddress";

export const APP_CONNECT_MESSAGE = "uno-work:connect";

/** The connectors an app's frame may ask for. */
export const APP_CONNECT_PROVIDERS = ["gmail", "microsoft"] as const;
export type AppConnectProvider = (typeof APP_CONNECT_PROVIDERS)[number];

/** The provider of a well-formed connect message; null for anything else. */
export function parseAppConnectMessage(data: unknown): AppConnectProvider | null {
  if (data === null || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (record["type"] !== APP_CONNECT_MESSAGE) return null;
  const provider = record["provider"];
  return typeof provider === "string" &&
    (APP_CONNECT_PROVIDERS as ReadonlyArray<string>).includes(provider)
    ? (provider as AppConnectProvider)
    : null;
}

/** The whole check of one `message` event: from this frame, and a calendar provider. */
export function acceptAppConnect(input: {
  readonly source: unknown;
  readonly frameWindow: unknown;
  readonly data: unknown;
}): AppConnectProvider | null {
  if (input.frameWindow === null || input.frameWindow === undefined) return null;
  if (input.source !== input.frameWindow) return null;
  return parseAppConnectMessage(input.data);
}

/** Is this address the installed Notetaker's (its open address, or its port on the computer)? */
export function isNotetakerAddress(url: string, tiles: ReadonlyArray<ProgramTile>): boolean {
  return tiles.some(
    (tile) =>
      isNotetakerTile(tile) &&
      belongsToComputer(url, [tile.openUrl, appPrimaryAction(tile).url, computerLocalUrl(tile)]),
  );
}

/** For the right panel, which knows only the address: is it the Notetaker? */
export function useIsNotetakerAddress(url: string): boolean {
  const { tiles } = useProgramTiles();
  return isNotetakerAddress(url, tiles);
}

/**
 * Listens to the frame for Connect requests (mounted only for a frame that
 * shows the Notetaker, so other apps don't read the connectors list). One
 * sign-in at a time: a second request while one is open is dropped.
 */
export function AppConnectListener({
  frame,
}: {
  frame: RefObject<HTMLIFrameElement | null>;
}): null {
  useAppConnectBridge(frame, true);
  return null;
}

function useAppConnectBridge(frame: RefObject<HTMLIFrameElement | null>, enabled: boolean): void {
  const { environmentId } = useActiveMachine();
  const actions = useConnectorActions(environmentId);
  const latest = useRef(actions);
  latest.current = actions;
  useEffect(() => {
    if (!enabled) return;
    const onMessage = (event: MessageEvent) => {
      const provider = acceptAppConnect({
        source: event.source,
        frameWindow: frame.current?.contentWindow ?? null,
        data: event.data,
      });
      if (provider === null || latest.current.pending !== null) return;
      void latest.current.connect(provider);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [enabled, frame]);
}
