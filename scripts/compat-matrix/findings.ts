/**
 * What counts as a finding in the compatibility matrix — plain functions over
 * what the browser and the proxy saw, so the rules are unit-tested without a
 * browser or a daemon.
 */
import type { MachineAnswer } from "./originProxy.ts";

// ---- text a person should never be shown -----------------------------------

/** A program talking, not Uno Work: a stack trace or a raw schema error. */
const RAW_ERROR_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly what: string }> = [
  { pattern: /\bat [^\n]{0,80}\(?(?:file:\/\/|node:)[^\n]*/, what: "a stack trace" },
  { pattern: /node_modules\//, what: "a path into node_modules" },
  { pattern: /\[object Object\]/, what: "[object Object]" },
  { pattern: /SchemaError|ParseError|Expected .{1,80}, got /, what: "a raw schema error" },
];

export function findRawError(text: string): string | null {
  for (const { pattern, what } of RAW_ERROR_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return `${what} ("${match[0].slice(0, 90)}…")`;
  }
  return null;
}

// ---- the turn after a message ----------------------------------------------

export interface TurnOutcome {
  readonly ok: boolean;
  readonly reason: string;
  /** Rough, and the same with any daemon: reported, not failed. */
  readonly notes: ReadonlyArray<string>;
}

/**
 * The stand has no model and no harness, so the turn cannot produce an answer
 * and the daemon cannot even start one. What the smoke can tell is whether the
 * interface coped: `notices` are the notices the chat shows (sign in again,
 * try again …), `chatAfterMessage` is everything in the chat below the message.
 *
 *   - a notice in plain words → the best offline outcome;
 *   - a raw error inside such a notice → ❌ (the interface showed a person a
 *     stack trace as if it were a sentence);
 *   - only the work log line the daemon wrote ("Provider turn start failed –
 *     …") → passes with a note: that text is the daemon's, the same with its
 *     own interface, and comes from the stand having nothing to run;
 *   - nothing yet → the turn has started, which is as far as offline goes.
 */
export function judgeTurnOutcome(input: {
  readonly notices: ReadonlyArray<string>;
  readonly chatAfterMessage: string;
}): TurnOutcome {
  const notices = input.notices
    .map((notice) => notice.replace(/\s*\n+\s*/g, " / ").trim())
    .filter((notice) => notice.length > 0);
  for (const notice of notices) {
    const raw = findRawError(notice);
    if (raw) return { ok: false, reason: `the notice in the chat shows ${raw}`, notes: [] };
  }
  const raw = findRawError(input.chatAfterMessage);
  const workLog = raw ? [`the chat's work log shows the daemon's raw error: ${raw}`] : [];
  const first = notices[0];
  if (first !== undefined) {
    return {
      ok: true,
      reason: `message accepted, chat in the list; the turn ended with the notice "${first.slice(0, 140)}"`,
      notes: workLog,
    };
  }
  return {
    ok: true,
    reason: raw
      ? "message accepted, chat in the list; the turn could not start (no model or harness on the stand)"
      : "message accepted, chat in the list, the turn started (no model on the stand)",
    notes: workLog,
  };
}

// ---- routes the daemon could not answer ------------------------------------

/**
 * Daemon answers that say nothing about compatibility on this stand.
 * Everything else with status >= 400 (or HTML where an API answer was asked
 * for) is a route the fresh web called and this daemon does not serve.
 */
const STAND_ANSWERS: ReadonlyArray<{
  readonly path: RegExp;
  readonly statuses: ReadonlyArray<number>;
  readonly why: string;
}> = [
  {
    path: /^\/office-engine\//,
    statuses: [404],
    why: "the office engine is put on a computer by install.sh; a bare daemon has none",
  },
];

export function unexplainedMachineProblems(
  problems: ReadonlyArray<MachineAnswer>,
): Array<MachineAnswer> {
  return problems.filter(
    (problem) =>
      !STAND_ANSWERS.some(
        (known) => known.path.test(problem.path) && known.statuses.includes(problem.status),
      ),
  );
}

export function describeMachineProblems(problems: ReadonlyArray<MachineAnswer>): string {
  const counted = new Map<string, number>();
  for (const problem of problems) {
    const key = `${problem.method} ${problem.path} → ${problem.status}${
      problem.status < 400 ? ` ${problem.contentType}` : ""
    }`;
    counted.set(key, (counted.get(key) ?? 0) + 1);
  }
  return [...counted].map(([key, count]) => (count > 1 ? `${key} ×${count}` : key)).join("; ");
}

/**
 * Routes the fresh web can call that an older daemon does not have at all
 * (found by reading both builds, so screens the smoke never opens count too).
 * A route is fine only when it belongs to a named feature (`HTTP_FEATURE_ROUTES`
 * in contracts) that this daemon does not claim: then the interface hides the
 * button and says "Update this computer". Anything else is a 404 waiting for
 * a person.
 */
export function judgeHttpRoutes(input: {
  /** In the web and in this checkout's daemon, not in the daemon under test. */
  readonly missing: ReadonlyArray<string>;
  readonly featureRoutes: ReadonlyArray<{ readonly prefix: string; readonly feature: string }>;
  /** Whether the daemon under test serves a feature (its `httpFeatures`, or its version). */
  readonly daemonSupports: (feature: string) => boolean;
}): { readonly ungated: Array<string>; readonly gated: Array<string> } {
  const ungated: Array<string> = [];
  const gated: Array<string> = [];
  for (const route of input.missing) {
    const owner = input.featureRoutes.find(
      (entry) => route.startsWith(entry.prefix) || entry.prefix.startsWith(`${route}/`),
    );
    if (owner && !input.daemonSupports(owner.feature)) gated.push(`${route} (${owner.feature})`);
    else ungated.push(route);
  }
  return { ungated, gated };
}

// ---- RPC over the WebSocket --------------------------------------------------

export interface RpcTraffic {
  /** Every RPC method the page sent. */
  readonly sent: Set<string>;
  /** Requests the daemon died on while the page was waiting for them: "method: text". */
  readonly defects: Array<string>;
  /**
   * Requests the daemon refused with an error of its own (not a crash) while
   * the page was waiting: a command it does not support, a thing that is not
   * set up on the stand.
   */
  readonly refusals: Array<{ readonly method: string; readonly text: string }>;
  /**
   * Defects on requests the page had already cancelled (it left the screen
   * (it left the screen that subscribed). Nobody is listening for that
   * answer; noted, not failed.
   */
  readonly defectsAfterCancel: Array<string>;
}

export function emptyRpcTraffic(): RpcTraffic {
  return { sent: new Set(), defects: [], refusals: [], defectsAfterCancel: [] };
}

/** Per-socket memory: which request is which method, and which the page cancelled. */
export interface RpcSocketState {
  readonly methods: Map<string, string>;
  readonly cancelled: Set<string>;
}

export function emptyRpcSocketState(): RpcSocketState {
  return { methods: new Map(), cancelled: new Set() };
}

interface WireFrame {
  readonly _tag?: unknown;
  readonly id?: unknown;
  readonly requestId?: unknown;
  readonly tag?: unknown;
  readonly exit?: { readonly _tag?: unknown; readonly cause?: unknown };
  readonly defect?: unknown;
}

/** One WebSocket frame of effect's RPC protocol (JSON), either direction. */
export function recordRpcFrame(
  traffic: RpcTraffic,
  socket: RpcSocketState,
  direction: "sent" | "received",
  payload: string | Buffer,
): void {
  if (typeof payload !== "string") return;
  let frames: Array<WireFrame>;
  try {
    const parsed = JSON.parse(payload) as WireFrame | Array<WireFrame>;
    frames = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return;
  }
  for (const frame of frames) {
    if (direction === "sent") {
      if (frame._tag === "Request" && typeof frame.tag === "string") {
        traffic.sent.add(frame.tag);
        if (typeof frame.id === "string") socket.methods.set(frame.id, frame.tag);
      } else if (frame._tag === "Interrupt" && typeof frame.requestId === "string") {
        socket.cancelled.add(frame.requestId);
      }
      continue;
    }
    if (frame._tag === "Defect") {
      traffic.defects.push(`(the whole connection): ${oneLine(JSON.stringify(frame.defect))}`);
      continue;
    }
    if (frame._tag !== "Exit" || frame.exit?._tag !== "Failure") continue;
    const requestId = typeof frame.requestId === "string" ? frame.requestId : null;
    const causes = Array.isArray(frame.exit.cause) ? frame.exit.cause : [];
    const method = (requestId === null ? undefined : socket.methods.get(requestId)) ?? "?";
    const cancelled = requestId !== null && socket.cancelled.has(requestId);
    for (const cause of causes as Array<{
      readonly _tag?: unknown;
      readonly defect?: unknown;
      readonly error?: unknown;
    }>) {
      if (cause._tag === "Fail") {
        if (!cancelled) traffic.refusals.push({ method, text: describeRpcError(cause.error) });
        continue;
      }
      if (cause._tag !== "Die") continue;
      const text = typeof cause.defect === "string" ? cause.defect : JSON.stringify(cause.defect);
      const line = `${method}: ${oneLine(text)}`;
      if (cancelled) traffic.defectsAfterCancel.push(line);
      else traffic.defects.push(line);
    }
  }
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").slice(0, 200);
}

function describeRpcError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const { _tag, message } = error as { readonly _tag?: unknown; readonly message?: unknown };
    if (typeof message === "string") {
      return oneLine(typeof _tag === "string" ? `${_tag}: ${message}` : message);
    }
  }
  return oneLine(typeof error === "string" ? error : JSON.stringify(error));
}

