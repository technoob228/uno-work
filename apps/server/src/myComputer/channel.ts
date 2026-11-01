/**
 * One WebSocket to the Uno console for one of the person's computers: the
 * console relays frames to the helper on that computer and reads none of them.
 * Many calls share the socket, told apart by `id`.
 *
 * Opened on the first call and closed after a quiet minute, so an idle daemon
 * holds nothing open. Its death ends every waiting call with a clear error.
 *
 * The runtime's own `WebSocket` is used: the daemon runs on Node 22+ (undici)
 * and in dev it may run on Bun; both take `{ headers }` as the second argument,
 * so no `ws` dependency is needed. That socket can't send a ping: the console
 * pings (25 s) and the runtime answers by itself.
 *
 * @module myComputer/channel
 */

/** Frames of this protocol version carry `v: 1`. */
export const FRAME_VERSION = 1;
export const MAX_FRAME_BYTES = 512 * 1024;
/**
 * Raw bytes of one data chunk: base64 turns them into exactly 256 KiB, so a
 * chunk fits the contract's limit whether the helper counts encoded or raw.
 */
export const MAX_DATA_CHUNK_BYTES = 192 * 1024;

export const CHANNEL_CONNECT_TIMEOUT_MS = 15_000;
export const CHANNEL_IDLE_CLOSE_MS = 60_000;

/** What ended a call without an answer from the helper. */
export type ChannelFailureKind = "offline" | "closed" | "revoked";

export class ChannelFailure extends Error {
  readonly kind: ChannelFailureKind;
  constructor(kind: ChannelFailureKind, message: string) {
    super(message);
    this.name = "ChannelFailure";
    this.kind = kind;
  }
}

/** A frame to the helper, without the `id` and `v` the channel adds. */
export type HelperRequest = {
  readonly op: string;
  readonly [field: string]: unknown;
};

/** A frame from the helper that names a call. */
export type HelperFrame = {
  readonly id: string;
  readonly type: string;
  readonly [field: string]: unknown;
};

export interface CallHandler {
  readonly onFrame: (frame: HelperFrame) => void;
  readonly onClosed: (failure: ChannelFailure) => void;
}

export interface ChannelCall {
  readonly id: string;
  /** Another frame of this call (`kill`); does nothing once the call ended. */
  readonly send: (frame: HelperRequest) => void;
  /** Forget the call: later frames with its id are dropped. */
  readonly end: () => void;
}

export interface ComputerChannel {
  /** Settles when the socket is open; rejects with a {@link ChannelFailure}. */
  readonly ready: Promise<void>;
  readonly start: (frame: HelperRequest, handler: CallHandler) => ChannelCall;
  readonly isClosed: () => boolean;
  /** `revoked`: the person disconnected the computer; the default: this daemon is stopping. */
  readonly close: (why?: "stopping" | "revoked") => void;
}

export interface OpenChannelInput {
  /** `wss://…/api/v1/work/computers/<id>/channel` */
  readonly url: string;
  readonly token: string;
  readonly connectTimeoutMs?: number;
  readonly idleCloseMs?: number;
  readonly onClosed?: () => void;
}

const OFFLINE_MESSAGE =
  "This computer can't be reached: it is asleep or offline. Ask the person to open it, then try again.";

const REVOKED_MESSAGE =
  "The person disconnected this computer, so it can't be used any more. Don't try another way; they can connect it again in Uno Work.";

function closedMessage(code: number, reason: string): string {
  const detail = reason.trim().slice(0, 200);
  return `The connection to this computer dropped (${code}${detail ? `: ${detail}` : ""}), and whatever it was running there was stopped. Maybe it went to sleep: ask the person to open it, then try again.`;
}

