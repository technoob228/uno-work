/**
 * The tunnel as the daemon keeps it: what config uno-net should run
 * (`setDesired`), the engine process itself (started on demand, restarted
 * if it dies while wanted, stopped when nothing is wanted) and its state,
 * polled from the engine's control API.
 *
 * Fail-closed lives in two places: the engine refuses SOCKS requests while
 * its tunnel isn't up, and while the engine isn't there at all (missing,
 * crashed, starting) `socks()` is null — the bridge then refuses too
 * ("blocked"), it never goes direct.
 *
 * @module network/tunnelRuntime
 */
import type { NetworkTransport } from "@t3tools/contracts";

import { registerKnownSecret } from "../secretRedaction.ts";
import {
  type UnoNetConfig,
  type UnoNetEngine,
  type UnoNetEngineStatus,
  type UnoNetStatus,
  startUnoNet,
} from "./unoNet.ts";

export interface TunnelSnapshot {
  /** off — nothing wanted; else the engine's view (connecting while it starts). */
  readonly status: UnoNetEngineStatus;
  readonly activeProtocol: NetworkTransport | null;
  readonly latencyMs: number | null;
  readonly since: string | null;
  /** A sentence for the person when it can't come up. */
  readonly error: string | null;
}

export interface TunnelRuntime {
  /** null — stop. `key` names the config: the same key again changes nothing. */
  readonly setDesired: (config: UnoNetConfig | null, key: string | null) => Promise<void>;
  readonly snapshot: () => TunnelSnapshot;
  /** The engine's SOCKS while it runs; null while there's no engine. */
  readonly socks: () => {
    readonly host: string;
    readonly port: number;
    readonly token: string;
  } | null;
  readonly onChange: (listener: () => void) => void;
  readonly close: () => Promise<void>;
}

const OFF: TunnelSnapshot = {
  status: "off",
  activeProtocol: null,
  latencyMs: null,
  since: null,
  error: null,
};

export const ENGINE_MISSING_MESSAGE =
  "The tunnel engine isn't installed on this computer. Update Uno Work.";

const POLL_MS = 2_000;
const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

/** How a protocol is written in a sentence the person reads. */
export const TRANSPORT_LABEL: Record<NetworkTransport, string> = {
  wireguard: "WireGuard",
  amneziawg: "AmneziaWG",
  openvpn: "OpenVPN",
};

/**
 * The engine's last words → a sentence (uno-net already speaks plainly; keep
 * it short). It names protocols by their ids ("over wireguard"); the panel
 * writes them as their names.
 */
export function engineError(status: Pick<UnoNetStatus, "error">): string | null {
  if (!status.error) return null;
  const first = (status.error.split("\n")[0] ?? status.error)
    .trim()
    .replace(
      /\b(wireguard|amneziawg|openvpn)\b/gi,
      (id) => TRANSPORT_LABEL[id.toLowerCase() as NetworkTransport],
    );
  const short = first.length > 200 ? `${first.slice(0, 200)}…` : first;
  // A sentence for the panel: "The exit stopped answering."
  const sentence = short.charAt(0).toUpperCase() + short.slice(1);
  return /[.!?…]$/.test(sentence) ? sentence : `${sentence}.`;
}

