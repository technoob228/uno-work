/**
 * Which update channel this Work is on: "stage" (Misha's stage computer
 * stage-work and the "Uno Work Stage" desktop app, 16.10) or the release
 * everybody else runs.
 *
 * On the stage channel the Labs flags marked `stageDefault` are on until the
 * person turns them off (featureFlags.ts); everywhere else they keep the
 * release behaviour. One name everywhere — `stage`:
 *
 * - build time: `VITE_UNO_CHANNEL=stage` (a web bundle built for the stage);
 * - the desktop app: its branding says `stageLabel: "Stage"`;
 * - the computer: the daemon reports `environment.channel` — from
 *   `UNO_WORK_CHANNEL=stage`, or the last segment of its update address
 *   (`UNO_WORK_UPDATE_BASE_URL=…/cli/work/stage`, how stage-work is set up);
 * - the mock (`?demo=w0138`) is always the stage.
 *
 * Kept free of React: `featureFlags.ts` reads it outside components.
 *
 * @module unoChannel
 */
import { create } from "zustand";

import { DEMO } from "./demo/demoFlag";

export const STAGE_CHANNEL = "stage";

function stageFromBuild(): boolean {
  if (DEMO) return true;
  if (import.meta.env.VITE_UNO_CHANNEL?.trim() === STAGE_CHANNEL) return true;
  if (typeof window === "undefined") return false;
  try {
    // The type lists the labels the desktop shell had at build time; compare as text.
    const label: string | undefined = window.desktopBridge?.getAppBranding?.()?.stageLabel;
    return label === "Stage";
  } catch {
    return false;
  }
}

interface UnoChannelState {
  /** Built or packaged for the stage. */
  readonly build: boolean;
  /** The computer this app talks to said it is on the stage channel. */
  readonly server: boolean;
}

export const useUnoChannelStore = create<UnoChannelState>(() => ({
  build: stageFromBuild(),
  server: false,
}));

/** The channel the primary computer reported (`environment.channel`). */
export function setServerUpdateChannel(channel: string | null | undefined): void {
  const server = channel?.trim() === STAGE_CHANNEL;
  if (useUnoChannelStore.getState().server !== server) useUnoChannelStore.setState({ server });
}

/** Outside React. */
export function isStageChannel(): boolean {
  const state = useUnoChannelStore.getState();
  return state.build || state.server;
}

export function useIsStageChannel(): boolean {
  return useUnoChannelStore((state) => state.build || state.server);
}
