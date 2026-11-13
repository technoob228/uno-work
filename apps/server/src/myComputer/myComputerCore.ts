/**
 * "Connect my computer" in plain async code: the console's routes, one channel
 * per computer, and the operations an agent runs through them. The Effect
 * service (`MyComputerService.ts`) only wires it to the daemon.
 *
 * Everything that reaches the computer leaves a line in the journal first (a
 * batch of `quiet` calls shares the one line its caller wrote with `note`), and
 * nothing here passes a command's output or a file's content to a log.
 *
 * @module myComputer/myComputerCore
 */
import type {
  MyComputer,
  MyComputerActivity,
  MyComputerPairing,
  MyComputerPairState,
  MyComputerPairStatus,
  MyComputerStatus,
  MyComputerTier,
} from "@t3tools/contracts";

import { consoleRequest, type ConsoleRequest } from "../unoWork/consoleClient.ts";
import { makeActivityLog, type ActivityFinish, type ActivityLog } from "./activityLog.ts";
import {
  MAX_DATA_CHUNK_BYTES,
  openComputerChannel,
  type ChannelCall,
  type ComputerChannel,
  type HelperFrame,
  type HelperRequest,
} from "./channel.ts";
import { OutputCollector, type CollectedOutput } from "./outputCollector.ts";
import {
  keyOwner,
  loadOrCreateBoxKey,
  signFrame,
  SIGNATURE_REFUSALS,
  type BoxKey,
} from "./frameSigning.ts";

export const EXEC_DEFAULT_TIMEOUT_MS = 120_000;
export const EXEC_MAX_TIMEOUT_MS = 1_800_000;
/** The helper stops a command itself at `timeoutMs`; ours is the backstop. */
const EXEC_BACKSTOP_MS = 2_000;
/**
 * A helper says `started` at once: this much silence means the computer went
 * to sleep with the tunnel still up, and `exec` never reached a running helper.
 * Past the helper's own 10 s sleep check, so what the agent was told holds: a
 * command it hears "didn't start" about doesn't run when the computer wakes.
 */
const EXEC_START_TIMEOUT_MS = 15_000;
/** From `kill` to the hard kill. */
const KILL_GRACE_MS = 3_000;
/** One file operation; a command has its own timeout. */
const FILE_OP_TIMEOUT_MS = 30_000;

/** The biggest file moved through the tunnel in one call, either way. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

const TOOLS_VISIBLE_TTL_MS = 60_000;
/** How old the console's word on a computer's M7 state may be when a channel opens. */
const META_TTL_MS = 30_000;
/** A key the console refused is offered again after this. */
const KEY_RETRY_MS = 5 * 60_000;
/** One update attempt per computer per this long. */
const HELPER_UPDATE_EVERY_MS = 6 * 60 * 60_000;
const HELPER_UPDATE_TIMEOUT_MS = 120_000;
/** `tools/list` must stay quick: past this it answers from what it knew. */
const TOOLS_VISIBLE_WAIT_MS = 2_500;

export type MyComputerFailureKind =
  | "off"
  | "console"
  | "remote"
  | "timeout"
  | "cancelled"
  | "too-large"
  | "home-folder";

/** A failure with a sentence the agent (or the person) can act on. */
export class MyComputerFailure extends Error {
  readonly kind: MyComputerFailureKind;
  constructor(kind: MyComputerFailureKind, message: string) {
    super(message);
    this.name = "MyComputerFailure";
    this.kind = kind;
  }
}

const OFF_MESSAGE =
  "Connecting a computer works from an Uno cloud computer; this one isn't linked to the Uno console.";

/** How the trust gate judged a call (`trust/`): the journal line says so. */
export interface CallTrust {
  readonly tier: MyComputerTier;
  readonly threadTitle?: string | undefined;
}

export interface ExecInput {
  readonly computerId: string;
  readonly cmd: string;
  readonly trust?: CallTrust | undefined;
  readonly cwd?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly threadId?: string | undefined;
  /** No journal line of its own: the caller wrote one for the batch with `note`. */
  readonly quiet?: boolean | undefined;
  /** How much output to keep; the agent's default suits a person reading it. */
  readonly maxOutputBytes?: number | undefined;
}