export function makeTunnelRuntime(options: {
  /** Path of uno-net; null — not installed. */
  readonly binary: string | null;
  readonly start?: typeof startUnoNet;
  readonly pollMs?: number;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}): TunnelRuntime {
  const start = options.start ?? startUnoNet;
  const pollMs = options.pollMs ?? POLL_MS;
  const log = options.log ?? (() => {});
  let desired: { config: UnoNetConfig; key: string } | null = null;
  let applied: string | null = null;
  let engine: UnoNetEngine | null = null;
  let starting: Promise<UnoNetEngine | null> | null = null;
  let snapshot: TunnelSnapshot = OFF;
  let restarts = 0;
  let poller: ReturnType<typeof setInterval> | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const listeners: Array<() => void> = [];

  const emit = (next: TunnelSnapshot) => {
    const changed = JSON.stringify(next) !== JSON.stringify(snapshot);
    snapshot = next;
    if (changed) for (const listener of listeners) listener();
  };

  const fromEngine = (status: UnoNetStatus): TunnelSnapshot => ({
    status: !status.configured || status.status === "off" ? "connecting" : status.status,
    activeProtocol: status.activeProtocol ?? null,
    latencyMs: typeof status.latencyMs === "number" ? status.latencyMs : null,
    since: status.status === "on" ? (status.since ?? null) : null,
    error: status.status === "down" ? engineError(status) : null,
  });

  const stopPolling = () => {
    if (poller) clearInterval(poller);
    poller = null;
  };

  const poll = async () => {
    const current = engine;
    if (!current || !desired) return;
    try {
      emit(fromEngine(await current.status()));
    } catch {
      // The engine is busy or going away; its exit handler takes over.
    }
  };

  const ensureEngine = async (): Promise<UnoNetEngine | null> => {
    if (engine) return engine;
    if (starting) return starting;
    if (!options.binary) {
      emit({ ...OFF, status: "down", error: ENGINE_MISSING_MESSAGE });
      return null;
    }
    const binary = options.binary;
    starting = start({
      binary,
      onLog: (line) => {
        // uno-net logs JSON (slog) with no secrets; keep warnings and errors.
        if (/"level":"(WARN|ERROR)"/.test(line))
          log("network: engine", { line: line.slice(0, 500) });
      },
    })
      .then((started) => {
        registerKnownSecret(started.socksToken);
        engine = started;
        applied = null;
        started.onExit((reason) => {
          if (engine !== started) return;
          engine = null;
          applied = null;
          stopPolling();
          if (closed || !desired) return;
          log("network: engine stopped, restarting", { reason });
          emit({ ...OFF, status: "down", error: "The tunnel engine stopped. Restarting it…" });
          scheduleRestart();
        });
        return started;
      })
      .catch((error: unknown) => {
        log("network: engine didn't start", { cause: String(error) });
        emit({
          ...OFF,
          status: "down",
          error: error instanceof Error ? error.message : "The tunnel engine didn't start.",
        });
        scheduleRestart();
        return null;
      })
      .finally(() => {
        starting = null;
      });
    return starting;
  };

  const scheduleRestart = () => {
    if (restartTimer || closed || !desired) return;
    const wait = RESTART_BACKOFF_MS[Math.min(restarts, RESTART_BACKOFF_MS.length - 1)] ?? 30_000;
    restarts += 1;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      void reconcile();
    }, wait);
    restartTimer.unref?.();
  };

  const reconcile = async () => {
    if (closed) return;
    const want = desired;
    if (!want) {
      stopPolling();
      const current = engine;
      engine = null;
      applied = null;
      emit(OFF);
      await current?.stop();
      return;
    }
    const current = await ensureEngine();
    if (!current || desired !== want) return;
    if (applied !== want.key) {
      try {
        const status = await current.apply(want.config);
        applied = want.key;
        restarts = 0;
        emit(fromEngine(status));
      } catch (error) {
        emit({
          ...OFF,
          status: "down",
          error: `The tunnel engine refused this exit: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }
    }
    if (!poller) {
      poller = setInterval(() => void poll(), pollMs);
      poller.unref?.();
    }
  };

  return {
    setDesired: async (config, key) => {
      if (config === null || key === null) {
        if (desired === null && !engine) return;
        desired = null;
      } else {
        if (desired?.key === key && engine && applied === key) return;
        desired = { config, key };
        if (snapshot.status === "off") emit({ ...OFF, status: "connecting" });
      }
      await reconcile();
    },
    snapshot: () => snapshot,
    socks: () =>
      engine && desired
        ? { host: engine.socks.host, port: engine.socks.port, token: engine.socksToken }
        : null,
    onChange: (listener) => {
      listeners.push(listener);
    },
    close: async () => {
      closed = true;
      stopPolling();
      if (restartTimer) clearTimeout(restartTimer);
      const current = engine;
      engine = null;
      await current?.stop();
    },
  };
}
