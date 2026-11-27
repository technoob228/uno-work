/**
 * uno-net, Network's tunnel engine (native/uno-net, Go), as the daemon runs
 * it: one child process per daemon, `uno-net run --lifeline` (it exits when
 * the daemon's end of its stdin closes, so it never outlives the daemon),
 * tokens in its environment only — never on the command line, never in a
 * child's environment, never in a log (both are registered with the log
 * redaction by the caller).
 *
 * The engine is entered through a SOCKS5 server on loopback (username free,
 * password = the SOCKS token); the daemon's local bridge (`proxyBridge.ts`)
 * points at it, so everything Uno Work starts reaches the tunnel through the
 * same HTTP proxy URL as the person's own proxy. While the tunnel is not up
 * the engine refuses every request: nothing goes direct.
 *
 * @module network/unoNet
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import * as Path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { PROXY_ENV_NAMES } from "./proxyEnv.ts";

/** One way to the exit, as uno-net takes it (native/uno-net/internal/config). */
export interface UnoNetTransport {
  readonly protocol?: "wireguard" | "amneziawg";
  readonly privateKey?: string;
  readonly addresses?: ReadonlyArray<string>;
  readonly dns?: ReadonlyArray<string>;
  readonly mtu?: number;
  readonly obfuscation?: Readonly<Record<string, string>>;
  readonly peer?: {
    readonly publicKey: string;
    readonly presharedKey?: string;
    readonly endpoint: string;
    readonly allowedIPs?: ReadonlyArray<string>;
    readonly persistentKeepalive?: number;
  };
  /** An imported wg-quick / AmneziaWG config: the whole transport. */
  readonly conf?: string;
}

export interface UnoNetConfig {
  readonly transports: ReadonlyArray<UnoNetTransport>;
  readonly handshakeTimeoutMs?: number;
  readonly probe?: string;
  readonly probeIntervalMs?: number;
  readonly probeFailures?: number;
}

export type UnoNetEngineStatus = "off" | "connecting" | "on" | "down";

/** `GET /v1/status`, the fields the daemon reads. */
export interface UnoNetStatus {
  readonly status: UnoNetEngineStatus;
  readonly configured: boolean;
  readonly activeProtocol?: "wireguard" | "amneziawg";
  readonly endpoint?: string;
  readonly since?: string;
  readonly lastHandshake?: string;
  readonly rxBytes: number;
  readonly txBytes: number;
  readonly latencyMs?: number;
  readonly error?: string;
  readonly version?: string;
}

/** Where this platform's binary is: `apps/server/dist/native/<platform>-<arch>/<name>`. */
export function nativeBinaryCandidates(
  name: "uno-net" | "uno-gw",
  input: {
    readonly moduleUrl: string;
    readonly platform?: string;
    readonly arch?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
  },
): ReadonlyArray<string> {
  const env = input.env ?? process.env;
  const override = name === "uno-net" ? env["UNO_NET_BIN"] : env["UNO_GW_BIN"];
  const dir = `${input.platform ?? process.platform}-${input.arch ?? process.arch}`;
  const file = (input.platform ?? process.platform) === "win32" ? `${name}.exe` : name;
  const here = Path.dirname(fileURLToPath(input.moduleUrl));
  // Packaged desktop: dist/ sits in app.asar, the binary in app.asar.unpacked.
  const unpacked = (path: string) => path.replace(/app\.asar(?=[/\\])/, "app.asar.unpacked");
  const candidates = [
    ...(override ? [override] : []),
    // dist/bin.mjs (bundled) → dist/native/…
    unpacked(Path.join(here, "native", dir, file)),
    // src/network/unoNet.ts (dev) → native/uno-net/dist/… in the repo
    Path.resolve(here, "../../../../native/uno-net/dist", dir, file),
    Path.resolve(here, "../../../native/uno-net/dist", dir, file),
  ];
  return [...new Set(candidates)];
}

export function findNativeBinary(
  name: "uno-net" | "uno-gw",
  moduleUrl: string = import.meta.url,
): string | null {
  return nativeBinaryCandidates(name, { moduleUrl }).find((path) => existsSync(path)) ?? null;
}

/** The environment uno-net runs with: the daemon's minus proxy variables, plus its tokens. */
export function unoNetEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  tokens: { readonly socks: string; readonly control: string },
): Record<string, string> {
  const env: Record<string, string> = {};
  const drop = new Set<string>(PROXY_ENV_NAMES.flatMap((name) => [name, name.toLowerCase()]));
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || drop.has(key) || drop.has(key.toUpperCase())) continue;
    if (key.startsWith("UNO_NET_")) continue;
    env[key] = value;
  }
  env["UNO_NET_SOCKS_TOKEN"] = tokens.socks;
  env["UNO_NET_CONTROL_TOKEN"] = tokens.control;
  return env;
}

export interface UnoNetEngine {
  /** 127.0.0.1:port of its SOCKS5. */
  readonly socks: { readonly host: string; readonly port: number };
  readonly socksToken: string;
  readonly version: string | null;
  readonly status: () => Promise<UnoNetStatus>;
  readonly apply: (config: UnoNetConfig) => Promise<UnoNetStatus>;
  readonly clear: () => Promise<void>;
  /** Called once when the process is gone (crash or stop). */
  readonly onExit: (listener: (reason: string) => void) => void;
  readonly stop: () => Promise<void>;
}