export interface ExecResult extends CollectedOutput {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export interface ReadInput {
  readonly computerId: string;
  readonly path: string;
  readonly trust?: CallTrust | undefined;
  readonly offset?: number | undefined;
  /** How much to read at most. */
  readonly maxBytes: number;
  readonly threadId?: string | undefined;
  /** See ExecInput.quiet. */
  readonly quiet?: boolean | undefined;
}

export interface ReadResult {
  readonly data: Buffer;
  readonly offset: number;
  /** True when the end of the file was reached. */
  readonly eof: boolean;
}

export interface WriteInput {
  readonly computerId: string;
  readonly path: string;
  readonly trust?: CallTrust | undefined;
  readonly data: Uint8Array;
  readonly append?: boolean | undefined;
  readonly mkdirs?: boolean | undefined;
  readonly threadId?: string | undefined;
}

export interface ListInput {
  readonly computerId: string;
  readonly path: string;
  readonly trust?: CallTrust | undefined;
  readonly threadId?: string | undefined;
  /** See ExecInput.quiet. */
  readonly quiet?: boolean | undefined;
}

/** Shape of an answer from the helper: the contract leaves it open. */
export type HelperAnswer = Readonly<Record<string, unknown>>;

const FRAME_FIELDS: ReadonlySet<string> = new Set(["id", "ch", "v", "type"]);

/**
 * What the console says about a computer beyond the contract's `MyComputer`:
 * its purpose and M7 state. Kept here, read by the routing and the RPC layer.
 */
export interface ComputerMeta {
  /** Absent: a console from before the purpose was kept there. */
  readonly mode: "tool" | "full" | null;
  /** The helper verifies signed frames (M7). */
  readonly signedFrames: boolean;
  /** The helper trusts this cloud computer's key; null: unknown, old helper. */
  readonly trustsThisBox: boolean | null;
}

/** Account-wide parts of the console's list. */
export interface ComputersMeta {
  readonly lifecycle: boolean;
  readonly latestHelperVersion: string | null;
  readonly computers: ReadonlyMap<string, ComputerMeta>;
}

export interface MyComputerCoreOptions {
  /** `settings.uno.boxToken`, or "" where there is none. */
  readonly token: () => Promise<string>;
  /** `settings.uno.boxId`, or null: whom this computer's M7 key belongs to. */
  readonly boxId?: () => Promise<number | null>;
  /** Where the helper is downloaded from (its update script). Default: `<console>/cli/connect`. */
  readonly helperDownloadUrl?: () => string;
  readonly baseUrl: () => string;
  readonly stateDir: string;
  readonly fetchImpl?: typeof fetch;
  /** A journal line couldn't be written (the action goes on). */
  readonly warn?: (message: string) => void;
  readonly now?: () => Date;
  /** Tests. */
  readonly timings?: {
    readonly connectTimeoutMs?: number;
    readonly idleCloseMs?: number;
    readonly execBackstopMs?: number;
    readonly killGraceMs?: number;
    readonly fileOpTimeoutMs?: number;
    readonly execStartTimeoutMs?: number;
    readonly toolsVisibleTtlMs?: number;
    readonly toolsVisibleWaitMs?: number;
  };
}

export interface MyComputerCore {
  /** Where its journal lives; the trust settings live next to it. */
  readonly stateDir: string;
  readonly status: () => Promise<MyComputerStatus>;
  /** `status`, or the last answer when it is at most `maxAgeMs` old (tool calls). */
  readonly cachedStatus: (maxAgeMs: number) => Promise<MyComputerStatus>;
  /** What the last `status` learned beyond the contract (purpose, M7); null before one. */
  readonly meta: () => ComputersMeta | null;
  /** Set the computer's purpose at the console. */
  readonly setMode: (computerId: string, mode: "tool" | "full") => Promise<void>;
  readonly pair: () => Promise<MyComputerPairing>;
  readonly pairStatus: (code: string) => Promise<MyComputerPairStatus>;
  readonly disconnect: (computerId: string) => Promise<void>;
  readonly activity: (computerId: string, limit?: number) => Promise<MyComputerActivity>;
  /** One journal line for a batch of `quiet` calls. */
  readonly note: (
    computerId: string,
    kind: "run" | "read" | "write" | "list",
    summary: string,
    threadId?: string,
  ) => Promise<void>;
  /** Show the `my_computer_*` tools: the feature is on and a computer is connected. */
  readonly toolsVisible: () => Promise<boolean>;
  readonly exec: (input: ExecInput, signal?: AbortSignal) => Promise<ExecResult>;
  readonly read: (input: ReadInput, signal?: AbortSignal) => Promise<ReadResult>;
  readonly write: (input: WriteInput, signal?: AbortSignal) => Promise<{ readonly bytes: number }>;
  readonly list: (input: ListInput, signal?: AbortSignal) => Promise<HelperAnswer>;
  readonly stat: (
    input: { readonly computerId: string; readonly path: string },
    signal?: AbortSignal,
  ) => Promise<HelperAnswer>;
  readonly info: (computerId: string, signal?: AbortSignal) => Promise<HelperAnswer>;
  /** A call the trust gate refused: one journal line, nothing runs. */
  readonly refused: (input: {
    readonly computerId: string;
    readonly kind: "run" | "read" | "write" | "list";
    readonly summary: string;
    readonly threadId?: string | undefined;
    readonly threadTitle?: string | undefined;
    readonly tier: MyComputerTier;
    readonly reason: string;
  }) => Promise<void>;
  /** Agents' calls running there now (exec, read, write, list). */
  readonly running: () => number;
  /** Stop every running call ("Stop all agents"): how many were stopped. */
  readonly abortAll: () => number;
  readonly closeAll: () => void;
}

// ── Console answers ────────────────────────────────────────────────────

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const stringOr = (value: unknown, fallback: string) =>
  typeof value === "string" ? value : fallback;
const nullableString = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : null;
const idOf = (value: unknown) =>
  typeof value === "number" ? String(value) : nullableString(value);

function parseComputer(raw: unknown): MyComputer | null {
  const record = asRecord(raw);
  const id = idOf(record.id);
  if (id === null) return null;
  return {
    id,
    name: stringOr(record.name, ""),
    os: stringOr(record.os, ""),
    arch: stringOr(record.arch, ""),
    online: record.online === true,
    connectedAt: nullableString(record.connectedAt),
    lastSeenAt: nullableString(record.lastSeenAt),
    helperVersion: nullableString(record.helperVersion),
    ...(record.mode === "full" || record.mode === "tool" ? { mode: record.mode } : {}),
    ...(typeof record.trustsThisBox === "boolean" || record.trustsThisBox === null
      ? { trustsThisComputer: record.trustsThisBox }
      : {}),
  };
}

export function parseComputersMeta(body: unknown): ComputersMeta {
  const record = asRecord(body);
  const computers = new Map<string, ComputerMeta>();
  if (Array.isArray(record.computers)) {
    for (const raw of record.computers) {
      const entry = asRecord(raw);
      const id = idOf(entry.id);
      if (id === null) continue;
      computers.set(id, {
        mode: entry.mode === "full" || entry.mode === "tool" ? entry.mode : null,
        signedFrames: entry.signedFrames === true,
        trustsThisBox: typeof entry.trustsThisBox === "boolean" ? entry.trustsThisBox : null,
      });
    }
  }
  return {
    lifecycle: record.lifecycle === true,
    latestHelperVersion: nullableString(asRecord(record.helper).latestVersion),
    computers,
  };
}

export function parseComputers(body: unknown): MyComputerStatus {
  const record = asRecord(body);
  const computers = Array.isArray(record.computers)
    ? record.computers.map(parseComputer).filter((entry) => entry !== null)
    : [];
  return {
    enabled: record.enabled === true,
    computers,
    ...(typeof record.lifecycle === "boolean" ? { lifecycle: record.lifecycle } : {}),
  };
}

const PAIR_STATES: ReadonlySet<string> = new Set(["waiting", "claimed", "failed", "expired"]);

function parsePairStatus(body: unknown): MyComputerPairStatus {
  const record = asRecord(body);
  const state = stringOr(record.state, "");
  if (!PAIR_STATES.has(state)) {
    throw new MyComputerFailure("console", "The Uno console gave an unexpected pairing state.");
  }
  return {
    state: state as MyComputerPairState,
    step: nullableString(record.step),
    message: nullableString(record.message),
    computerId: idOf(record.computerId),
  };
}

function parsePairing(body: unknown): MyComputerPairing {
  const record = asRecord(body);
  const commands = asRecord(record.commands);
  const code = stringOr(record.code, "").trim();
  if (code.length === 0) {
    throw new MyComputerFailure("console", "The Uno console didn't give a pairing code.");
  }
  return {
    code,
    url: stringOr(record.url, ""),
    commands: {
      mac: stringOr(commands.mac, ""),
      linux: stringOr(commands.linux, ""),
      windows: stringOr(commands.windows, ""),
    },
    expiresAt: stringOr(record.expiresAt, ""),
    // A console from before doesn't send them: the desktop reads the script then.
    ...(httpsUrl(record.api) ? { api: httpsUrl(record.api)! } : {}),
    ...(httpsUrl(record.download) ? { download: httpsUrl(record.download)! } : {}),
  };
}

function httpsUrl(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return /^https:\/\/[^\s]+$/.test(text) ? text.replace(/\/+$/, "") : null;
}

function consoleDetail(reply: { readonly status: number; readonly body: unknown }): string {
  const body = asRecord(reply.body);
  const detail =
    nullableString(body.message) ?? nullableString(body.error) ?? nullableString(body.code);
  if (detail) return detail.slice(0, 300);
  return reply.status >= 500
    ? `Uno is restarting or unavailable right now (HTTP ${reply.status}). It's usually back within a minute: try again shortly`
    : `HTTP ${reply.status}`;
}

const isAnswer = (status: number) => status >= 200 && status < 300;
/** The route isn't there or isn't for this account: the feature is off, not broken. */
const meansOff = (status: number) =>
  status === 401 || status === 403 || status === 404 || status === 405 || status === 501;

// ── Picking a computer ─────────────────────────────────────────────────

const describe = (computer: MyComputer) =>
  `${computer.name || computer.id} (id ${computer.id}, ${computer.online ? "online" : "offline"})`;

/**
 * The computer a tool call means: `selector` (an id or a name) or the only one.
 * Throws a sentence for the agent; an offline computer is refused here, so no
 * call waits on a laptop that is closed.
 */
export function pickComputer(status: MyComputerStatus, selector: string | undefined): MyComputer {
  if (!status.enabled || status.computers.length === 0) {
    throw new MyComputerFailure(
      "off",
      "No computer of the person is connected. They can connect one in Uno Work (one command in a terminal); don't try another way.",
    );
  }
  const wanted = selector?.trim().toLowerCase();
  let found: MyComputer | undefined;
  if (wanted) {
    const named = status.computers.filter(
      (computer) => computer.id.toLowerCase() === wanted || computer.name.toLowerCase() === wanted,
    );
    if (named.length > 1) {
      throw new MyComputerFailure(
        "remote",
        `Several computers are called “${selector}”; name one by its id: ${named.map(describe).join("; ")}.`,
      );
    }
    found = named[0];
    if (!found) {
      throw new MyComputerFailure(
        "remote",
        `No connected computer is called “${selector}”. Connected: ${status.computers.map(describe).join("; ")}.`,
      );
    }
  } else if (status.computers.length > 1) {
    throw new MyComputerFailure(
      "remote",
      `The person has several computers; name one in \`computer\`: ${status.computers.map(describe).join("; ")}.`,
    );
  } else {
    found = status.computers[0];
  }
  if (!found!.online) {
    throw new MyComputerFailure(
      "remote",
      `“${found!.name || found!.id}” is asleep or offline. Ask the person to open it, then try again.`,
    );
  }
  return found!;
}

// ── The core ───────────────────────────────────────────────────────────

const decodeData = (value: unknown): Buffer =>
  typeof value === "string" ? Buffer.from(value, "base64") : Buffer.alloc(0);

function remoteFailure(frame: HelperFrame): MyComputerFailure {
  const code = nullableString(frame["code"]);
  const refusal = code === null ? undefined : SIGNATURE_REFUSALS[code];
  if (refusal !== undefined) {
    return new MyComputerFailure("remote", `The computer ${refusal}`);
  }
  const message = nullableString(frame["message"]) ?? code;
  return new MyComputerFailure(
    "remote",
    `The computer answered: ${message?.slice(0, 500) ?? "it couldn't do that."}`,
  );
}

const cancelled = () => new MyComputerFailure("cancelled", "Cancelled.");
/** How a read, write or list ended when it returned. */
const ran = (_value: unknown, durationMs: number): ActivityFinish => ({
  outcome: "ran",
  durationMs,
});

const notStarted = () =>
  new MyComputerFailure(
    "remote",
    "The computer didn't start this command: it stopped answering, so it is probably asleep. Ask the person to open it, then try again.",
  );

export function createMyComputerCore(options: MyComputerCoreOptions): MyComputerCore {
  const channels = new Map<string, ComputerChannel>();
  const journal: ActivityLog = makeActivityLog({
    stateDir: options.stateDir,
    ...(options.now ? { now: options.now } : {}),
  });
  const timings = options.timings ?? {};
  const killGraceMs = timings.killGraceMs ?? KILL_GRACE_MS;

  const consoleCall = async (request: ConsoleRequest, what: string) => {
    const token = await options.token();
    if (token.length === 0) throw new MyComputerFailure("off", OFF_MESSAGE);
    try {
      return await consoleRequest({
        ...request,
        baseUrl: options.baseUrl(),
        token,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
    } catch (cause) {
      throw new MyComputerFailure(
        "console",
        `The Uno console didn't answer while trying to ${what}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  };

  // What `tools/list` asks for every chat that starts: cheap and never slow.
  let visible: { readonly value: boolean; readonly at: number } | null = null;
  let checking: Promise<boolean> | null = null;
  const forgetVisible = () => {
    visible = null;
  };

  // What the console said last beyond the contract (purpose, M7).
  let lastMeta: { readonly value: ComputersMeta; readonly at: number } | null = null;
  let lastStatus: MyComputerStatus | null = null;

  const status: MyComputerCore["status"] = async () => {
    const token = await options.token();
    if (token.length === 0) return { enabled: false, computers: [] };
    const reply = await consoleCall(
      { method: "GET", path: "/api/v1/work/computers" },
      "list the computers",
    );
    if (isAnswer(reply.status)) {
      lastMeta = { value: parseComputersMeta(reply.body), at: Date.now() };
      lastStatus = parseComputers(reply.body);
      return lastStatus;
    }
    if (meansOff(reply.status)) return { enabled: false, computers: [] };
    throw new MyComputerFailure("console", `Couldn't list the computers: ${consoleDetail(reply)}.`);
  };

  /** The computer's M7 state, at most 30 s old (a fresh list otherwise). */
  const metaOf = async (computerId: string): Promise<ComputerMeta | null> => {
    if (lastMeta === null || Date.now() - lastMeta.at > META_TTL_MS) {
      await status().catch(() => undefined);
    }
    return lastMeta?.value.computers.get(computerId) ?? null;
  };

  // ── M7: this computer's key, registered once per process ──────────────
  let boxKey: Promise<BoxKey | null> | null = null;
  let registered: Promise<boolean> | null = null;
  let registeredAt = 0;

  const keyOf = (): Promise<BoxKey | null> => {
    boxKey ??= (async () => {
      const owner = keyOwner({
        boxId: (await options.boxId?.().catch(() => null)) ?? null,
        token: await options.token(),
      });
      if (owner.length === 0) return null;
      return loadOrCreateBoxKey(options.stateDir, owner);
    })().catch((cause) => {
      options.warn?.(`my-computer key: ${cause instanceof Error ? cause.message : String(cause)}`);
      boxKey = null;
      return null;
    });
    return boxKey;
  };

  /** The console knows this computer's public key (a failure is retried later). */
  const registerKey = (): Promise<boolean> => {
    if (registered !== null && (registeredAt === 0 || Date.now() - registeredAt < KEY_RETRY_MS)) {
      return registered;
    }
    registeredAt = 0;
    registered = (async () => {
      const key = await keyOf();
      if (key === null) return false;
      const reply = await consoleCall(
        {
          method: "PUT",
          path: "/api/v1/work/computers/box-key",
          body: { publicKey: key.publicKey },
        },
        "register this computer's key",
      );
      if (isAnswer(reply.status)) return true;
      options.warn?.(`my-computer key not registered: ${consoleDetail(reply)}`);
      return false;
    })()
      .catch(() => false)
      .then((ok) => {
        // A failure is tried again after a while, a success holds for the process.
        if (!ok) registeredAt = Date.now();
        return ok;
      });
    return registered;
  };

  // ── Helper updates: through the tunnel, when its channel is idle ──────
  const updateTriedAt = new Map<string, number>();
  const updateHelperIfOld = (computerId: string, channel: ComputerChannel): boolean => {
    const meta = lastMeta?.value;
    const latest = meta?.latestHelperVersion ?? null;
    const computer = lastStatus?.computers.find((entry) => entry.id === computerId);
    if (latest === null || computer === undefined || !computer.online) return false;
    if (computer.helperVersion === null || computer.helperVersion === latest) return false;
    const tried = updateTriedAt.get(computerId) ?? 0;
    if (Date.now() - tried < HELPER_UPDATE_EVERY_MS) return false;
    updateTriedAt.set(computerId, Date.now());
    const download =
      options.helperDownloadUrl?.() ?? `${options.baseUrl().replace(/\/+$/, "")}/cli/connect`;
    const windows = computer.os === "windows";
    // A helper of M7 checks our signature on SHA256SUMS itself; an older one is
    // brought over by the update script, which checks the checksum like install.
    const cmd = meta?.computers.get(computerId)?.signedFrames
      ? windows
        ? `& "$env:LOCALAPPDATA\\UnoConnect\\uno-connect.exe" update`
        : `"$HOME/.uno-connect/uno-connect" update`
      : windows
        ? `irm "${download}/update.ps1" | iex`
        : `curl -fsSL "${download}/update.sh" | sh`;
    void record(
      computerId,
      "run",
      `Updated the Uno helper on ${computer.name || "this computer"} to ${latest}`,
      undefined,
    );
    try {
      const call = channel.start(
        { op: "exec", cmd, timeoutMs: HELPER_UPDATE_TIMEOUT_MS },
        {
          // The helper restarts itself at the end: the exit may never come.
          onFrame: (frame) => {
            if (frame.type === "exit" || frame.type === "error") call.end();
          },
          onClosed: () => undefined,
        },
      );
      setTimeout(() => call.end(), HELPER_UPDATE_TIMEOUT_MS + 5_000).unref?.();
      return true;
    } catch {
      return false;
    }
  };

  const checkVisible = (): Promise<boolean> => {
    checking ??= status()
      .then((current) => {
        const value = current.enabled && current.computers.length > 0;
        visible = { value, at: Date.now() };
        return value;
      })
      .catch(() => visible?.value ?? false)
      .finally(() => {
        checking = null;
      });
    return checking;
  };

  // Commands that start together share one socket: the first one opens it
  // (after the M7 lookup), the rest wait on that same opening.
  const opening = new Map<string, Promise<ComputerChannel>>();

  const channelFor = async (computerId: string): Promise<ComputerChannel> => {
    const token = await options.token();
    if (token.length === 0) throw new MyComputerFailure("off", OFF_MESSAGE);
    let channel = channels.get(computerId);
    if (channel === undefined || channel.isClosed()) {
      let pending = opening.get(computerId);
      if (pending === undefined) {
        pending = openChannel(computerId, token).finally(() => opening.delete(computerId));
        opening.set(computerId, pending);
      }
      channel = await pending;
    }
    await channel.ready;
    return channel;
  };

  const openChannel = async (computerId: string, token: string): Promise<ComputerChannel> => {
    const meta = await metaOf(computerId);
    if (meta?.trustsThisBox === false) {
      const name = lastStatus?.computers.find((entry) => entry.id === computerId)?.name;
      throw new MyComputerFailure(
        "remote",
        `“${name || "This computer"}” ${SIGNATURE_REFUSALS.untrusted_key}`,
      );
    }
    // A helper of M7 gets signed frames; one from before gets `v: 1` until
    // it updates (the transition, CONTRACT §7.4).
    let key: BoxKey | null = null;
    if (meta?.signedFrames === true) {
      void registerKey();
      key = await keyOf();
    }
    const signer = key;
    const opened: ComputerChannel = openComputerChannel({
      url: `${options.baseUrl().replace(/^http/, "ws")}/api/v1/work/computers/${encodeURIComponent(computerId)}/channel`,
      token,
      ...(timings.connectTimeoutMs ? { connectTimeoutMs: timings.connectTimeoutMs } : {}),
      ...(timings.idleCloseMs ? { idleCloseMs: timings.idleCloseMs } : {}),
      ...(signer
        ? {
            sign: (id: string, frame: HelperRequest) =>
              signFrame({ key: signer, id, computerId, frame }),
          }
        : {}),
      onIdle: () => updateHelperIfOld(computerId, opened),
      onClosed: () => {
        if (channels.get(computerId) === opened) channels.delete(computerId);
      },
    });
    channels.set(computerId, opened);
    return opened;
  };

  const journalFailed = (cause: unknown) => {
    options.warn?.(
      `my-computer journal: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return null;
  };

  /** The journal line before the action; its id, for how it ended. */
  const record = (
    computerId: string,
    kind: "run" | "read" | "write" | "list",
    summary: string,
    threadId: string | undefined,
    trust?: CallTrust,
  ): Promise<string | null> =>
    journal
      .record(computerId, {
        kind,
        summary,
        threadId,
        ...(trust ? { tier: trust.tier, threadTitle: trust.threadTitle } : {}),
      })
      .catch(journalFailed);

  // Agents' calls running now: "Stop all agents" aborts them.
  const inflight = new Set<AbortController>();

  /**
   * One agent call: abortable by `abortAll` as well as by its own signal; its
   * journal line (`line`, set by the body once written) gets how it ended.
   */
  const tracked = async <T>(
    signal: AbortSignal | undefined,
    body: (
      signal: AbortSignal,
      line: (computerId: string, id: string | null) => void,
    ) => Promise<T>,
    finishOf: (value: T, durationMs: number) => ActivityFinish,
  ): Promise<T> => {
    const controller = new AbortController();
    const forward = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", forward, { once: true });
    inflight.add(controller);
    let written: { readonly computerId: string; readonly id: string } | null = null;
    const startedAt = Date.now();
    const finish = (value: ActivityFinish) => {
      if (written !== null) {
        void journal.finish(written.computerId, written.id, value).catch(journalFailed);
      }
    };
    try {
      const value = await body(controller.signal, (computerId, id) => {
        written = id === null ? null : { computerId, id };
      });
      finish(finishOf(value, Date.now() - startedAt));
      return value;
    } catch (cause) {
      finish({
        outcome: controller.signal.aborted ? "stopped" : "failed",
        durationMs: Date.now() - startedAt,
      });
      throw cause;
    } finally {
      inflight.delete(controller);
      signal?.removeEventListener("abort", forward);
    }
  };

  /** One request, one `result` frame. */
  const ask = (
    channel: ComputerChannel,
    frame: HelperRequest,
    signal: AbortSignal | undefined,
  ): Promise<HelperFrame> =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(cancelled());
        return;
      }
      let call: ChannelCall | null = null;
      const settle = (finish: () => void) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        call?.end();
        finish();
      };
      const onAbort = () => settle(() => reject(cancelled()));
      const timer = setTimeout(
        () =>
          settle(() =>
            reject(
              new MyComputerFailure(
                "timeout",
                "The computer didn't answer in time. Maybe it went to sleep: ask the person to open it, then try again.",
              ),
            ),
          ),
        timings.fileOpTimeoutMs ?? FILE_OP_TIMEOUT_MS,
      );
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        call = channel.start(frame, {
          onFrame: (answer) => {
            if (answer.type === "result") settle(() => resolve(answer));
            else if (answer.type === "error") settle(() => reject(remoteFailure(answer)));
          },
          onClosed: (failure) => settle(() => reject(failure)),
        });
      } catch (cause) {
        settle(() => reject(cause));
      }
    });

  return {
    stateDir: options.stateDir,
    status,
    meta: () => lastMeta?.value ?? null,
    cachedStatus: async (maxAgeMs) =>
      lastStatus !== null && lastMeta !== null && Date.now() - lastMeta.at <= maxAgeMs
        ? lastStatus
        : status(),
    setMode: async (computerId, mode) => {
      const reply = await consoleCall(
        {
          method: "PATCH",
          path: `/api/v1/work/computers/${encodeURIComponent(computerId)}`,
          body: { mode },
        },
        "change what the computer is for",
      );
      if (!isAnswer(reply.status)) {
        throw new MyComputerFailure(
          reply.status === 404 ? "remote" : "console",
          reply.status === 404
            ? "This computer isn't connected any more."
            : `Couldn't change what the computer is for: ${consoleDetail(reply)}.`,
        );
      }
      lastMeta = null;
    },
    pair: async () => {
      // The new computer trusts the keys the console knows at pairing (M7):
      // this computer's must be among them.
      await registerKey();
      const reply = await consoleCall(
        { method: "POST", path: "/api/v1/work/computers/pair" },
        "start connecting a computer",
      );
      if (isAnswer(reply.status)) return parsePairing(reply.body);
      if (meansOff(reply.status)) {
        throw new MyComputerFailure(
          "off",
          "Connecting a computer isn't available on this account yet.",
        );
      }
      throw new MyComputerFailure(
        "console",
        `Couldn't start connecting a computer: ${consoleDetail(reply)}.`,
      );
    },
    pairStatus: async (code) => {
      const reply = await consoleCall(
        {
          method: "GET",
          path: `/api/v1/work/computers/pair/${encodeURIComponent(code)}`,
        },
        "check the pairing",
      );
      if (!isAnswer(reply.status)) {
        throw new MyComputerFailure(
          "console",
          `Couldn't check the pairing: ${consoleDetail(reply)}.`,
        );
      }
      const answer = parsePairStatus(reply.body);
      if (answer.state === "claimed") forgetVisible();
      return answer;
    },
    disconnect: async (computerId) => {
      const reply = await consoleCall(
        { method: "DELETE", path: `/api/v1/work/computers/${encodeURIComponent(computerId)}` },
        "disconnect the computer",
      );
      // Already gone is what the person asked for.
      if (!isAnswer(reply.status) && reply.status !== 404) {
        throw new MyComputerFailure(
          "console",
          `Couldn't disconnect the computer: ${consoleDetail(reply)}.`,
        );
      }
      channels.get(computerId)?.close("revoked");
      forgetVisible();
    },
    activity: (computerId, limit) => journal.read(computerId, limit),
    note: async (computerId, kind, summary, threadId) => {
      await record(computerId, kind, summary, threadId);
    },
    toolsVisible: async () => {
      if ((await options.token()).length === 0) return false;
      if (
        visible !== null &&
        Date.now() - visible.at < (timings.toolsVisibleTtlMs ?? TOOLS_VISIBLE_TTL_MS)
      ) {
        return visible.value;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<boolean>((resolve) => {
        timer = setTimeout(
          () => resolve(visible?.value ?? false),
          timings.toolsVisibleWaitMs ?? TOOLS_VISIBLE_WAIT_MS,
        );
      });
      try {
        return await Promise.race([checkVisible(), late]);
      } finally {
        clearTimeout(timer);
      }
    },
    exec: (input, outerSignal) =>
      tracked(
        outerSignal,
        async (signal, line) => {
          if (signal.aborted) throw cancelled();
          const timeoutMs = Math.min(
            Math.max(1, input.timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS),
            EXEC_MAX_TIMEOUT_MS,
          );
          const channel = await channelFor(input.computerId);
          if (input.quiet !== true) {
            line(
              input.computerId,
              await record(input.computerId, "run", input.cmd, input.threadId, input.trust),
            );
          }
          if (signal.aborted) throw cancelled();
          return new Promise<ExecResult>((resolve, reject) => {
            const output = new OutputCollector(input.maxOutputBytes);
            const startedAt = Date.now();
            let settled = false;
            let call: ChannelCall | null = null;
            let deadline: ReturnType<typeof setTimeout> | null = null;
            let startWait: ReturnType<typeof setTimeout> | null = null;
            let hardKill: ReturnType<typeof setTimeout> | null = null;
            let started = false;

            const stopWatching = () => {
              if (deadline !== null) clearTimeout(deadline);
              if (startWait !== null) clearTimeout(startWait);
              if (hardKill !== null) clearTimeout(hardKill);
              signal?.removeEventListener("abort", onAbort);
              call?.end();
            };
            const answer = (exit: {
              readonly exitCode: number | null;
              readonly signal: string | null;
              readonly timedOut: boolean;
            }) => {
              stopWatching();
              if (settled) return;
              settled = true;
              resolve({ ...exit, ...output.result(), durationMs: Date.now() - startedAt });
            };
            const fail = (cause: unknown) => {
              stopWatching();
              if (settled) return;
              settled = true;
              reject(cause);
            };
            /** Ask it to stop, then stop it. `then`: after the hard kill. */
            const stopProcess = (then: () => void) => {
              if (hardKill !== null) return;
              call?.send({ op: "kill" });
              hardKill = setTimeout(() => {
                call?.send({ op: "kill", signal: "SIGKILL" });
                then();
              }, killGraceMs);
            };
            const onAbort = () => {
              // The agent's turn is over: it hears at once, the process is stopped
              // in the background (the call stays open for the hard kill).
              settled = true;
              reject(cancelled());
              stopProcess(stopWatching);
            };

            signal?.addEventListener("abort", onAbort, { once: true });
            try {
              call = channel.start(
                {
                  op: "exec",
                  cmd: input.cmd,
                  ...(input.cwd ? { cwd: input.cwd } : {}),
                  timeoutMs,
                },
                {
                  onFrame: (frame) => {
                    started = true;
                    if (startWait !== null) clearTimeout(startWait);
                    switch (frame.type) {
                      case "out":
                        output.push(decodeData(frame["data"]));
                        break;
                      case "exit":
                        answer({
                          exitCode: typeof frame["code"] === "number" ? frame["code"] : null,
                          signal: nullableString(frame["signal"]),
                          timedOut: frame["timedOut"] === true,
                        });
                        break;
                      case "error":
                        fail(remoteFailure(frame));
                        break;
                      // `started`: noted above.
                    }
                  },
                  onClosed: fail,
                },
              );
            } catch (cause) {
              fail(cause);
              return;
            }
            startWait = setTimeout(() => {
              call?.send({ op: "kill" });
              fail(notStarted());
            }, timings.execStartTimeoutMs ?? EXEC_START_TIMEOUT_MS);
            deadline = setTimeout(
              () => {
                // "Ran out of time" would be untrue for what never started.
                if (started) {
                  stopProcess(() => answer({ exitCode: null, signal: null, timedOut: true }));
                }
              },
              timeoutMs + (timings.execBackstopMs ?? EXEC_BACKSTOP_MS),
            );
          });
        },
        (result) => ({
          outcome: result.timedOut ? "stopped" : "ran",
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        }),
      ),
    read: (input, outerSignal) =>
      tracked(
        outerSignal,
        async (signal, line) => {
          const channel = await channelFor(input.computerId);
          if (input.quiet !== true) {
            line(
              input.computerId,
              await record(input.computerId, "read", input.path, input.threadId, input.trust),
            );
          }
          const start = input.offset ?? 0;
          const pieces: Array<Buffer> = [];
          let total = 0;
          let eof = false;
          while (total < input.maxBytes && !eof) {
            const answer = await ask(
              channel,
              {
                op: "read",
                path: input.path,
                offset: start + total,
                length: Math.min(MAX_DATA_CHUNK_BYTES, input.maxBytes - total),
              },
              signal,
            );
            const data = decodeData(answer["data"]);
            pieces.push(data);
            total += data.length;
            // An answer without `eof` still ends the file with an empty read.
            eof = answer["eof"] === true || data.length === 0;
          }
          return { data: Buffer.concat(pieces), offset: start, eof };
        },
        ran,
      ),
    write: (input, outerSignal) =>
      tracked(
        outerSignal,
        async (signal, line) => {
          if (input.data.length > MAX_FILE_BYTES) {
            throw new MyComputerFailure(
              "too-large",
              `That is ${input.data.length} bytes; up to ${MAX_FILE_BYTES} bytes (50 MiB) go through at once. Split it or use cloud storage.`,
            );
          }
          const channel = await channelFor(input.computerId);
          line(
            input.computerId,
            await record(
              input.computerId,
              "write",
              `${input.path} (${input.data.length} bytes)`,
              input.threadId,
              input.trust,
            ),
          );
          let sent = 0;
          do {
            const chunk = input.data.subarray(sent, sent + MAX_DATA_CHUNK_BYTES);
            try {
              await ask(
                channel,
                {
                  op: "write",
                  path: input.path,
                  data: Buffer.from(chunk).toString("base64"),
                  // Each next chunk continues the file; the first one follows the call.
                  ...(sent > 0 || input.append === true ? { append: true } : {}),
                  ...(sent === 0 && input.mkdirs === true ? { mkdirs: true } : {}),
                },
                signal,
              );
            } catch (cause) {
              if (sent > 0 && cause instanceof Error) {
                throw new MyComputerFailure(
                  cause instanceof MyComputerFailure ? cause.kind : "remote",
                  `${cause.message} Only ${sent} of ${input.data.length} bytes were written: the file on the computer is incomplete.`,
                );
              }
              throw cause;
            }
            sent += chunk.length;
          } while (sent < input.data.length);
          return { bytes: sent };
        },
        ran,
      ),
    list: (input, outerSignal) =>
      tracked(
        outerSignal,
        async (signal, line) => {
          const channel = await channelFor(input.computerId);
          if (input.quiet !== true) {
            line(
              input.computerId,
              await record(input.computerId, "list", input.path, input.threadId, input.trust),
            );
          }
          return ask(channel, { op: "list", path: input.path }, signal);
        },
        ran,
      ),
    stat: async (input, signal) =>
      ask(await channelFor(input.computerId), { op: "stat", path: input.path }, signal),
    info: async (computerId, signal) => {
      const answer = await ask(await channelFor(computerId), { op: "info" }, signal);
      // The agent reads this: what the computer said, not the frame around it.
      return Object.fromEntries(
        Object.entries(answer).filter(([field]) => !FRAME_FIELDS.has(field)),
      );
    },
    refused: async (input) => {
      await journal
        .record(input.computerId, {
          kind: input.kind,
          summary: input.summary,
          threadId: input.threadId,
          threadTitle: input.threadTitle,
          tier: input.tier,
          refused: { reason: input.reason },
        })
        .catch(journalFailed);
    },
    running: () => inflight.size,
    abortAll: () => {
      const stopped = inflight.size;
      for (const controller of inflight) controller.abort();
      return stopped;
    },
    closeAll: () => {
      for (const controller of inflight) controller.abort();
      for (const channel of channels.values()) channel.close();
    },
  };
}
