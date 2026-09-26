import { describe, expect, it } from "vitest";

import {
  findSocketOwnerUid,
  isLoopbackIp,
  parseProcNetAddress,
  readLoopbackPeerUid,
} from "./loopbackPeer.ts";
import { localPairingRefusal } from "./localPairing.ts";

const HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";

/** A /proc/net/tcp row (little-endian host). */
const row = (local: string, remote: string, state: string, uid: number, inode: number) =>
  `   0: ${local} ${remote} ${state} 00000000:00000000 00:00000000 00000000 ${uid} 0 ${inode} 1 0000000000000000 20 4 30 10 -1\n`;

// root's curl (127.0.0.1:54321 → :80), the daemon's accepted end (uid 1001),
// and an agent's connection (uid 1001) from port 54322.
const TABLE =
  HEADER +
  row("0100007F:D431", "0100007F:0050", "01", 0, 111) +
  row("0100007F:0050", "0100007F:D431", "01", 1001, 112) +
  row("0100007F:D432", "0100007F:0050", "01", 1001, 113) +
  row("0100007F:0050", "0100007F:D432", "01", 1001, 114) +
  // A finished connection: TIME_WAIT rows read as uid 0, inode 0.
  row("0100007F:D433", "0100007F:0050", "06", 0, 0);

describe("parseProcNetAddress", () => {
  it("reads IPv4 and IPv6 rows in host byte order", () => {
    expect(parseProcNetAddress("0100007F:0050", true)).toEqual({ address: "127.0.0.1", port: 80 });
    expect(parseProcNetAddress("0000000000000000FFFF00000100007F:D431", true)).toEqual({
      address: "127.0.0.1",
      port: 54321,
    });
    expect(parseProcNetAddress("00000000000000000000000001000000:0050", true)).toEqual({
      address: "::1",
      port: 80,
    });
    expect(parseProcNetAddress("garbage", true)).toBeNull();
  });
});

describe("findSocketOwnerUid", () => {
  it("finds the caller's own socket, not the daemon's end", () => {
    expect(
      findSocketOwnerUid(
        TABLE,
        { address: "127.0.0.1", port: 54321 },
        { address: "127.0.0.1", port: 80 },
        true,
      ),
    ).toBe(0);
    expect(
      findSocketOwnerUid(
        TABLE,
        { address: "::ffff:127.0.0.1", port: 54322 },
        { address: "::ffff:127.0.0.1", port: 80 },
        true,
      ),
    ).toBe(1001);
  });

  it("never takes a TIME_WAIT row for root", () => {
    expect(
      findSocketOwnerUid(
        TABLE,
        { address: "127.0.0.1", port: 54323 },
        { address: "127.0.0.1", port: 80 },
        true,
      ),
    ).toBeNull();
  });
});

describe("readLoopbackPeerUid", () => {
  const read = (path: string) => (path === "/proc/net/tcp" ? TABLE : null);

  it("answers for loopback connections only", () => {
    expect(isLoopbackIp("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackIp("10.0.0.5")).toBe(false);
    // Little-endian hosts only here: the table above is written that way.
    if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) return;
    expect(
      readLoopbackPeerUid(
        { remoteAddress: "127.0.0.1", remotePort: 54321, localAddress: "127.0.0.1", localPort: 80 },
        read,
      ),
    ).toBe(0);
    expect(
      readLoopbackPeerUid(
        { remoteAddress: "10.0.0.5", remotePort: 54321, localAddress: "10.0.0.2", localPort: 80 },
        read,
      ),
    ).toBeNull();
  });
});

describe("localPairingRefusal", () => {
  const connection = {
    remoteAddress: "127.0.0.1",
    remotePort: 54321,
    localAddress: "127.0.0.1",
    localPort: 80,
  };

  it("lets root on the machine in", () => {
    expect(
      localPairingRefusal({ connection, forwardedFor: undefined, peerUid: () => 0 }),
    ).toBeNull();
  });

  it("refuses the service user (and so every agent), relays and unknown callers", () => {
    expect(
      localPairingRefusal({ connection, forwardedFor: undefined, peerUid: () => 1001 }),
    ).toMatch(/root/);
    expect(
      localPairingRefusal({ connection, forwardedFor: "203.0.113.9", peerUid: () => 0 }),
    ).toMatch(/Relayed/);
    expect(
      localPairingRefusal({ connection, forwardedFor: undefined, peerUid: () => null }),
    ).not.toBeNull();
    expect(
      localPairingRefusal({ connection: null, forwardedFor: undefined, peerUid: () => 0 }),
    ).not.toBeNull();
  });
});