export class UnoNetStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnoNetStartError";
  }
}

const READY_TIMEOUT_MS = 10_000;
const CONTROL_TIMEOUT_MS = 8_000;

function parseHostPort(raw: unknown): { host: string; port: number } | null {
  if (typeof raw !== "string") return null;
  const match = /^(127\.\d+\.\d+\.\d+):(\d+)$/.exec(raw);
  if (!match?.[1] || !match[2]) return null;
  return { host: match[1], port: Number(match[2]) };
}

/** Start `uno-net run --lifeline` and wait for its ready line. */
export async function startUnoNet(input: {
  readonly binary: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly onLog?: (line: string) => void;
}): Promise<UnoNetEngine> {
  const socksToken = randomBytes(24).toString("hex");
  const controlToken = randomBytes(24).toString("hex");
  const child: ChildProcess = spawn(input.binary, ["run", "--lifeline"], {
    env: unoNetEnvironment(input.env ?? process.env, { socks: socksToken, control: controlToken }),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const exitListeners: Array<(reason: string) => void> = [];
  let exited: string | null = null;
  const onGone = (reason: string) => {
    if (exited !== null) return;
    exited = reason;
    for (const listener of exitListeners) listener(reason);
  };
  child.once("exit", (code, signal) => onGone(signal ? `stopped (${signal})` : `exited (${code})`));
  child.once("error", (error) => onGone(error.message));
  if (child.stderr) {
    createInterface({ input: child.stderr }).on("line", (line) => input.onLog?.(line));
  }

  const ready = await new Promise<{ socks: string; control: string; version: string | null }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new UnoNetStartError("The tunnel engine didn't start in time."));
      }, READY_TIMEOUT_MS);
      exitListeners.push((reason) => {
        clearTimeout(timer);
        reject(new UnoNetStartError(`The tunnel engine ${reason}.`));
      });
      if (!child.stdout) {
        reject(new UnoNetStartError("The tunnel engine has no output."));
        return;
      }
      createInterface({ input: child.stdout }).once("line", (line) => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed["ready"] !== true) throw new Error("not ready");
          resolve({
            socks: String(parsed["socks"]),
            control: String(parsed["control"]),
            version: typeof parsed["version"] === "string" ? parsed["version"] : null,
          });
        } catch {
          reject(new UnoNetStartError("The tunnel engine answered something unexpected."));
        }
      });
    },
  ).catch((error: unknown) => {
    child.kill("SIGKILL");
    throw error;
  });

  const socks = parseHostPort(ready.socks);
  const control = parseHostPort(ready.control);
  if (!socks || !control) {
    child.kill("SIGKILL");
    throw new UnoNetStartError("The tunnel engine listens somewhere other than this computer.");
  }
  const base = `http://${control.host}:${control.port}`;
  const call = async (method: "GET" | "PUT" | "DELETE", path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${controlToken}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed.error === "string") message = parsed.error;
      } catch {}
      throw new Error(message);
    }
    return text ? (JSON.parse(text) as UnoNetStatus) : null;
  };

  return {
    socks,
    socksToken,
    version: ready.version,
    status: async () => (await call("GET", "/v1/status")) as UnoNetStatus,
    apply: async (config) => (await call("PUT", "/v1/config", config)) as UnoNetStatus,
    clear: async () => {
      await call("DELETE", "/v1/config");
    },
    onExit: (listener) => {
      if (exited !== null) listener(exited);
      else exitListeners.push(listener);
    },
    stop: () =>
      new Promise<void>((resolve) => {
        if (exited !== null) {
          resolve();
          return;
        }
        exitListeners.push(() => resolve());
        // The lifeline: closing stdin is the polite stop; a kill if it lingers.
        child.stdin?.end();
        setTimeout(() => {
          if (exited === null) child.kill("SIGTERM");
        }, 2_000).unref();
        setTimeout(() => {
          if (exited === null) child.kill("SIGKILL");
        }, 5_000).unref();
      }),
  };
}

/** `uno-net parse-conf`: a wg-quick / AmneziaWG text → the transport (checks it). */
export async function parseConfWithUnoNet(
  binary: string,
  conf: string,
): Promise<{ ok: true; transport: UnoNetTransport } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    const child = spawn(binary, ["parse-conf"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env["PATH"] ?? "" },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, reason: "The tunnel engine isn't installed on this computer." });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        try {
          resolve({ ok: true, transport: JSON.parse(out) as UnoNetTransport });
          return;
        } catch {}
      }
      // "uno-net: config: …" → the part after the program name, without key material.
      const reason = err
        .replace(/^uno-net:\s*/m, "")
        .trim()
        .split("\n")[0]
        // A line quoted back may hold a key: never echo key material.
        ?.replace(/[A-Za-z0-9+/]{32,}={0,2}/g, "…");
      resolve({
        ok: false,
        reason: reason ? `This config can't be used: ${reason}.` : "This config can't be used.",
      });
    });
    child.stdin.end(conf);
  });
}
