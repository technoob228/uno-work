import { describe, expect, it } from "vitest";

import { parseAccountPlan, parsePlanCatalog, parseSubscription } from "../account/accountOverview";
import {
  LITE_HOME_PATH,
  cheapestCloudPlan,
  isWebLite,
  liteEmptyComputersCopy,
  liteLadder,
  liteRedirectPath,
  liteStanding,
} from "./webLite";

const plan = (
  slug: string,
  base: string,
  name: string,
  price: number,
  ramGb: number,
  vcpu: number,
  extra: Record<string, unknown> = {},
) => ({
  slug,
  name,
  price_usd: price,
  base_slug: base,
  generation: 2,
  ai_credits_usd: slug.endsWith("-ai") ? 15 : 0,
  max_box: { ram_mb: ramGb * 1024, vcpu },
  cloud_work: ramGb >= 8,
  legacy: false,
  ...extra,
});

// The ladder as of 24.09: Small 1 core, Plus 4, Pro 16, Max 32.
const catalog = parsePlanCatalog({
  plans_v2: true,
  plans: [
    plan("max", "max", "Max", 200, 64, 32),
    plan("small", "small", "Small", 5, 2, 1),
    plan("small-ai", "small", "Small", 20, 2, 1),
    plan("plus", "plus", "Plus", 20, 8, 4),
    plan("plus-ai", "plus", "Plus", 50, 8, 4),
    plan("pro-v2", "pro-v2", "Pro", 70, 32, 16),
    plan("builder", "builder", "Builder", 12, 16, 8, { legacy: true, cloud_work: true }),
  ],
});

const subscribed = (limits: Record<string, unknown>) =>
  parseSubscription({ plan: limits["slug"], status: "active", plan_limits: limits });

describe("web lite flag", () => {
  it("is off unless the build asks for it", () => {
    expect(isWebLite).toBe(false);
  });
});

describe("liteRedirectPath", () => {
  it("keeps My Uno and sends everything else there", () => {
    expect(liteRedirectPath("/my-uno")).toBeNull();
    expect(liteRedirectPath("/my-uno/")).toBeNull();
    for (const path of ["/", "/pair", "/onboarding", "/settings/general", "/computer", "/files"]) {
      expect(liteRedirectPath(path)).toBe(LITE_HOME_PATH);
    }
    expect(liteRedirectPath("/env-1/thread-1")).toBe(LITE_HOME_PATH);
  });
});

describe("liteStanding", () => {
  it("no plan is Free", () => {
    expect(liteStanding(null)).toBe("free");
  });
  it("Small (with or without Uno AI) is a server", () => {
    expect(liteStanding(subscribed(plan("small", "small", "Small", 5, 2, 1)))).toBe("small");
    expect(liteStanding(subscribed(plan("small-ai", "small", "Small", 20, 2, 1)))).toBe("small");
  });
  it("a plan with cloud_work opens Uno Work in the cloud", () => {
    expect(liteStanding(subscribed(plan("plus-ai", "plus", "Plus", 50, 8, 4)))).toBe("cloud");
  });
  it("the console's cloud_work wins over the size", () => {
    // A 4 GB computer that the console says can't run Uno Work in the cloud.
    const small4 = plan("mini", "mini", "Mini", 10, 4, 2, { cloud_work: false });
    expect(liteStanding(subscribed(small4))).toBe("other");
  });
  it("an older console without cloud_work falls back to 4 GB", () => {
    const old = { slug: "builder", name: "Builder", max_box: { ram_mb: 4096, vcpu: 2 } };
    expect(parseAccountPlan(old)?.cloudWork).toBe(true);
    expect(liteStanding(subscribed(old))).toBe("cloud");
  });
  it("a subscription without limits reads its slug", () => {
    expect(liteStanding(parseSubscription({ plan: "small-ai", status: "active" }))).toBe("small");
    expect(liteStanding(parseSubscription({ plan: "free", status: "active" }))).toBe("free");
  });
});

describe("cheapestCloudPlan", () => {
  it("is Plus without Uno AI, skipping legacy plans", () => {
    expect(cheapestCloudPlan(catalog)?.slug).toBe("plus");
  });
  it("is null without a catalog", () => {
    expect(cheapestCloudPlan(undefined)).toBeNull();
  });
});

describe("liteLadder", () => {
  it("reads sizes and prices from the catalog", () => {
    const rungs = liteLadder(catalog, "small");
    expect(rungs.map((r) => r.key)).toEqual(["free", "small", "cloud"]);
    expect(rungs[1]).toMatchObject({
      title: "Small · $5/mo",
      what: "A server, 1 core",
      current: true,
    });
    expect(rungs[2]).toMatchObject({
      title: "Plus and up · from $20/mo",
      what: "Uno Work in the cloud, 4–32 cores",
      current: false,
    });
  });
  it("marks Free and falls back to words without a catalog", () => {
    const rungs = liteLadder(undefined, "free");
    expect(rungs.map((r) => r.current)).toEqual([true, false, false]);
    expect(rungs[2]?.title).toBe("Plus and up");
  });
});

describe("liteEmptyComputersCopy", () => {
  it("doesn't suggest an Uno Work computer on Free or Small", () => {
    expect(liteEmptyComputersCopy(null)).toMatch(/^No computers yet\. A Small server/);
    const small = subscribed(plan("small-ai", "small", "Small", 20, 1, 1, { cloud_work: false }));
    expect(liteEmptyComputersCopy(small)).toMatch(/starts at Plus\.$/);
  });
  it("keeps the usual copy when the plan has Uno Work in the cloud", () => {
    expect(liteEmptyComputersCopy(subscribed(plan("plus", "plus", "Plus", 20, 8, 4)))).toBeNull();
  });
});
