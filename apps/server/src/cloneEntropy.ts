/**
 * Fresh randomness for a Work machine restored from an image's memory snapshot.
 *
 * Every clone of a Work image wakes up from the same memory. The guest kernel
 * notices (VM generation id — dmesg "crng reseeded due to virtual machine
 * fork") and reseeds its own generator, but a process that was already running
 * keeps the snapshot's copy of OpenSSL's generator: `crypto.randomBytes` and
 * `crypto.randomUUID` in the warm daemon return the SAME bytes in every clone
 * until OpenSSL reseeds by itself. Measured 08.10 on image 227: two clones
 * rotated to the same sign-in key and the same environment id.
 *
 * So the clone's new identity (cloneIdentity.ts) takes its bytes from the
 * kernel, XOR-ed with the process generator — neither source alone decides.
 *
 * @module cloneEntropy
 */
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";

/** `size` random bytes from the kernel (`/dev/urandom`) mixed with the process generator. */
export function kernelRandomBytes(
  size: number,
  processRandom: (size: number) => Uint8Array = (n) => randomBytes(n),
  devicePath = "/dev/urandom",
): Uint8Array {
  const out = Buffer.from(processRandom(size));
  let fd: number | undefined;
  try {
    fd = openSync(devicePath, "r");
    const kernel = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, kernel, offset, size - offset, null);
      if (read <= 0) throw new Error(`short read from ${devicePath}`);
      offset += read;
    }
    for (let index = 0; index < size; index += 1) {
      out[index] = out[index]! ^ kernel[index]!;
    }
  } catch {
    // No /dev/urandom (Windows): the process generator alone. The rotation
    // that needs this only runs on the Linux Work machine.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return new Uint8Array(out);
}

/** An RFC 4122 version 4 UUID from 16 random bytes. */
export function uuidV4FromBytes(bytes: Uint8Array): string {
  const b = Buffer.from(bytes.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
