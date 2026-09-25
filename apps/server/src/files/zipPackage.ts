/**
 * Just enough zip to read and rewrite an OOXML package (docx/xlsx/pptx) on
 * the daemon: stored and deflated entries, no zip64, no encryption, no
 * multi-disk. Office packages never need more; anything else is refused.
 *
 * Reading is bounded — entry count, per-entry and total inflated size — so a
 * zip bomb sent through a share link can't eat the machine's memory.
 *
 * @module files/zipPackage
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";

export const ZIP_MAX_ENTRIES = 5_000;
/** Total inflated bytes of one package. */
export const ZIP_MAX_TOTAL_BYTES = 400 * 1024 * 1024;

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipFormatError";
  }
}

export interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Entries in archive order. Throws `ZipFormatError` for anything unusual.
 * `include` picks entries by name; the others are never inflated.
 */
export function readZip(
  bytes: Uint8Array,
  options?: { readonly include?: (name: string) => boolean },
): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory: last 22 bytes + up to 64 KB of comment.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipFormatError("not a zip archive");
  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff)
    throw new ZipFormatError("zip64 isn't supported");
  if (count > ZIP_MAX_ENTRIES) throw new ZipFormatError("too many entries");
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) {
      throw new ZipFormatError("broken central directory");
    }
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLength));
    p += 46 + nameLength + extraLength + commentLength;
    if (flags & 0x1) throw new ZipFormatError("encrypted entries aren't supported");
    if (seen.has(name)) throw new ZipFormatError("duplicate entry");
    seen.add(name);
    if (name.endsWith("/")) continue; // folder entries carry nothing
    if (options?.include && !options.include(name)) continue;
    total += size;
    if (total > ZIP_MAX_TOTAL_BYTES) throw new ZipFormatError("package too large when unpacked");
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new ZipFormatError("broken local header");
    }
    const localName = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localName + localExtra;
    if (start + compressedSize > bytes.length) throw new ZipFormatError("truncated entry");
    const raw = bytes.subarray(start, start + compressedSize);
    let data: Uint8Array;
    if (method === 0) data = raw.slice();
    else if (method === 8) {
      try {
        data = new Uint8Array(inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) }));
      } catch {
        throw new ZipFormatError("entry doesn't inflate to its declared size");
      }
    } else throw new ZipFormatError(`compression method ${method} isn't supported`);
    if (data.length !== size) throw new ZipFormatError("entry size mismatch");
    entries.push({ name, data });
  }
  return entries;
}

/** A deflated zip of `entries`, in the given order. */
export function writeZip(entries: ReadonlyArray<ZipEntry>): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  // 1980-01-01 00:00 in DOS time — packages carry their own dates inside.
  const dosTime = 0;
  const dosDate = (0 << 9) | (1 << 5) | 1;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const compressed = new Uint8Array(deflateRawSync(entry.data));
    const crc = crc32(entry.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 8, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, compressed.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 8, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compressed.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, compressed);
    centrals.push(central);
    offset += local.length + compressed.length;
  }
  const cdSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
