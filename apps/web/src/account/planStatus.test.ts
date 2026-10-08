import { describe, expect, it } from "vitest";

import { planStatusLine } from "./planStatus";

const formatDate = (iso: string | null) => (iso ? iso.slice(0, 10) : null);
const formatUsd = (usd: number) => `$${usd}`;
const base = {
  status: "active",
  nextBillingAt: "2026-11-02T10:00:00Z",
  trialExpiresAt: null,
  cancelledAt: null,
  planEndedAt: null,
  keepUntil: null,
};
const line = (subscription: typeof base | Record<string, string | null>, shortUsd = 0) =>
  planStatusLine({
    subscription: { ...base, ...subscription },
    shortUsd,
    pendingPlanTitle: null,
    formatDate,
    formatUsd,
  });

describe("planStatusLine", () => {
  it("a live plan renews, with the top-up it needs", () => {
    expect(line(base)).toEqual({
      kind: "renews",
      text: "Renews on 2026-11-02 from your balance.",
    });
    expect(line(base, 20)?.text).toBe(
      "Renews on 2026-11-02 from your balance — add $20 before then.",
    );
  });

  it("a cancelled plan ends, is never said to renew or to need money, and can be kept", () => {
    const cancelled = line({ cancelledAt: "2026-10-07T12:00:00Z" }, 20);
    expect(cancelled).toMatchObject({
      kind: "cancelled",
      text: "Ends on 2026-11-02, no more charges.",
      action: { label: "Keep my plan" },
    });
    expect(cancelled?.kind === "cancelled" && cancelled.action.href).toMatch(
      /\/billing\?resume=1$/,
    );
    expect(cancelled?.text).not.toMatch(/renew|add \$/i);
  });

  it("an ended plan says until when the computers are kept", () => {
    expect(
      line({
        cancelledAt: "2026-10-07T12:00:00Z",
        planEndedAt: "2026-11-02T10:00:00Z",
        keepUntil: "2026-12-02T10:00:00Z",
        status: "paused",
      }),
    ).toMatchObject({
      kind: "ended",
      text: "Ended on 2026-11-02. Your computers are kept until 2026-12-02.",
      action: { label: "Choose a plan" },
    });
  });

  it("the course trial keeps its line", () => {
    expect(line({ trialExpiresAt: "2026-12-01T00:00:00Z" })?.text).toBe(
      "Free course until 2026-12-01.",
    );
  });
});