export function openComputerChannel(input: OpenChannelInput): ComputerChannel {
  const calls = new Map<string, CallHandler>();
  const idleCloseMs = input.idleCloseMs ?? CHANNEL_IDLE_CLOSE_MS;
  let nextId = 1;
  let closed = false;
  let opened = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const socket = new WebSocket(input.url, {
    headers: { Authorization: `Bearer ${input.token}` },
  });

  const clearIdle = () => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
  };

  /** Everything still waiting learns the same reason; the socket goes. */
  const shutDown = (failure: ChannelFailure) => {
    if (closed) return;
    closed = true;
    clearIdle();
    const waiting = [...calls.values()];
    calls.clear();
    for (const call of waiting) call.onClosed(failure);
    input.onClosed?.();
    try {
      socket.close(1000);
    } catch {
      // Already closing.
    }
  };

  const armIdle = () => {
    clearIdle();
    if (closed || calls.size > 0) return;
    idleTimer = setTimeout(
      () => shutDown(new ChannelFailure("closed", "Closed after being idle.")),
      idleCloseMs,
    );
    idleTimer.unref?.();
  };

  const ready = new Promise<void>((resolve, reject) => {
    const connectTimer = setTimeout(() => {
      const failure = new ChannelFailure("offline", OFFLINE_MESSAGE);
      reject(failure);
      shutDown(failure);
    }, input.connectTimeoutMs ?? CHANNEL_CONNECT_TIMEOUT_MS);
    connectTimer.unref?.();

    socket.addEventListener("open", () => {
      clearTimeout(connectTimer);
      opened = true;
      resolve();
      armIdle();
    });
    const ended = (code: number, reason: string) => {
      clearTimeout(connectTimer);
      const failure = opened
        ? new ChannelFailure("closed", closedMessage(code, reason))
        : new ChannelFailure("offline", OFFLINE_MESSAGE);
      if (!opened) reject(failure);
      shutDown(failure);
    };
    socket.addEventListener("close", (event) => ended(event.code, event.reason));
    // Node 22 (undici 6) answers a refused upgrade with `error` and no `close`:
    // waiting for `close` there holds the agent for the whole connect timeout.
    socket.addEventListener("error", () => ended(1006, ""));
  });
  // Callers await `ready`; a socket nobody used yet must not raise an
  // unhandled rejection.
  ready.catch(() => undefined);

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string" || event.data.length > MAX_FRAME_BYTES) return;
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(event.data);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
      frame = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const id = frame["id"];
    const type = frame["type"];
    if (typeof type !== "string") return;
    if (typeof id === "string" || typeof id === "number") {
      calls.get(String(id))?.onFrame({ ...frame, id: String(id), type });
      return;
    }
    if (type === "revoked") {
      shutDown(new ChannelFailure("revoked", REVOKED_MESSAGE));
    } else if (type === "error") {
      // The console speaks for the whole channel (the helper went away).
      const message = typeof frame["message"] === "string" ? frame["message"] : "";
      shutDown(new ChannelFailure("offline", message.trim() || OFFLINE_MESSAGE));
    }
    // `hello` and anything newer: nothing to do.
  });

  const transmit = (id: string, frame: HelperRequest) => {
    const text = JSON.stringify({ ...frame, id, v: FRAME_VERSION });
    if (Buffer.byteLength(text) > MAX_FRAME_BYTES) {
      throw new RangeError(`A frame of ${text.length} bytes is over the channel's limit.`);
    }
    socket.send(text);
  };

  return {
    ready,
    isClosed: () => closed,
    start: (frame, handler) => {
      if (closed) throw new ChannelFailure("closed", closedMessage(1006, ""));
      const id = String(nextId++);
      clearIdle();
      calls.set(id, handler);
      const isLive = () => !closed && calls.get(id) === handler;
      const end = () => {
        if (calls.get(id) !== handler) return;
        calls.delete(id);
        armIdle();
      };
      try {
        transmit(id, frame);
      } catch (cause) {
        end();
        throw cause;
      }
      return {
        id,
        send: (next) => {
          if (isLive()) transmit(id, next);
        },
        end,
      };
    },
    close: (why = "stopping") =>
      shutDown(
        why === "revoked"
          ? new ChannelFailure("revoked", REVOKED_MESSAGE)
          : new ChannelFailure("closed", closedMessage(1001, "Uno Work is restarting")),
      ),
  };
}