/** Methods whose refusal means the interface asked for something this daemon cannot do. */
const COMMAND_METHODS: ReadonlySet<string> = new Set(["orchestration.dispatchCommand"]);

/** Refused commands: the interface sent the daemon a command it did not take. */
export function refusedCommands(traffic: RpcTraffic): Array<string> {
  return traffic.refusals
    .filter((refusal) => COMMAND_METHODS.has(refusal.method))
    .map((refusal) => `${refusal.method}: ${refusal.text}`);
}

// ---- RPC methods a daemon has never heard of ----------------------------------

/**
 * RPC methods newer than some supported daemon, and the capability flag the
 * interface checks before calling each. A method a daemon lacks is fine only
 * when it is listed here and was not sent to that daemon: an unknown method
 * makes the daemon answer with a connection-level defect, which the client
 * takes as the end of the connection.
 *
 * Rule for a PR that adds an RPC method: add the capability to
 * `ExecutionEnvironmentCapabilities`, check it in the web before the call,
 * and list the pair here.
 */
export const CAPABILITY_GATED_RPC_METHODS: Readonly<Record<string, string>> = {};

export function judgeRpcMethods(input: {
  readonly methodCount: number;
  readonly missing: ReadonlyArray<string>;
  readonly sent: ReadonlySet<string>;
  readonly gated?: Readonly<Record<string, string>>;
}): { readonly ok: boolean; readonly reason: string } {
  const gated = input.gated ?? CAPABILITY_GATED_RPC_METHODS;
  const ungated = input.missing.filter((method) => gated[method] === undefined);
  const sentAnyway = input.missing.filter((method) => input.sent.has(method));
  if (sentAnyway.length > 0) {
    return {
      ok: false,
      reason: `the interface called ${sentAnyway.join(", ")}, which this computer does not have: the connection ends on it`,
    };
  }
  if (ungated.length > 0) {
    return {
      ok: false,
      reason: `${ungated.length} RPC method(s) of the interface are unknown to this computer and not behind a capability flag: ${ungated.slice(0, 6).join(", ")}`,
    };
  }
  const known = input.methodCount - input.missing.length;
  return {
    ok: true,
    reason:
      input.missing.length === 0
        ? `the daemon knows all ${input.methodCount} RPC methods of the interface; ${input.sent.size} were sent in this run`
        : `the daemon knows ${known} of ${input.methodCount} RPC methods; the other ${input.missing.length} are behind capability flags and were not sent`,
  };
}
