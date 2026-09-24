import { describe, expect, it } from "vitest";

import {
  parseAccountComputer,
  parseCloudUsage,
  parsePayments,
  parsePlanCatalog,
  parseSites,
  parseSubscription,
  roleChangeBody,
} from "./accountOverview";
import {
  computerMonthlyShare,
  formatBytes,
  planDirection,
  planLadder,
  planTitle,
  usageLines,
} from "./billingModel";

const v2Plan = (
  slug: string,
  base: string,
  name: string,
  price: number,
  ramGb: number,
  ai = 0,
) => ({
  slug,
  name,
  price_usd: price,
  compute_price_usd: price - ai,
  generation: 2,
  base_slug: base,
  ai_credits_usd: ai,
  ai_bundle: ai > 0,
  max_box: { ram_mb: ramGb * 1024, vcpu: Math.max(1, ramGb / 2) },
  peak: { ram_mb: ramGb * 1024, vcpu: Math.max(1, ramGb / 2) },
  disk_gb: 40,
  s3_gb: 100,
  boost_hours: 10,
  cloud_work: ramGb >= 4,
  legacy: false,
});

const catalogV2 = parsePlanCatalog({
  plans_v2: true,
  plans: [
    v2Plan("plus", "plus", "Plus", 20, 4),
    v2Plan("plus-ai", "plus", "Plus", 50, 4, 30),
    v2Plan("small", "small", "Small", 5, 1),
    v2Plan("small-ai", "small", "Small", 20, 1, 15),
    { ...v2Plan("builder", "builder", "", 22, 4), generation: 1, legacy: true },
  ],
});

describe("plan ladder", () => {
  it("pairs a computer with and without Uno AI, cheapest first, legacy off the ladder", () => {
    const rungs = planLadder(catalogV2);
    expect(rungs.map((r) => r.key)).toEqual(["small", "plus"]);
    expect(rungs[1]!.plain?.slug).toBe("plus");
    expect(rungs[1]!.withAi?.slug).toBe("plus-ai");
  });

  it("old catalogs are one plan per rung", () => {
    const old = parsePlanCatalog({
      plans: [
        { slug: "pro", price_usd: 69, max_box: { ram_mb: 16384, vcpu: 8 } },
        { slug: "mini", price_usd: 10, max_box: { ram_mb: 2048, vcpu: 2 } },
      ],
    });
    expect(old.plansV2).toBe(false);
    expect(planLadder(old).map((r) => r.key)).toEqual(["mini", "pro"]);
    expect(planTitle(old.plans[0]!)).toBe("Pro");
  });

  it("names plans the way people read them", () => {
    expect(planTitle(catalogV2.plans[1]!)).toBe("Plus + Uno AI");
    expect(planTitle(null, "trial")).toBe("Free course");
  });
});

describe("subscription", () => {
  const sub = parseSubscription({
    plan: "plus",
    status: "active",
    price_usd: 20,
    next_billing_at: "2026-10-23T00:00:00Z",
    plan_limits: v2Plan("plus", "plus", "Plus", 20, 4),
    ai_credits: { monthly_usd: 0, period_usd: 0, carry_usd: 0 },
    usage: { running_ram_mb: 2048, running_vcpu: 1, disk_gb_used: 12.5, box_count: 2 },
  })!;

  it("parses what the plan includes and uses", () => {
    expect(sub.limits?.peakRamMb).toBe(4096);
    expect(sub.usage.diskGbUsed).toBe(12.5);
    const lines = usageLines({
      subscription: sub,
      cloudUsedBytes: 5 * 1024 ** 3,
      cloudQuotaBytes: 100 * 1024 ** 3,
      sitesUsedBytes: 1024 ** 2,
      sitesLimitBytes: 10 * 1024 ** 3,
      computers: 2,
    });
    expect(lines.map((l) => [l.key, l.pct])).toEqual([
      ["compute", 50],
      ["disk", 31],
      ["cloud", 5],
      ["sites", 0],
    ]);
  });

  it("a computer costs its share of the plan's memory", () => {
    expect(computerMonthlyShare({ ramMb: 1024 }, sub)).toBe(5);
    expect(computerMonthlyShare({ ramMb: 8192 }, sub)).toBe(20);
    expect(computerMonthlyShare({ ramMb: 1024 }, null)).toBeNull();
  });

  it("knows up from down, and equal price with a bigger computer is up", () => {
    expect(planDirection(sub, catalogV2.plans[0]!)).toBe("current");
    expect(planDirection(sub, catalogV2.plans[1]!)).toBe("upgrade");
    expect(planDirection(sub, catalogV2.plans[2]!)).toBe("downgrade");
    expect(planDirection(null, catalogV2.plans[2]!)).toBe("start");
    const smallAi = parseSubscription({
      plan: "small-ai",
      price_usd: 20,
      plan_limits: v2Plan("small-ai", "small", "Small", 20, 1, 15),
    });
    expect(planDirection(smallAi, catalogV2.plans[0]!)).toBe("upgrade");
  });

  it("no plan reads as null", () => {
    expect(parseSubscription({})).toBeNull();
  });
});

