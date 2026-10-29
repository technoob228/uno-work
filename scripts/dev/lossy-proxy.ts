/**
 * lossy-proxy: TCP proxy that simulates a bad long-haul link (e.g. Argentina -> Netherlands).
 *
 *   bun scripts/dev/lossy-proxy.ts --target 127.0.0.1:3773 [flags]
 *
 * Flags (ranges are "min..max", a single number means a fixed value):
 *   --listen <host:port>       default 127.0.0.1:0 (prints {"event":"listening","port":N} on stdout)
 *   --target <host:port>       required
 *   --delay-ms <n>             default 300; added EACH way
 *   --jitter-ms <n>            default 60; uniform +/- on every chunk (order is still preserved)
 *   --stall-every-ms <range>   default 45000..90000; random gap between stalls
 *   --stall-ms <range>         default 3000..12000; random stall length. During a stall NO bytes
 *                              flow in either direction on ANY connection; data is buffered, then released.
 *   --bandwidth-kbps <n>       default 0 (unlimited); paces each direction separately
 *   --seed <n>                 deterministic randomness (default: random)
 *
 * Every connection open/close and stall start/end is logged as one JSON line on stdout.
 * Byte order is preserved per direction: release = max(previous release, now + delay + jitter).
 * SIGINT/SIGTERM close everything and exit 0.
 */
import * as net from "node:net";
import { parseArgs } from "node:util";

const { values: flags } = parseArgs({
  options: {
    listen: { type: "string", default: "127.0.0.1:0" },
    target: { type: "string" },
    "delay-ms": { type: "string", default: "300" },
    "jitter-ms": { type: "string", default: "60" },
    "stall-every-ms": { type: "string", default: "45000..90000" },
    "stall-ms": { type: "string", default: "3000..12000" },
    "bandwidth-kbps": { type: "string", default: "0" },
    seed: { type: "string" },
  },
});

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, t: new Date().toISOString(), ...extra }));

const parseAddr = (s: string): { host: string; port: number } => {
  const i = s.lastIndexOf(":");
  return { host: s.slice(0, i) || "127.0.0.1", port: Number(s.slice(i + 1)) };
};
const parseRange = (s: string): [number, number] => {
  const [a, b] = s.split("..").map(Number);
  return [a!, b ?? a!];
};

if (!flags.target) {
  console.error("--target host:port is required");
  process.exit(2);
}
const listenAddr = parseAddr(flags.listen!);
const targetAddr = parseAddr(flags.target);
const delayMs = Number(flags["delay-ms"]);
const jitterMs = Number(flags["jitter-ms"]);
const stallEvery = parseRange(flags["stall-every-ms"]!);
const stallLen = parseRange(flags["stall-ms"]!);
const bandwidthKbps = Number(flags["bandwidth-kbps"]);

// mulberry32: tiny seeded PRNG
let rngState =
  (flags.seed !== undefined ? Number(flags.seed) : Math.floor(Math.random() * 2 ** 32)) >>> 0;
