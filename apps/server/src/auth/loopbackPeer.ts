/**
 * Who is on the other end of a loopback TCP connection — by Unix uid.
 *
 * On Linux every socket is listed in /proc/net/tcp{,6} with the uid of the
 * process that owns it. For a connection from 127.0.0.1 to the daemon, the
 * client's own socket is the row whose local address is the request's remote
 * address (and whose remote address is the daemon's listening address): its
 * `uid` column is the caller's uid. This lets a loopback-only endpoint trust
 * root (the console's `exec` on a box runs as root) and refuse the service
 * user — which is also the user every agent on the machine runs as.
 *
 * Pure parsing is exported for tests; `readLoopbackPeerUid` does the I/O.
 */
import { readFileSync } from "node:fs";
import os from "node:os";

export interface SocketEndpoint {
  readonly address: string;
  readonly port: number;
}

/** 127.0.0.0/8, ::1 and their IPv4-mapped IPv6 spelling. */
export function isLoopbackIp(address: string | undefined | null): boolean {
  if (!address) return false;
  const normalized = normalizeIp(address);
  return normalized === "::1" || normalized.startsWith("127.");
}

/** `::ffff:127.0.0.1` → `127.0.0.1`; IPv6 lowercased; anything else as is. */
export function normalizeIp(address: string): string {
  const lower = address.trim().toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(lower);
  return mapped?.[1] ?? lower;
}

/** A /proc/net/tcp word (host byte order) as 4 bytes, network order. */
function wordBytes(hex: string, littleEndian: boolean): number[] {
  const bytes = [0, 2, 4, 6].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  return littleEndian ? bytes.toReversed() : bytes;
}

/**
 * `0100007F:1F90` (tcp) or `0000000000000000FFFF00000100007F:0050` (tcp6) →
 * `{ address: "127.0.0.1", port: 8080 }`. IPv4-mapped IPv6 addresses come
 * back as plain IPv4 so both tables compare with Node's socket addresses.
 */
export function parseProcNetAddress(
  field: string,
  littleEndian = os.endianness() === "LE",
): SocketEndpoint | null {
  const [hexAddress, hexPort] = field.split(":");
  if (hexAddress === undefined || hexPort === undefined) return null;
  const port = Number.parseInt(hexPort, 16);
  if (!Number.isFinite(port)) return null;
  if (hexAddress.length === 8) {
    return { address: wordBytes(hexAddress, littleEndian).join("."), port };
  }
  if (hexAddress.length !== 32) return null;
  const bytes = [0, 8, 16, 24].flatMap((offset) =>
    wordBytes(hexAddress.slice(offset, offset + 8), littleEndian),
  );
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push((((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0)).toString(16));
  }
  const isMappedV4 = groups.slice(0, 5).every((group) => group === "0") && groups[5] === "ffff";
  if (isMappedV4) return { address: bytes.slice(12).join("."), port };
  return { address: compressIpv6(groups), port };
}

function compressIpv6(groups: ReadonlyArray<string>): string {
  // Longest run of zero groups becomes "::" (enough for ::1 and ::).
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < groups.length; start += 1) {
    let length = 0;
    while (start + length < groups.length && groups[start + length] === "0") length += 1;
    if (length > bestLength) {
      bestStart = start;
      bestLength = length;
    }
  }
  if (bestLength < 2) return groups.join(":");
  const head = groups.slice(0, bestStart).join(":");
  const tail = groups.slice(bestStart + bestLength).join(":");
  return `${head}::${tail}`;
}

const TCP_ESTABLISHED = "01";

/**
 * The uid owning the socket `local → remote` in a /proc/net/tcp{,6} table, or
 * null. Only live connections count: TIME_WAIT rows read as uid 0 and inode 0
 * and must never pass for root.
 */
export function findSocketOwnerUid(
  table: string,
  local: SocketEndpoint,
  remote: SocketEndpoint,
  littleEndian = os.endianness() === "LE",
): number | null {
  const wantLocal = { address: normalizeIp(local.address), port: local.port };
  const wantRemote = { address: normalizeIp(remote.address), port: remote.port };
  for (const line of table.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/u);
    // sl local rem st tx:rx tr:when retrnsmt uid timeout inode …
    if (fields.length < 10) continue;
    const [, localField, remoteField, state, , , , uidField, , inodeField] = fields;
    if (state !== TCP_ESTABLISHED || inodeField === "0") continue;
    const rowLocal = parseProcNetAddress(localField ?? "", littleEndian);
    const rowRemote = parseProcNetAddress(remoteField ?? "", littleEndian);
    if (rowLocal === null || rowRemote === null) continue;
    if (
      rowLocal.port === wantLocal.port &&
      rowRemote.port === wantRemote.port &&
      rowLocal.address === wantLocal.address &&
      rowRemote.address === wantRemote.address
    ) {
      const uid = Number.parseInt(uidField ?? "", 10);
      return Number.isSafeInteger(uid) ? uid : null;
    }
  }
  return null;
}

export interface ConnectionEndpoints {
  readonly remoteAddress?: string | undefined;
  readonly remotePort?: number | undefined;
  readonly localAddress?: string | undefined;
  readonly localPort?: number | undefined;
}

/**
 * The uid of the process that opened this loopback connection, or null when
 * it cannot be told (not loopback, not Linux, row not found).
 */
export function readLoopbackPeerUid(
  socket: ConnectionEndpoints,
  readTable: (path: string) => string | null = readProcTable,
): number | null {
  const { remoteAddress, remotePort, localAddress, localPort } = socket;
  if (
    !isLoopbackIp(remoteAddress) ||
    remotePort === undefined ||
    localAddress === undefined ||
    localPort === undefined
  ) {
    return null;
  }
  // The caller's socket: its local end is our remote end, and vice versa.
  const callerLocal = { address: remoteAddress ?? "", port: remotePort };
  const callerRemote = { address: localAddress, port: localPort };
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const table = readTable(path);
    if (table === null) continue;
    const uid = findSocketOwnerUid(table, callerLocal, callerRemote);
    if (uid !== null) return uid;
  }
  return null;
}

function readProcTable(path: string): string | null {
  if (process.platform !== "linux") return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
