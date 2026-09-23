import type { UnoComputerResources, UnoResourceGroup } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  askUnoPrompt,
  breadcrumbs,
  formatBytes,
  matchChat,
  memoryBar,
  parseResourceLook,
  resourceTips,
  seriesPath,
} from "./resourceModel";

function group(
  partial: Partial<UnoResourceGroup> & Pick<UnoResourceGroup, "id">,
): UnoResourceGroup {
  return {
    kind: "program",
    name: partial.id,
    detail: null,
    icon: null,
    cpuPct: 0,
    memMb: 0,
    processes: [],
    processCount: 1,
    cwd: null,
    machineAppId: null,
    actions: [],
    actionsBlockedReason: null,
    ...partial,
  };
}

function resources(partial: Partial<UnoComputerResources> = {}): UnoComputerResources {
  return {
    platform: "linux",
    sampledAt: "2026-09-23T10:00:00Z",
    cpuCount: 2,
    cpuPct: 10,
    load1: 0.2,
    memory: {
      totalMb: 4096,
      usedMb: 1000,
      cacheMb: 1500,
      freeMb: 1596,
      availableMb: 3000,
      swapTotalMb: 0,
      swapUsedMb: 0,
    },
    volumes: [{ label: "Disk", mount: "/home/u", totalGb: 20, usedGb: 5, freeGb: 15 }],
    netRxBps: 0,
    netTxBps: 0,
    history: [],
    historyStepS: 5,
    groups: [],
    processCount: 10,
    docker: "not-running",
    notes: [],
    ...partial,
  };
}

describe("resource words", () => {
  it("parses the look search param", () => {
    expect(parseResourceLook("disk")).toBe("disk");
    expect(parseResourceLook("nope")).toBeUndefined();
  });

  it("formats bytes the way people read them", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(350 * 1024 * 1024)).toBe("350 MB");
    expect(formatBytes(3.5 * 1024 ** 3)).toBe("3.5 GB");
    expect(formatBytes(null)).toBe("—");
  });

  it("splits the memory bar into used, cache and free", () => {
    const bar = memoryBar(resources().memory);
    expect(Math.round(bar.usedPct + bar.cachePct + bar.freePct)).toBe(100);
    expect(bar.cachePct).toBeGreaterThan(bar.usedPct);
  });
});

describe("resourceTips", () => {
  it("is quiet when there is room", () => {
    expect(resourceTips(resources())).toEqual([]);
  });

  it("names who eats memory when it runs short (cache doesn't count)", () => {
    const tips = resourceTips(
      resources({
        memory: {
          totalMb: 4096,
          usedMb: 3800,
          cacheMb: 100,
          freeMb: 196,
          availableMb: 250,
          swapTotalMb: 1024,
          swapUsedMb: 600,
        },
        groups: [
          group({ id: "system", kind: "system", memMb: 3000 }),
          group({ id: "docker:n8n", name: "n8n", kind: "docker", memMb: 1800 }),
          group({ id: "chat:1", name: "Claude Code", kind: "chat", memMb: 400 }),
        ],
      }),
    );
    expect(tips).toHaveLength(1);
    expect(tips[0]!.look).toBe("memory");
    expect(tips[0]!.groupId).toBe("docker:n8n");
    expect(tips[0]!.body).toContain("n8n");
    expect(tips[0]!.body).toContain("swap");
  });

  it("flags a steadily busy processor and a full disk", () => {
    const busy = resources({
      history: Array.from({ length: 6 }, (_, i) => ({
        t: String(i),
        cpuPct: 95,
        memUsedMb: 1000,
        netRxBps: null,
        netTxBps: null,
      })),
      groups: [group({ id: "terminal:5", name: "Terminal", kind: "terminal", cpuPct: 90 })],
      volumes: [{ label: "Disk", mount: "/", totalGb: 20, usedGb: 19, freeGb: 1 }],
    });
    const looks = resourceTips(busy).map((t) => t.look);
    expect(looks).toEqual(["cpu", "disk"]);
  });
});

describe("matchChat", () => {
  const candidates = [
    {
      id: "a",
      environmentId: "e",
      title: "Old",
      cwd: "/home/u/p",
      active: false,
      updatedAt: "2026-09-20T00:00:00Z",
    },
    {
      id: "b",
      environmentId: "e",
      title: "Running",
      cwd: "/home/u/p/",
      active: true,
      updatedAt: "2026-09-19T00:00:00Z",
    },
    {
      id: "c",
      environmentId: "e",
      title: "Other",
      cwd: "/home/u/q",
      active: true,
      updatedAt: "2026-09-23T00:00:00Z",
    },
  ];

  it("prefers the running chat in the agent's folder", () => {
    expect(matchChat("/home/u/p", candidates)?.id).toBe("b");
  });

  it("finds nothing without a folder", () => {
    expect(matchChat(null, candidates)).toBeNull();
    expect(matchChat("/elsewhere", candidates)).toBeNull();
  });
});

describe("askUnoPrompt", () => {
  it("hands Uno the numbers and asks it not to act alone", () => {
    const text = askUnoPrompt(
      "memory",
      resources({ groups: [group({ id: "docker:n8n", name: "n8n", kind: "docker", memMb: 900 })] }),
      null,
    );
    expect(text).toContain("memory");
    expect(text).toContain("n8n (container");
    expect(text).toMatch(/Don't stop, delete or uninstall anything until I say yes/);
  });
});

describe("chart and crumbs", () => {
  it("draws nothing for a single point", () => {
    expect(seriesPath([5], 100, 10, 100).line).toBe("");
    expect(seriesPath([0, 100], 100, 10, 100).line).toBe("M0.0,10.0 L100.0,0.0");
  });

  it("builds breadcrumbs from home", () => {
    expect(breadcrumbs("/home/u", "/home/u/a/b").map((c) => c.name)).toEqual([
      "Home folder",
      "a",
      "b",
    ]);
  });
});