const rand = () => {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const randIn = ([lo, hi]: [number, number]) => lo + rand() * (hi - lo);

const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1 * 1024 * 1024;

let stalled = false;
const pipes = new Set<Pipe>();

/** One direction of one connection: delayed, ordered, optionally bandwidth-paced. */
class Pipe {
  private queue: Array<{ data: Buffer; at: number }> = [];
  private pending = 0;
  private lastRelease = 0;
  private lastTxEnd = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private srcEnded = false;
  private paused = false;
  private waitingDrain = false;
  private finished = false;
  bytes = 0;

  private readonly src: net.Socket;
  private readonly dst: net.Socket;
  private readonly onDone: () => void;

  constructor(src: net.Socket, dst: net.Socket, onDone: () => void) {
    this.src = src;
    this.dst = dst;
    this.onDone = onDone;
    pipes.add(this);
    src.on("data", (data: Buffer) => {
      const now = Date.now();
      let at = Math.max(this.lastRelease, now + delayMs + (rand() * 2 - 1) * jitterMs);
      if (bandwidthKbps > 0) {
        const txMs = (data.length * 8) / bandwidthKbps; // kbit/s == bit/ms
        at = Math.max(at, this.lastTxEnd + txMs);
        this.lastTxEnd = at;
      }
      this.lastRelease = at;
      this.queue.push({ data, at });
      this.pending += data.length;
      if (!this.paused && this.pending > HIGH_WATER) {
        this.paused = true;
        src.pause();
      }
      this.schedule();
    });
    src.on("end", () => this.markSourceEnded());
    dst.on("drain", () => {
      this.waitingDrain = false;
      this.schedule();
    });
  }

  markSourceEnded() {
    this.srcEnded = true;
    this.schedule();
  }

  private finish() {
    if (this.finished) return;
    this.finished = true;
    this.onDone();
  }

  /** (Re)arm the timer for the head of the queue; no-op while stalled (stall end calls this). */
  schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.dst.destroyed) return this.finish(); // receiver is gone, nothing left to deliver
    if (stalled || this.waitingDrain) return;
    const head = this.queue[0];
    if (!head) {
      if (this.srcEnded) {
        this.dst.end();
        this.finish();
      }
      return;
    }
    this.timer = setTimeout(() => this.flush(), Math.max(0, head.at - Date.now()));
  }

  private flush() {
    this.timer = undefined;
    const now = Date.now();
    while (this.queue.length > 0 && this.queue[0]!.at <= now) {
      // `stalled` is module state toggled by timers; checked per chunk.
      if (stalled) break;
      const { data } = this.queue.shift()!;
      this.pending -= data.length;
      this.bytes += data.length;
      if (!this.dst.write(data)) {
        this.waitingDrain = true;
        break;
      }
    }
    if (this.paused && this.pending < LOW_WATER) {
      this.paused = false;
      this.src.resume();
    }
    this.schedule();
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    pipes.delete(this);
  }
}

let nextConn = 1;
const sockets = new Set<net.Socket>();
const server = net.createServer({ allowHalfOpen: true }, (client) => {
  const id = nextConn++;
  const opened = Date.now();
  const upstream = net.connect({
    port: targetAddr.port,
    host: targetAddr.host,
    allowHalfOpen: true,
  });
  sockets.add(client).add(upstream);
  for (const s of [client, upstream]) s.setNoDelay(true);
  log("conn_open", { id, from: `${client.remoteAddress}:${client.remotePort}` });
  let doneCount = 0;
  const onDone = () => {
    if (++doneCount === 2) close("done");
  };
  const up = new Pipe(client, upstream, onDone);
  const down = new Pipe(upstream, client, onDone);
  let closed = false;
  const close = (reason: string) => {
    if (closed) return;
    closed = true;
    up.dispose();
    down.dispose();
    client.destroy();
    upstream.destroy();
    sockets.delete(client);
    sockets.delete(upstream);
    log("conn_close", {
      id,
      reason,
      ms: Date.now() - opened,
      bytesUp: up.bytes,
      bytesDown: down.bytes,
    });
  };
  client.on("error", (e) => close(`client_error:${e.message}`));
  upstream.on("error", (e) => close(`target_error:${e.message}`));
  // A closed socket ends its pipe; already-delayed data towards the other side is still delivered.
  client.on("close", () => {
    up.markSourceEnded();
    down.markSourceEnded();
  });
  upstream.on("close", () => {
    down.markSourceEnded();
    up.markSourceEnded();
  });
});

let stallTimer: ReturnType<typeof setTimeout> | undefined;
const scheduleStall = () => {
  stallTimer = setTimeout(
    () => {
      const ms = Math.round(randIn(stallLen));
      stalled = true;
      log("stall_start", { ms, connections: sockets.size / 2 });
      stallTimer = setTimeout(() => {
        stalled = false;
        log("stall_end", { ms });
        for (const p of pipes) p.schedule();
        scheduleStall();
      }, ms);
    },
    Math.round(randIn(stallEvery)),
  );
};

const shutdown = () => {
  if (stallTimer) clearTimeout(stallTimer);
  for (const p of pipes) p.dispose();
  for (const s of sockets) s.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(listenAddr.port, listenAddr.host, () => {
  const addr = server.address() as net.AddressInfo;
  console.log(JSON.stringify({ event: "listening", port: addr.port }));
  scheduleStall();
});