describe("account payloads", () => {
  it("computers: role from comment, Work machines are workspaces, deleted dropped", () => {
    expect(
      parseAccountComputer({
        id: 5,
        name: "vpn",
        status: "running",
        comment: "[production] x",
        ram_mb: 1024,
      }),
    ).toMatchObject({
      role: "production",
      note: "x",
      workMachine: false,
    });
    expect(parseAccountComputer({ id: 6, status: "sleeping", work_machine: true })?.role).toBe(
      "workspace",
    );
    expect(parseAccountComputer({ id: 7, status: "deleted" })).toBeNull();
  });

  it("computers: role from the computer_role field (console 139), writes go where it lives", () => {
    const fresh = parseAccountComputer({
      id: 8,
      status: "running",
      comment: "shop backend",
      computer_role: "staging",
    })!;
    expect(fresh).toMatchObject({ role: "staging", note: "shop backend", roleInField: true });
    expect(roleChangeBody(fresh, "production")).toEqual({ computer_role: "production" });
    // Field present but unset — a plain server, still written through the field.
    const unset = parseAccountComputer({ id: 9, status: "running", computer_role: null })!;
    expect(unset.role).toBe("server");
    expect(roleChangeBody(unset, "sandbox")).toEqual({ computer_role: "sandbox" });
    // Older console: no field — role from the tag, written back as a tag.
    const legacy = parseAccountComputer({ id: 10, status: "running", comment: "[sandbox] vpn" })!;
    expect(legacy).toMatchObject({ role: "sandbox", note: "vpn", roleInField: false });
    expect(roleChangeBody(legacy, "production")).toEqual({ comment: "[production] vpn" });
  });

  it("sites: custom domain wins, newest first", () => {
    const sites = parseSites({
      deploys: [
        { slug: "a", url: "https://a.uno4.dev", updated_at: "2026-09-01T00:00:00Z" },
        {
          slug: "b",
          url: "https://b.uno4.dev",
          custom_domain: "b.com",
          updated_at: "2026-09-20T00:00:00Z",
        },
      ],
      storage_used_bytes: 10,
      storage_limit_bytes: 100,
    });
    expect(sites.sites.map((s) => s.url)).toEqual(["https://b.com", "https://a.uno4.dev"]);
  });

  it("cloud: account storage summary, or the sum of buckets", () => {
    expect(parseCloudUsage({ buckets: [], storage: { used_bytes: 5, quota_bytes: 50 } })).toEqual({
      usedBytes: 5,
      quotaBytes: 50,
      buckets: 0,
      bucketList: [],
    });
    expect(parseCloudUsage({ buckets: [{ used_bytes: 2 }, { used_bytes: 3 }] }).usedBytes).toBe(5);
    expect(
      parseCloudUsage({
        buckets: [
          { name: "files", used_bytes: 2 },
          { name: "backups", used_bytes: 9 },
          { used_bytes: 1 },
        ],
      }).bucketList,
    ).toEqual([
      { name: "backups", usedBytes: 9 },
      { name: "files", usedBytes: 2 },
    ]);
  });

  it("payments: top-ups and charges in one list, newest first, expired invoices hidden", () => {
    const rows = parsePayments(
      {
        payments: [
          {
            order_id: "o1",
            amount: 25,
            payment_method: "direct",
            status: "completed",
            created_at: "2026-09-01T10:00:00Z",
            completed_at: "2026-09-01T10:05:00Z",
          },
          {
            order_id: "o2",
            amount: 10,
            payment_method: "nowpayments",
            status: "expired",
            created_at: "2026-09-02T10:00:00Z",
          },
        ],
      },
      {
        spending: [
          {
            amount: -20,
            category: "other",
            description: "Plan Plus",
            created_at: "2026-09-10T00:00:00Z",
          },
          // getuno.xyz charges on the same balance are not Uno's.
          { amount: -3, category: "vps", description: "VPS", created_at: "2026-09-11T00:00:00Z" },
          { amount: -1, category: "sms", description: "SMS", created_at: "2026-09-12T00:00:00Z" },
        ],
      },
    );
    expect(rows.map((r) => [r.direction, r.amountUsd, r.title])).toEqual([
      ["out", 20, "Plan Plus"],
      ["in", 25, "Added money · USDT (TRC-20)"],
    ]);
  });

  it("formats bytes like a person", () => {
    expect(formatBytes(0)).toBe("0 GB");
    expect(formatBytes(512 * 1024 ** 2)).toBe("512 MB");
    expect(formatBytes(1.5 * 1024 ** 3)).toBe("1.5 GB");
    expect(formatBytes(1024 ** 4)).toBe("1 TB");
  });
});

describe("create errors", () => {
  it("say what to do", async () => {
    const { describeCreateError } = await import("./accountOverview");
    expect(describeCreateError(new Error('409: {"error":"PEAK_EXCEEDED"}')).plan).toBe(true);
    expect(describeCreateError(new Error("403: SHAPE_TOO_LARGE")).plan).toBe(true);
    expect(describeCreateError(new Error('400: {"error":"INVALID_NAME"}'))).toEqual({
      message: "Uno couldn't create it: INVALID_NAME",
      plan: false,
    });
  });
});
