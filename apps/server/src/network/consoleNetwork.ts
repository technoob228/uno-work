/**
 * The account's Network in the console (fishcode `/api/v1/network`, contract
 * reports/day_2026-11-27/network-tunnel/CONTRACT.md): one switch, exit and
 * protocol for the whole account, the exits (the person's cloud computers
 * with Uno's gateway, Uno's addresses), and this device's key at an exit.
 *
 * Who asks:
 * - a cloud computer: its machine token, `/api/v1/boxes/<id>/work/network…`;
 * - a Mac (or any computer with the person's account key in Settings):
 *   `/api/v1/network…` with the account key, the device named by its
 *   environment id.
 *
 * The console speaks snake_case; the transports it returns are uno-net's own
 * shape (camelCase) and pass through. Answers are read leniently: a field the
 * console adds later is ignored, a missing one gets its empty value.
 *
 * @module network/consoleNetwork
 */
import type {
  NetworkAddressType,
  NetworkComputer,
  NetworkExitKind,
  NetworkProtocol,
  NetworkTransport,
} from "@t3tools/contracts";
import { generateKeyPairSync } from "node:crypto";

import { readConsoleError } from "../automations/consoleClient.ts";
import type { FetchLike } from "../manager/workConsole.ts";
import { controlPlaneBaseUrl } from "../workspaceRegistry/unoCloudParse.ts";
import type { UnoNetTransport } from "./unoNet.ts";

export type ConsoleNetworkCredentials =
  | { readonly kind: "machine"; readonly boxToken: string; readonly boxId: number }
  | { readonly kind: "account"; readonly accountKey: string; readonly deviceId: string };

export interface ConsoleNetworkExit {
  readonly id: string;
  readonly kind: NetworkExitKind;
  readonly label: string;
  readonly boxId: number | null;
  readonly self: boolean;
  /** not_set_up | setting_up | ready | failed | asleep */
  readonly state: string;
  readonly error: string | null;
  readonly country: string | null;
  readonly city: string | null;
  readonly address: string | null;
  readonly addressType: NetworkAddressType;
  readonly protocols: ReadonlyArray<NetworkTransport>;
  readonly available: boolean;
  readonly reason: string | null;
}

export interface ConsoleNetworkState {
  readonly available: boolean;
  readonly enabled: boolean;
  readonly exitId: string | null;
  readonly protocol: NetworkProtocol;
  readonly since: string | null;
  readonly exits: ReadonlyArray<ConsoleNetworkExit>;
  readonly computers: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly kind: NetworkComputer["kind"];
    readonly status: string;
  }>;
}

export interface ConsolePeer {
  readonly exitId: string;
  readonly transports: ReadonlyArray<UnoNetTransport>;
  readonly probe: string | null;
  readonly probeAwg: string | null;
}

export class ConsoleNetworkError extends Error {
  readonly status: number;
  readonly code: string;
  readonly state: string | undefined;
  constructor(status: number, code: string, message: string, state?: string) {
    super(message);
    this.name = "ConsoleNetworkError";
    this.status = status;
    this.code = code;
    this.state = state;
  }
}

export const CONSOLE_NETWORK_UNAVAILABLE: ConsoleNetworkState = {
  available: false,
  enabled: false,
  exitId: null,
  protocol: "auto",
  since: null,
  exits: [],
  computers: [],
};

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const PROTOCOLS = new Set<NetworkProtocol>(["auto", "wireguard", "amneziawg", "openvpn"]);
const TRANSPORTS = new Set<NetworkTransport>(["wireguard", "amneziawg", "openvpn"]);
const KINDS = new Set<NetworkExitKind>(["uno", "computer", "server", "config", "proxy"]);
const ADDRESS_TYPES = new Set<NetworkAddressType>(["clean", "datacenter", "unknown"]);

