import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  AI_SPEND_KEEP_MS,
  normalizeAiSpendSamples,
  openAiSpendLedger,
  parseGatewayCredits,
  recordAiSpendSample,
  type AiSpendSample,
} from "./aiSpendLedger.ts";

const T0 = Date.parse("2026-09-24T00:00:00Z");
const sample = (minutes: number, totalUsd: number): AiSpendSample => ({
  at: new Date(T0 + minutes * 60_000).toISOString(),
  totalUsd,
});

describe("parseGatewayCredits", () => {
  it("reads the balance and the running total", () => {
    expect(parseGatewayCredits({ llm_balance: 12.5, total_spent: 3.2, total_requests: 9 })).toEqual(
      { balanceUsd: 12.5, totalSpentUsd: 3.2 },
    );
    expect(parseGatewayCredits({ llm_balance: 1 })).toBeNull();
    expect(parseGatewayCredits({ error: "x" })).toBeNull();
    expect(parseGatewayCredits(null)).toBeNull();
  });
});

describe("recordAiSpendSample", () => {
  it("keeps samples about ten minutes apart when polled every minute", () => {
    let samples: AiSpendSample[] = [];
    for (let minute = 0; minute <= 30; minute += 1) {
      samples = recordAiSpendSample(samples, sample(minute, minute / 10));
    }
    const minutes = samples.map((s) => (Date.parse(s.at) - T0) / 60_000);
    // Newest always kept; the rest about ten minutes apart (less one poll).
    expect(minutes.at(-1)).toBe(30);
    for (let i = 1; i < minutes.length - 1; i += 1) {
      expect(minutes[i]! - minutes[i - 1]!).toBeGreaterThanOrEqual(9);
    }
    expect(samples.length).toBeLessThanOrEqual(5);
  });

  it("forgets old days but keeps one reading before the oldest kept day", () => {
    const day = 24 * 60;
    let samples: AiSpendSample[] = [];
    for (let d = 0; d <= 12; d += 1) samples = recordAiSpendSample(samples, sample(d * day, d));
    const newest = Date.parse(samples.at(-1)!.at);
    const tooOld = samples.filter((s) => Date.parse(s.at) < newest - AI_SPEND_KEEP_MS);
    expect(tooOld).toHaveLength(1);
    expect(samples.at(-1)!.totalUsd).toBe(12);
  });

  it("ignores a sample from the past or a broken one", () => {
    const samples = [sample(0, 1), sample(20, 2)];
    expect(recordAiSpendSample(samples, { at: "nope", totalUsd: 3 })).toEqual(samples);
    expect(recordAiSpendSample(samples, sample(10, 5)).map((s) => s.totalUsd)).toEqual([1, 5]);
  });
});

describe("normalizeAiSpendSamples", () => {
  it("keeps valid samples, sorted", () => {
    expect(
      normalizeAiSpendSamples([sample(20, 2), { at: "x", totalUsd: 1 }, sample(0, 1), "junk"]),
    ).toEqual([sample(0, 1), sample(20, 2)]);
    expect(normalizeAiSpendSamples(undefined)).toEqual([]);
  });
});

describe("openAiSpendLedger", () => {
  it("asks the gateway with the machine key, writes the sample down, and says why when it can't", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ai-spend-"));
    const filePath = path.join(dir, "ai-spend.json");
    let now = T0;
    const calls: string[] = [];
    const ledger = await openAiSpendLedger({
      filePath,
      gateway: async () => ({ baseUrl: "https://gw.test/v1", key: "k" }),
      now: () => now,
      fetch: (async (url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push(`${url} ${headers.authorization}`);
        return new Response(JSON.stringify({ llm_balance: 7.5, total_spent: 2.25 }));
      }) as unknown as typeof fetch,
    });
    await ledger.refresh();
    expect(calls).toEqual(["https://gw.test/v1/credits Bearer k"]);
    expect(ledger.snapshot()).toMatchObject({
      status: "ok",
      creditsUsd: 7.5,
      samples: [{ at: new Date(T0).toISOString(), totalUsd: 2.25 }],
    });
    // Fresh enough: no second call.
    now += 30_000;
    await ledger.refresh();
    expect(calls).toHaveLength(1);
    const saved = JSON.parse(await readFile(filePath, "utf8")) as { samples: unknown };
    expect(normalizeAiSpendSamples(saved.samples)).toHaveLength(1);

    const reopened = await openAiSpendLedger({ filePath, gateway: async () => null });
    await reopened.refresh();
    expect(reopened.snapshot()).toMatchObject({ status: "no-key", samples: [{ totalUsd: 2.25 }] });
  });

  it("marks a gateway without /credits as unavailable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ai-spend-"));
    const ledger = await openAiSpendLedger({
      filePath: path.join(dir, "ai-spend.json"),
      gateway: async () => ({ baseUrl: "https://gw.test/v1", key: "k" }),
      fetch: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
    });
    await ledger.refresh();
    expect(ledger.snapshot().status).toBe("unavailable");
  });
});
