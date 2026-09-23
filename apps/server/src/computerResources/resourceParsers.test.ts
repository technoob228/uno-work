import { describe, expect, it } from "vitest";

import {
  macAppName,
  maskCommand,
  parseCpuTotals,
  parseDockerSize,
  parseDockerSystemDf,
  parseDu,
  parseMacPs,
  parseMacSwap,
  parseMeminfo,
  parseNetDev,
  parseProcStat,
  parseStatusUid,
  parseVmStat,
} from "./resourceParsers.ts";

describe("parseProcStat", () => {
  it("reads fields after a name with spaces and parentheses", () => {
    const line =
      "4242 (node (worker) x) S 1 4242 4242 0 -1 4194304 100 0 0 0 250 50 0 0 20 0 11 0 98765 1000000 5120 18446744073709551615";
    const stat = parseProcStat(line);
    expect(stat).toMatchObject({
      pid: 4242,
      comm: "node (worker) x",
      state: "S",
      ppid: 1,
      utime: 250,
      stime: 50,
      starttime: 98765,
      rssPages: 5120,
    });
  });

  it("rejects garbage", () => {
    expect(parseProcStat("nonsense")).toBeNull();
  });
});

describe("parseStatusUid", () => {
  it("takes the real uid", () => {
    expect(parseStatusUid("Name:\tbash\nUid:\t1002\t1002\t1002\t1002\n")).toBe(1002);
  });
});

describe("parseMeminfo", () => {
  it("splits used, cache and free like `free`", () => {
    const text = [
      "MemTotal:        4000000 kB",
      "MemFree:          500000 kB",
      "MemAvailable:    2500000 kB",
      "Buffers:          100000 kB",
      "Cached:          1800000 kB",
      "SReclaimable:     200000 kB",
      "Shmem:            100000 kB",
      "SwapTotal:       1048576 kB",
      "SwapFree:         524288 kB",
    ].join("\n");
    const m = parseMeminfo(text)!;
    expect(m.totalMb).toBe(3906);
    expect(m.cacheMb).toBe(1953); // 100+1800+200-100 MB-ish
    expect(m.usedMb).toBe(1465);
    expect(m.availableMb).toBe(2441);
    expect(m.swapTotalMb).toBe(1024);
    expect(m.swapUsedMb).toBe(512);
  });
});

describe("parseCpuTotals", () => {
  it("counts idle and iowait as idle", () => {
    expect(parseCpuTotals("cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3 4\n")).toEqual({
      idle: 850,
      total: 1000,
    });
  });
});

describe("parseNetDev", () => {
  it("sums the real interfaces only", () => {
    const text = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 5000 10 0 0 0 0 0 0 5000 10 0 0 0 0 0 0
  eth0: 1000 10 0 0 0 0 0 0 2000 10 0 0 0 0 0 0
docker0: 9999 10 0 0 0 0 0 0 9999 10 0 0 0 0 0 0
vethab12: 7777 10 0 0 0 0 0 0 7777 10 0 0 0 0 0 0`;
    expect(parseNetDev(text)).toEqual({ rx: 1000, tx: 2000 });
  });
});

describe("mac readers", () => {
  it("parses ps with lstart and a path with spaces", () => {
    const out =
      "  501     1   501  204800  12.5 Tue Sep 23 10:01:02 2026     /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n";
    const [p] = parseMacPs(out);
    expect(p).toMatchObject({ pid: 501, ppid: 1, uid: 501, cpuPctPerCore: 12.5 });
    expect(p!.memMb).toBe(200);
    expect(p!.name).toBe("Google Chrome");
    expect(macAppName(p!.exe)).toBe("Google Chrome");
  });

  it("counts memory like Activity Monitor", () => {
    const vm = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                            200000.
Pages inactive:                          190000.
Pages speculative:                         5000.
Pages wired down:                         60000.
Pages purgeable:                           2000.
File-backed pages:                       150000.
Anonymous pages:                         245000.
Pages occupied by compressor:             40000.`;
    const m = parseVmStat(vm, 16 * 1024 ** 3)!;
    expect(m.totalMb).toBe(16384);
    // (245000-2000 + 60000 + 40000) pages × 16 KB
    expect(m.usedMb).toBe(5359);
    expect(m.cacheMb).toBe(2375);
    expect(m.freeMb).toBeLessThanOrEqual(m.totalMb - m.usedMb - m.cacheMb);
  });

  it("parses swap usage", () => {
    expect(parseMacSwap("total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)")).toEqual(
      { totalMb: 2048, usedMb: 1025 },
    );
  });
});

describe("du and docker", () => {
  it("parses du lines", () => {
    expect(parseDu("12\t/home/u/a\n4\t/home/u/b c\nbad\n")).toEqual([
      { path: "/home/u/a", bytes: 12288 },
      { path: "/home/u/b c", bytes: 4096 },
    ]);
  });

  it("reads docker sizes", () => {
    expect(parseDockerSize("1.2GB")).toBe(1_200_000_000);
    expect(parseDockerSize("800MB (66%)")).toBe(800_000_000);
    expect(parseDockerSize("12.5kB")).toBe(12_500);
    expect(parseDockerSize("0B")).toBe(0);
    expect(parseDockerSize("n/a")).toBeNull();
  });

  it("reads docker system df", () => {
    const out = [
      '{"Active":"2","Reclaimable":"1.1GB (50%)","Size":"2.2GB","TotalCount":"5","Type":"Images"}',
      '{"Active":"2","Reclaimable":"0B (0%)","Size":"10MB","TotalCount":"2","Type":"Containers"}',
      '{"Active":"1","Reclaimable":"0B","Size":"300MB","TotalCount":"1","Type":"Local Volumes"}',
      '{"Active":"0","Reclaimable":"450MB","Size":"450MB","TotalCount":"9","Type":"Build Cache"}',
    ].join("\n");
    expect(parseDockerSystemDf(out)).toEqual({
      imagesBytes: 2_200_000_000,
      containersBytes: 10_000_000,
      volumesBytes: 300_000_000,
      buildCacheBytes: 450_000_000,
      buildCacheReclaimableBytes: 450_000_000,
    });
  });
});

describe("maskCommand", () => {
  it("masks secret flags, env assignments and known key formats", () => {
    const masked = maskCommand(
      "node server.js --api-key abc123 --password=hunter2 API_TOKEN=xyz sk-ant-abcdefghijklmnopqrstu --port 3000",
    );
    expect(masked).not.toContain("abc123");
    expect(masked).not.toContain("hunter2");
    expect(masked).not.toContain("xyz");
    expect(masked).not.toContain("sk-ant-abcdefghijklmnopqrstu");
    expect(masked).toContain("--port 3000");
    expect(masked).toContain("node server.js");
  });

  it("shortens long lines", () => {
    expect(maskCommand("x".repeat(500), 50)).toHaveLength(50);
  });
});
