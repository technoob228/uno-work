import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openAppAiStore, spendPeriod } from "./appAiStore.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "app-ai-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("monthly app AI limit", () => {
  it("names the month in UTC", () => {
    expect(spendPeriod(new Date("2026-09-30T23:59:59Z"))).toBe("2026-09");
    expect(spendPeriod(new Date("2026-10-01T00:00:00Z"))).toBe("2026-10");
  });

  it("starts the month from zero on the 1st and keeps the lifetime total", async () => {
    let now = new Date("2026-09-24T12:00:00Z");
    const file = path.join(dir, "app-ai.json");
    const store = await openAppAiStore(file, { now: () => now });
    await store.addSpend("notes", 4);
    await store.update("notes", (app) => {
      app.taskSpentUsd = 1.5;
      app.taskGatewaySeenUsd = 1.5;
    });
    expect(store.get("notes")).toMatchObject({ period: "2026-09", spentUsd: 4, lifetimeUsd: 0 });

    now = new Date("2026-10-01T00:00:01Z");
    expect(store.get("notes")).toMatchObject({
      period: "2026-10",
      spentUsd: 0,
      taskSpentUsd: 0,
      lifetimeUsd: 5.5,
      // Only the gateway's growth from now counts for October's tasks.
      taskGatewaySeenUsd: 1.5,
      requests: 1,
    });
    await store.flush();
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.apps.notes).toMatchObject({ period: "2026-10", lifetimeUsd: 5.5, spentUsd: 0 });
  });

  it("migrates entries from before the monthly limit as this month's spending", async () => {
    const file = path.join(dir, "app-ai.json");
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        apps: { old: { spentUsd: 3, taskSpentUsd: 1, limitOverrideUsd: 20 } },
      }),
    );
    const store = await openAppAiStore(file, { now: () => new Date("2026-09-24T00:00:00Z") });
    expect(store.get("old")).toMatchObject({
      period: "2026-09",
      spentUsd: 3,
      taskSpentUsd: 1,
      lifetimeUsd: 0,
      limitOverrideUsd: 20,
    });
  });
});