function parseExit(raw: unknown): ConsoleNetworkExit | null {
  const r = record(raw);
  const id = text(r?.["id"]);
  if (!r || !id) return null;
  const kind = text(r["kind"]) as NetworkExitKind | null;
  const addressType = text(r["address_type"]) as NetworkAddressType | null;
  const protocols = Array.isArray(r["protocols"])
    ? r["protocols"].filter((p): p is NetworkTransport => TRANSPORTS.has(p as NetworkTransport))
    : [];
  const boxId = typeof r["box_id"] === "number" ? r["box_id"] : null;
  return {
    id,
    kind: kind && KINDS.has(kind) ? kind : "computer",
    label: text(r["label"]) ?? id,
    boxId,
    self: r["self"] === true,
    state: text(r["state"]) ?? "ready",
    error: text(r["error"]),
    country: text(r["country"]),
    city: text(r["city"]),
    address: text(r["address"]),
    addressType: addressType && ADDRESS_TYPES.has(addressType) ? addressType : "unknown",
    protocols,
    available: r["available"] !== false,
    reason: text(r["reason"]),
  };
}

export function parseConsoleNetworkState(body: unknown): ConsoleNetworkState {
  const r = record(body);
  if (!r || r["available"] !== true) return CONSOLE_NETWORK_UNAVAILABLE;
  const protocol = text(r["protocol"]) as NetworkProtocol | null;
  const exits = Array.isArray(r["exits"])
    ? r["exits"].map(parseExit).filter((e): e is ConsoleNetworkExit => e !== null)
    : [];
  const computers = Array.isArray(r["computers"])
    ? r["computers"].flatMap((raw) => {
        const c = record(raw);
        const id = c
          ? (text(c["id"]) ?? (typeof c["id"] === "number" ? `box-${c["id"]}` : null))
          : null;
        if (!c || !id) return [];
        return [
          {
            id,
            name: text(c["name"]) ?? id,
            kind: c["kind"] === "desktop" ? ("desktop" as const) : ("cloud" as const),
            status: text(c["status"]) ?? "off",
          },
        ];
      })
    : [];
  return {
    available: true,
    enabled: r["enabled"] === true,
    exitId: text(r["exit_id"]),
    protocol: protocol && PROTOCOLS.has(protocol) ? protocol : "auto",
    since: text(r["since"]),
    exits,
    computers,
  };
}

export function parseConsolePeer(body: unknown): ConsolePeer | null {
  const r = record(body);
  const exitId = text(r?.["exit_id"]);
  if (!r || !exitId || !Array.isArray(r["transports"])) return null;
  const transports = r["transports"].filter((t): t is UnoNetTransport => {
    const tr = record(t);
    return (
      !!tr &&
      (tr["protocol"] === "wireguard" || tr["protocol"] === "amneziawg") &&
      !!record(tr["peer"]) &&
      Array.isArray(tr["addresses"])
    );
  });
  if (transports.length === 0) return null;
  return { exitId, transports, probe: text(r["probe"]), probeAwg: text(r["probe_awg"]) };
}

/** A fresh X25519 pair for this device, base64 as WireGuard writes keys. */
export function newDeviceKey(): { readonly privateKey: string; readonly publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const d = privateKey.export({ format: "jwk" }).d;
  const x = publicKey.export({ format: "jwk" }).x;
  if (!d || !x) throw new Error("x25519 key export failed");
  const std = (b64url: string) => Buffer.from(b64url, "base64url").toString("base64");
  return { privateKey: std(d), publicKey: std(x) };
}

const TIMEOUT_MS = 20_000;

export interface ConsoleNetworkClient {
  readonly state: () => Promise<ConsoleNetworkState>;
  readonly change: (input: {
    readonly enabled?: boolean;
    readonly exitId?: string;
    readonly protocol?: NetworkProtocol;
  }) => Promise<ConsoleNetworkState>;
  readonly registerPeer: (input: {
    readonly publicKey: string;
    readonly exitId: string;
    readonly label: string;
  }) => Promise<ConsolePeer>;
}

