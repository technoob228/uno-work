import os from "node:os";

import { describe, expect, it } from "vitest";

import {
  DISK_RESERVE_MIN_BYTES,
  NotEnoughSpaceError,
  agentDiskSpaceMessage,
  diskSpaceAt,
  ensureDiskSpace,
  fitsOnDisk,
  reserveBytes,
} from "./diskSpace.ts";

const GB = 1024 ** 3;

describe("disk space check", () => {
  it("keeps 1 GB, or 5% of a big disk", () => {
    expect(reserveBytes(10 * GB)).toBe(DISK_RESERVE_MIN_BYTES);
    expect(reserveBytes(200 * GB)).toBe(10 * GB);
  });

  it("lets through what leaves the reserve free", () => {
    const disk = { freeBytes: 5 * GB, totalBytes: 20 * GB };
    expect(fitsOnDisk(4 * GB, disk)).toBe(true);
    expect(fitsOnDisk(4 * GB + 1, disk)).toBe(false);
    expect(fitsOnDisk(0, { freeBytes: GB / 2, totalBytes: 20 * GB })).toBe(false);
  });

  it("refuses with both sizes, worded for people and for agents", async () => {
    const measure = async () => ({ freeBytes: 3 * GB, totalBytes: 20 * GB });
    const refusal = await ensureDiskSpace("/x", 2.5 * GB, measure).catch((error) => error);
    expect(refusal).toBeInstanceOf(NotEnoughSpaceError);
    expect(refusal.message).toBe(
      "Not enough space on this computer: needs 2.5 GB, 3.0 GB free. Free up space or pick fewer files.",
    );
    expect(agentDiskSpaceMessage(refusal.message)).toBe(
      "Not enough space on this computer: needs 2.5 GB, 3.0 GB free. Free space with computer_cleanup or pick fewer files.",
    );
    expect(agentDiskSpaceMessage("Cloud storage is full.")).toBe("Cloud storage is full.");
    await expect(ensureDiskSpace("/x", GB, measure)).resolves.toBeUndefined();
  });

  it("lets through a volume it can't measure", async () => {
    await expect(ensureDiskSpace("/x", 100 * GB, async () => null)).resolves.toBeUndefined();
    expect(await diskSpaceAt("/definitely/not/here")).toBeNull();
  });

  it("measures a real folder", async () => {
    const space = await diskSpaceAt(os.tmpdir());
    expect(space?.totalBytes).toBeGreaterThan(0);
    expect(space!.freeBytes).toBeLessThanOrEqual(space!.totalBytes);
  });
});
