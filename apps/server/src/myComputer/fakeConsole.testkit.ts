/**
 * A fake Uno console for tests: the five `/api/v1/work/computers…` routes and a
 * real WebSocket server on a local port, so the daemon's own socket connects
 * and its `Authorization` header is seen on the wire. `ws` isn't a dependency
 * of this package, so the server side of RFC 6455 is written out here.
 *
 * `helper` plays the program on the person's computer.
 *
 * @module myComputer/fakeConsole.testkit
 */
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OPCODE_TEXT = 1;
const OPCODE_CLOSE = 8;
const OPCODE_PING = 9;
const OPCODE_PONG = 10;

export type Frame = Record<string, unknown>;

export interface FakeChannel {
  readonly path: string;
  readonly authorization: string | undefined;
  /** Every frame the daemon sent on this channel. */
  readonly frames: Array<Frame>;
  readonly send: (frame: Frame) => void;
  readonly sendText: (text: string) => void;
  /** A proper WebSocket close. */
  readonly close: (code: number, reason?: string) => void;
  /** The connection just dies. */
  readonly drop: () => void;
  readonly closed: () => boolean;
}

export interface FakeConsole {
  readonly baseUrl: string;
  readonly token: string;
  readonly channels: Array<FakeChannel>;
  readonly requests: Array<{
    readonly method: string;
    readonly path: string;
    readonly authorization: string | undefined;
  }>;
  /** Every frame from the daemon, on any channel. */
  readonly frames: () => ReadonlyArray<Frame>;
  listing: { status: number; body: unknown };
  /** Answers frames from the daemon; replaced by each test. */
  helper: (frame: Frame, reply: (answer: Frame) => void, channel: FakeChannel) => void;
  /** Refuse the WebSocket upgrade with this status. */
  refuseUpgrade: number | null;
  readonly close: () => Promise<void>;
}

const encodeFrame = (opcode: number, payload: Buffer): Buffer => {
  const first = 0x80 | opcode;
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([first, payload.length]), payload]);
  }
  if (payload.length < 65_536) {
    const header = Buffer.alloc(4);
    header[0] = first;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = first;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
};

/** Splits client frames out of a stream; they arrive masked and unfragmented. */
function makeFrameReader(onFrame: (opcode: number, payload: Buffer) => void) {
  let buffer: Buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const opcode = buffer[0]! & 0x0f;
      const short = buffer[1]! & 0x7f;
      const lengthBytes = short === 126 ? 2 : short === 127 ? 8 : 0;
      const maskAt = 2 + lengthBytes;
      if (buffer.length < maskAt + 4) return;
      const length =
        short === 126
          ? buffer.readUInt16BE(2)
          : short === 127
            ? Number(buffer.readBigUInt64BE(2))
            : short;
      const dataAt = maskAt + 4;
      if (buffer.length < dataAt + length) return;
      const mask = buffer.subarray(maskAt, dataAt);
      const payload = Buffer.from(buffer.subarray(dataAt, dataAt + length));
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = payload[index]! ^ mask[index % 4]!;
      }
      buffer = buffer.subarray(dataAt + length);
      onFrame(opcode, payload);
    }
  };
}

export async function startFakeConsole(): Promise<FakeConsole> {
  const sockets = new Set<Duplex>();
  const json = (response: http.ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };

  const server = http.createServer((request, response) => {
    const path = (request.url ?? "").split("?")[0]!;
    const method = request.method ?? "";
    fake.requests.push({ method, path, authorization: request.headers.authorization });
    if (request.headers.authorization !== `Bearer ${fake.token}`) {
      json(response, 401, { code: "unauthorized" });
    } else if (method === "GET" && path === "/api/v1/work/computers") {
      json(response, fake.listing.status, fake.listing.body);
    } else if (method === "POST" && path === "/api/v1/work/computers/pair") {
      json(response, 200, {
        code: "7KQ2-M9XD",
        url: "https://app.uno4.work/c/7KQ2M9XD",
        commands: { mac: "curl mac", linux: "curl linux", windows: "irm windows" },
        expiresAt: "2026-10-31T12:15:00Z",
      });
    } else if (method === "GET" && path.startsWith("/api/v1/work/computers/pair/")) {
      json(response, 200, { state: "claimed", step: "done", message: null, computerId: 7 });
    } else if (method === "DELETE" && path.startsWith("/api/v1/work/computers/")) {
      json(response, 200, { ok: true });
    } else {
      json(response, 404, { code: "not_found" });
    }
  });

  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    const authorization = request.headers.authorization;
    const refused = fake.refuseUpgrade ?? (authorization === `Bearer ${fake.token}` ? null : 401);
    if (refused !== null) {
      socket.end(`HTTP/1.1 ${refused} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const accept = createHash("sha1")
      .update(`${String(request.headers["sec-websocket-key"])}${WS_GUID}`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    let isClosed = false;
    socket.on("close", () => {
      isClosed = true;
    });
    const write = (opcode: number, payload: Buffer) => {
      if (!isClosed) socket.write(encodeFrame(opcode, payload));
    };
    const closeFrame = (code: number, reason: string) => {
      const text = Buffer.from(reason);
      const body = Buffer.alloc(2 + text.length);
      body.writeUInt16BE(code, 0);
      text.copy(body, 2);
      return body;
    };
    const channel: FakeChannel = {
      path: (request.url ?? "").split("?")[0]!,
      authorization,
      frames: [],
      send: (frame) => write(OPCODE_TEXT, Buffer.from(JSON.stringify(frame))),
      sendText: (text) => write(OPCODE_TEXT, Buffer.from(text)),
      close: (code, reason = "") => {
        write(OPCODE_CLOSE, closeFrame(code, reason));
        socket.end();
      },
      drop: () => socket.destroy(),
      closed: () => isClosed,
    };
    fake.channels.push(channel);

    socket.on(
      "data",
      makeFrameReader((opcode, payload) => {
        if (opcode === OPCODE_TEXT) {
          const frame = JSON.parse(payload.toString("utf8")) as Frame;
          channel.frames.push(frame);
          fake.helper(frame, (answer) => channel.send({ id: frame.id, ...answer }), channel);
        } else if (opcode === OPCODE_PING) {
          write(OPCODE_PONG, payload);
        } else if (opcode === OPCODE_CLOSE) {
          write(OPCODE_CLOSE, payload);
          socket.end();
        }
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const fake: FakeConsole = {
    baseUrl: `http://127.0.0.1:${port}`,
    token: "uno_box_test_machine_token",
    channels: [],
    requests: [],
    frames: () => fake.channels.flatMap((channel) => channel.frames),
    listing: { status: 200, body: { enabled: true, computers: [] } },
    helper: () => undefined,
    refuseUpgrade: null,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return fake;
}

export const computerRow = (overrides: Frame = {}): Frame => ({
  id: "c1",
  name: "Work laptop",
  os: "darwin",
  arch: "arm64",
  online: true,
  connectedAt: "2026-10-31T10:00:00Z",
  lastSeenAt: "2026-10-31T10:05:00Z",
  helperVersion: "0.1.0",
  ...overrides,
});

export const base64 = (text: string | Uint8Array) =>
  (typeof text === "string" ? Buffer.from(text) : Buffer.from(text)).toString("base64");

export async function waitFor(condition: () => boolean, what = "the condition", ms = 3_000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
