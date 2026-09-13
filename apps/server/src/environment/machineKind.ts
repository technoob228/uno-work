/**
 * What kind of machine this daemon runs on, from cheap local signals.
 *
 * The answer feeds the environment descriptor (`machineKind`), which the UI
 * uses for labels, icons and grouping. It must never depend on who is
 * looking: a box is a box whether it served the page or was added later.
 *
 * Precedence:
 *   1. A known Uno box id (control plane, stored agent token, or `UNO_BOX_ID`
 *      in the daemon's own environment) — the only certain signal.
 *   2. Hostname heuristics for boxes (`*.uno4.dev`, `unowork-golden-*`) —
 *      fallback for a box that has no account key yet.
 *   3. Desktop mode, macOS or Windows — a person's own computer.
 *   4. Anything else — a server.
 *
 * Kept free of Effect so it can be unit-tested with plain values.
 */
import type { MachineKind } from "@t3tools/contracts";

import type { RuntimeMode } from "../config.ts";

export interface MachineKindSignals {
  readonly mode: RuntimeMode;
  readonly platform: NodeJS.Platform;
  readonly hostname: string;
  /** Box id when the daemon has identified its own Uno box; `null` otherwise. */
  readonly unoBoxId: number | null;
}

export interface MachineKindResolution {
  readonly machineKind: MachineKind;
  readonly unoBoxId?: number;
}

const UNO_BOX_HOSTNAME_SUFFIX = ".uno4.dev";
const UNO_BOX_GOLDEN_HOSTNAME_PREFIX = "unowork-golden";

/** Hostname shapes the box images ship with. Heuristic only — a box id wins. */
export function looksLikeUnoBoxHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (normalized.length === 0) return false;
  return (
    normalized.endsWith(UNO_BOX_HOSTNAME_SUFFIX) ||
    normalized.startsWith(UNO_BOX_GOLDEN_HOSTNAME_PREFIX)
  );
}

/** `UNO_BOX_ID` as the daemon's own process sees it; junk reads as unset. */
export function parseUnoBoxIdFromEnvironment(value: string | undefined): number | null {
  const trimmed = value?.trim() ?? "";
  if (!/^\d+$/u.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function resolveMachineKind(signals: MachineKindSignals): MachineKindResolution {
  if (signals.unoBoxId !== null) {
    return { machineKind: "uno_box", unoBoxId: signals.unoBoxId };
  }
  if (looksLikeUnoBoxHostname(signals.hostname)) {
    return { machineKind: "uno_box" };
  }
  if (signals.mode === "desktop") {
    return { machineKind: "computer" };
  }
  if (signals.platform === "darwin" || signals.platform === "win32") {
    return { machineKind: "computer" };
  }
  return { machineKind: "server" };
}