/** Message for an error code of the console's Network routes. */
export function consoleNetworkMessage(code: string, detail: string | null): string {
  switch (code) {
    case "NETWORK_NO_EXIT":
      return "Pick an exit first.";
    case "NETWORK_EXIT_NOT_FOUND":
      return "That exit isn't on this account any more.";
    case "NETWORK_EXIT_UNAVAILABLE":
      return "That exit isn't available yet.";
    case "NETWORK_EXIT_SELF":
      return "A computer can't be its own exit. Pick another one.";
    case "NETWORK_EXIT_NOT_READY":
      return "Uno is still setting up that exit.";
    case "NETWORK_EXIT_FAILED":
      return detail ?? "Uno couldn't set up that exit.";
    case "NETWORK_DISABLED":
      return "Network tunnels aren't switched on for this account yet.";
    case "CONSOLE_UNREACHABLE":
      return "The Uno console didn't answer. Try again in a minute.";
    default:
      return detail ?? `The Uno console refused (${code}).`;
  }
}

export function makeConsoleNetworkClient(
  credentials: ConsoleNetworkCredentials,
  fetchImpl: FetchLike = globalThis.fetch,
): ConsoleNetworkClient {
  const base =
    credentials.kind === "machine"
      ? `/api/v1/boxes/${credentials.boxId}/work/network`
      : "/api/v1/network";
  const token = credentials.kind === "machine" ? credentials.boxToken : credentials.accountKey;
  const call = async (method: "GET" | "PUT" | "POST", path: string, body?: unknown) => {
    let response: Response;
    try {
      response = await fetchImpl(`${controlPlaneBaseUrl()}${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ConsoleNetworkError(
        502,
        "CONSOLE_UNREACHABLE",
        consoleNetworkMessage("CONSOLE_UNREACHABLE", null),
      );
    }
    const raw = await response.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {}
    if (!response.ok) {
      const error = readConsoleError(parsed);
      // A console from before Network answers a bare 404.
      const code =
        error.code ??
        (response.status === 404
          ? "NETWORK_DISABLED"
          : response.status >= 500
            ? "CONSOLE_UNREACHABLE"
            : `HTTP_${response.status}`);
      const state = text(record(parsed)?.["state"]) ?? undefined;
      throw new ConsoleNetworkError(
        response.status,
        code,
        consoleNetworkMessage(code, error.detail),
        state,
      );
    }
    return parsed;
  };
  return {
    state: async () => {
      try {
        return parseConsoleNetworkState(await call("GET", ""));
      } catch (error) {
        if (error instanceof ConsoleNetworkError && error.code === "NETWORK_DISABLED") {
          return CONSOLE_NETWORK_UNAVAILABLE;
        }
        throw error;
      }
    },
    change: async (input) =>
      parseConsoleNetworkState(
        await call("PUT", "", {
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...(input.exitId !== undefined ? { exit_id: input.exitId } : {}),
          ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
        }),
      ),
    registerPeer: async (input) => {
      const peer = parseConsolePeer(
        await call("POST", "/peer", {
          public_key: input.publicKey,
          exit_id: input.exitId,
          label: input.label,
          ...(credentials.kind === "account" ? { device_id: credentials.deviceId } : {}),
        }),
      );
      if (!peer) {
        throw new ConsoleNetworkError(
          502,
          "BAD_ANSWER",
          "The Uno console sent an exit it can't use.",
        );
      }
      return peer;
    },
  };
}

/** Which transports a protocol choice keeps: auto — all, in the console's order. */
export function transportsFor(
  transports: ReadonlyArray<UnoNetTransport>,
  protocol: NetworkProtocol,
): ReadonlyArray<UnoNetTransport> {
  if (protocol === "auto") return transports;
  return transports.filter((t) => t.protocol === protocol);
}
