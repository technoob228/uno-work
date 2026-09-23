import { describe, expect, it } from "vitest";

import { emptyStoredApp } from "./appAiStore.ts";
import {
  applyGatewayTotal,
  gatewayKeyTag,
  makeTaskMeter,
  parseGatewayAppUsage,
} from "./appTaskMeter.ts";

describe("parseGatewayAppUsage", () => {
  it("reads the gateway's rows and skips junk", () => {
    expect(
      parseGatewayAppUsage({
        object: "list",
        data: [{ app: "a", cost_usd: 0.5, requests: 2 }, { app: 1 }, { app: "b", cost_usd: "x" }],
      }),
    ).toEqual([{ app: "a", costUsd: 0.5 }]);
    expect(parseGatewayAppUsage({ error: {} })).toBeNull();
  });
});

describe("applyGatewayTotal", () => {
  it("adds only what the total grew, and a reset keeps counting growth", () => {
    const app = emptyStoredApp("a");
    applyGatewayTotal(app, 0.3, "k1");
    expect(app.taskSpentUsd).toBe(0.3);
    applyGatewayTotal(app, 0.3, "k1");
    expect(app.taskSpentUsd).toBe(0.3);
    app.taskSpentUsd = 0; // the person pressed Reset
    applyGatewayTotal(app, 0.5, "k1");
    expect(app.taskSpentUsd).toBeCloseTo(0.2);
  });

  it("a new machine key starts from zero — nothing lost, nothing counted twice", () => {
    const app = emptyStoredApp("a");
    applyGatewayTotal(app, 1, "k1");
    applyGatewayTotal(app, 0.25, "k2");
    expect(app.taskSpentUsd).toBe(1.25);
    expect(app.taskGatewayKeyTag).toBe("k2");
  });

  it("a total that shrank for the same key adds nothing", () => {
    const app = emptyStoredApp("a");
    applyGatewayTotal(app, 1, "k1");
    applyGatewayTotal(app, 0.4, "k1");
    applyGatewayTotal(app, 0.6, "k1");
    expect(app.taskSpentUsd).toBeCloseTo(1.2);
  });
});

describe("makeTaskMeter", () => {
  const setup = (reply: () => Response) => {
    const app = { ...emptyStoredApp("digest"), tasksStarted: 1 };
    const calls: string[] = [];
    let persisted = 0;
    let clock = 0;
    const meter = makeTaskMeter({
      gateway: async () => ({ baseUrl: "https://gw/v1", key: "unollm_secret" }),
      apps: () => [app],
      persist: async () => {
        persisted += 1;
      },
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push(`${url} ${new Headers(init?.headers).get("authorization")}`);
        return reply();
      }) as typeof fetch,
      now: () => clock,
    });
    return {
      app,
      calls,
      meter,
      persisted: () => persisted,
      tick: (ms: number) => {
        clock += ms;
      },
    };
  };

  it("asks the gateway with the machine key, folds totals in, and caches for a while", async () => {
    const t = setup(() => Response.json({ data: [{ app: "digest", cost_usd: 0.42 }] }));
    t.tick(60_000);
    await t.meter.refresh();
    expect(t.calls).toEqual(["https://gw/v1/usage/apps Bearer unollm_secret"]);
    expect(t.app.taskSpentUsd).toBe(0.42);
    expect(t.app.taskGatewayKeyTag).toBe(gatewayKeyTag("unollm_secret"));
    expect(t.app.taskGatewayKeyTag).not.toContain("secret");
    expect(t.meter.status()).toBe("metered");
    expect(t.persisted()).toBe(1);
    t.tick(5_000);
    await t.meter.refresh();
    expect(t.calls).toHaveLength(1);
    t.tick(30_000);
    await t.meter.refresh();
    expect(t.calls).toHaveLength(2);
  });

  it("an older gateway without per-app totals is reported, not guessed", async () => {
    const t = setup(() => new Response("not found", { status: 404 }));
    t.tick(60_000);
    await t.meter.refresh();
    expect(t.meter.status()).toBe("unavailable");
    expect(t.app.taskSpentUsd).toBe(0);
  });

  it("a network failure keeps the last numbers", async () => {
    const t = setup(() => {
      throw new Error("offline");
    });
    t.app.taskSpentUsd = 0.1;
    t.tick(60_000);
    await t.meter.refresh();
    expect(t.meter.status()).toBe("unknown");
    expect(t.app.taskSpentUsd).toBe(0.1);
  });
});
