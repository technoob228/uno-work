import { describe, expect, it } from "vitest";

import { resourceWarnings } from "./resourceWarnings.ts";

const memory = {
  totalMb: 2000,
  usedMb: 800,
  cacheMb: 400,
  freeMb: 800,
  availableMb: 1200,
  swapTotalMb: 1024,
  swapUsedMb: 0,
};
const disk = (usedGb: number, totalGb = 20) => ({
  label: "Disk",
  mount: "/home/unowork",
  totalGb,
  usedGb,
  freeGb: totalGb - usedGb,
});

describe("resourceWarnings", () => {
  it("says nothing when there is room", () => {
    expect(resourceWarnings({ memory, volumes: [disk(8)] })).toEqual([]);
  });

  it("warns early about a disk that is almost full and points at the clean-up", () => {
    const [note] = resourceWarnings({ memory, volumes: [disk(17.2)] });
    expect(note).toContain("Disk is almost full: 2.8 GB free of 20 GB (86% used)");
    expect(note).toContain("computer_cleanup");
  });

  it("little free space is tight even below 85% used", () => {
    const [note] = resourceWarnings({ memory, volumes: [disk(12.5, 15)] });
    expect(note).toContain("Disk is almost full");
  });

  it("a full disk: writes fail, the person's files are only moved or deleted with their yes", () => {
    const [note] = resourceWarnings({ memory, volumes: [disk(19.5)] });
    expect(note).toMatch(/^Disk is full: 0\.5 GB free/);
    expect(note).toContain("drive_save");
    expect(note).toContain("ask before deleting");
  });

  it("names the mount when there are several disks", () => {
    const notes = resourceWarnings({
      memory,
      volumes: [disk(5), { ...disk(19.5), mount: "/", label: "System disk" }],
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("Disk is full (/)");
  });

  it("warns about tight memory and swapping", () => {
    const notes = resourceWarnings({
      memory: { ...memory, availableMb: 200, swapUsedMb: 700 },
      volumes: [disk(5)],
    });
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("Memory is tight: 200 MB of 2000 MB left");
    expect(notes[1]).toContain("swapping (700 of 1024 MB swap used)");
  });

  it("swap in use with plenty of memory free is not a warning", () => {
    expect(
      resourceWarnings({ memory: { ...memory, swapUsedMb: 900 }, volumes: [disk(5)] }),
    ).toEqual([]);
  });

  it("counts the disk like df: root's reserved blocks are neither used nor free", () => {
    // 2507 on 16.10: df said 88%, the old formula 84% and no warning.
    const volume = {
      label: "Disk",
      mount: "/home/unowork",
      totalGb: 39.29,
      usedGb: 32.5,
      freeGb: 4.6,
    };
    const [note] = resourceWarnings({ memory, volumes: [volume] });
    expect(note).toContain("(88% used)");
  });
});
