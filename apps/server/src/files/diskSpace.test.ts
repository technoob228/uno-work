import os from "node:os";
import nodePath from "node:path";

import { describe, expect, it } from "vitest";

import {
  DISK_RESERVE_MIN_BYTES,
  DISK_FULL_MESSAGE,
  DISK_SMALL_COPY_BYTES,
  NotEnoughSpaceError,
  agentDiskSpaceMessage,
  diskSpaceAt,
  ensureDiskSpace,
  fitsOnDisk,
  isDiskFullError,
  reserveBytes,
  spaceCheckPath,
} from "./diskSpace.ts";

const GB = 1024 ** 3;

describe("a disk that fills up under a write", () => {
  it("is found anywhere in the chain of causes", () => {
    const enospc = Object.assign(new Error("write failed"), { code: "ENOSPC" });
    expect(isDiskFullError(enospc)).toBe(true);
    expect(isDiskFullError(new Error("wrapped", { cause: { cause: enospc } }))).toBe(true);
    expect(isDiskFullError({ code: "EDQUOT" })).toBe(true);
    expect(isDiskFullError(new Error("ENOSPC: no space left on device"))).toBe(true);
    expect(DISK_FULL_MESSAGE).toMatch(/^Not enough space/);
  });

  it("isn't any other write failure", () => {
    expect(isDiskFullError(Object.assign(new Error("nope"), { code: "EACCES" }))).toBe(false);
    expect(isDiskFullError(new Error("Failed to write workspace file"))).toBe(false);
    expect(isDiskFullError(null)).toBe(false);
  });
});

describe("where a space check looks", () => {
  it("reads the paths an upload targets", () => {
    expect(spaceCheckPath("/home/me", "~")).toBe("/home/me");
    expect(spaceCheckPath("/home/me", "~/projects/a")).toBe("/home/me/projects/a");
    expect(spaceCheckPath("/home/me", "/mnt/data/a")).toBe("/mnt/data/a");
    expect(spaceCheckPath("/home/me", "projects/a")).toBe("/home/me");
  });
});

describe("disk space check", () => {
  it("keeps 1 GB, or 5% of a big disk", () => {
    expect(reserveBytes(10 * GB)).toBe(DISK_RESERVE_MIN_BYTES);
    expect(reserveBytes(200 * GB)).toBe(10 * GB);
  });

  it("lets through what leaves the reserve free", () => {
    const disk = { freeBytes: 5 * GB, totalBytes: 20 * GB };
    expect(fitsOnDisk(4 * GB, disk)).toBe(true);
    expect(fitsOnDisk(4 * GB + 1, disk)).toBe(false);
  });

  it("lets a small copy into the reserve as long as it fits", () => {
    const low = { freeBytes: GB / 2, totalBytes: 20 * GB };
    expect(fitsOnDisk(0, low)).toBe(true);
    expect(fitsOnDisk(DISK_SMALL_COPY_BYTES - 1, low)).toBe(true);
    expect(fitsOnDisk(DISK_SMALL_COPY_BYTES, low)).toBe(false);
    expect(fitsOnDisk(10 * 1024 ** 2, { freeBytes: 5 * 1024 ** 2, totalBytes: 20 * GB })).toBe(
      false,
    );
  });

  it("refuses with both sizes, worded for people and for agents", async () => {
    const measure = async () => ({ freeBytes: 3 * GB, totalBytes: 20 * GB });
    const refusal = await ensureDiskSpace("/x", 2.5 * GB, measure).catch((error) => error);
    expect(refusal).toBeInstanceOf(NotEnoughSpaceError);
    expect(refusal.message).toBe(
      "Not enough space on this computer: needs 2.5 GB and 1.0 GB left for the computer itself, 3.0 GB free. Free up space or pick fewer files.",
    );
    expect(agentDiskSpaceMessage(refusal.message)).toBe(
      "Not enough space on this computer: needs 2.5 GB and 1.0 GB left for the computer itself, 3.0 GB free. Free space with computer_cleanup or pick fewer files.",
    );
    const tooBig = await ensureDiskSpace("/x", 10 * GB, measure).catch((error) => error);
    expect(tooBig.message).toBe(
      "Not enough space on this computer: needs 10 GB, 3.0 GB free. Free up space or pick fewer files.",
    );
    expect(agentDiskSpaceMessage("Cloud storage is full.")).toBe("Cloud storage is full.");
    await expect(ensureDiskSpace("/x", GB, measure)).resolves.toBeUndefined();
  });

  it("lets through a volume it can't measure", async () => {
    await expect(ensureDiskSpace("/x", 100 * GB, async () => null)).resolves.toBeUndefined();
  });

  it("measures a folder that doesn't exist yet on the volume of its parent", async () => {
    const space = await diskSpaceAt(nodePath.join(os.tmpdir(), "not", "made", "yet"));
    expect(space?.totalBytes).toBeGreaterThan(0);
  });

  it("measures a real folder", async () => {
    const space = await diskSpaceAt(os.tmpdir());
    expect(space?.totalBytes).toBeGreaterThan(0);
    expect(space!.freeBytes).toBeLessThanOrEqual(space!.totalBytes);
  });
});
