import { describe, expect, it } from "vitest";

import { computerOfferCopy, fetchWorkTrialOpen, WORK_TRIAL_PUBLIC_URL } from "./computerOffer";

describe("computerOfferCopy", () => {
  it("Small: says Uno builds on Plus, offers the person's own agent", () => {
    const copy = computerOfferCopy("small");
    expect(copy.title).toBe("Uno builds this on Plus");
    expect(copy.upgradeLabel).toBe("Upgrade to Plus");
    expect(copy.ownAgent).toBe(true);
    expect(copy.note).toMatch(/Uno doesn't build there/);
  });

  it("free and unknown with a free place: the trial card as before", () => {
    for (const standing of ["free", null] as const) {
      const copy = computerOfferCopy(standing, true);
      expect(copy.title).toBe("This needs your own computer");
      expect(copy.ownAgent).toBe(false);
      expect(copy.note).toBeNull();
      expect(copy.trial).toBe(true);
      expect(copy.upgradeLabel).toBe("See plans");
    }
  });

  it("trials closed (or not known yet): no trial promise, Plus straight away", () => {
    for (const standing of ["free", null] as const) {
      for (const copy of [computerOfferCopy(standing, false), computerOfferCopy(standing)]) {
        expect(copy.trial).toBe(false);
        expect(copy.upgradeLabel).toBe("Get Plus — $20/mo");
        expect(copy.note).toMatch(/^Free trials are paused right now\./);
      }
    }
  });

  it("a plan already: no trial button; a code only while trials are open", () => {
    expect(computerOfferCopy("other", true).trial).toBe(true);
    expect(computerOfferCopy("other", false).trial).toBe(false);
    expect(computerOfferCopy("other", false).upgradeLabel).toBe("Upgrade to Plus");
    expect(computerOfferCopy("cloud", true).trial).toBe(false);
    expect(computerOfferCopy("small", true).trial).toBe(false);
  });
});

describe("fetchWorkTrialOpen", () => {
  const answer = (status: number, body: unknown) =>
    (async (url: string) => {
      expect(url).toBe(WORK_TRIAL_PUBLIC_URL);
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;

  it("true only for available: true", async () => {
    expect(await fetchWorkTrialOpen(answer(200, { available: true }))).toBe(true);
    expect(await fetchWorkTrialOpen(answer(200, { available: false }))).toBe(false);
    expect(await fetchWorkTrialOpen(answer(200, {}))).toBe(false);
    expect(await fetchWorkTrialOpen(answer(503, { available: true }))).toBe(false);
  });
});
