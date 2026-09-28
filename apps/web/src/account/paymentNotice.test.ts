import { describe, expect, it } from "vitest";

import { parsePaymentNotice, parseSubscription, paymentNoticeKey } from "./accountOverview";

// Recorded from production /api/v1/box-subscription (2026-09-27).
const grace = {
  state: "grace",
  severity: "critical",
  title: "Payment overdue",
  message: "Payment overdue — pay by Sep 29 to keep your computer.",
  pay_by: "2026-09-29T03:23:38Z",
  delete_after: null,
  action_label: "Pay now",
  action_url: "https://console.uno4.dev/billing",
};

describe("payment notice", () => {
  it("parses the grace notice as sent", () => {
    expect(parsePaymentNotice(grace)).toEqual({
      state: "grace",
      severity: "critical",
      title: "Payment overdue",
      message: "Payment overdue — pay by Sep 29 to keep your computer.",
      payBy: "2026-09-29T03:23:38Z",
      deleteAfter: null,
      actionLabel: "Pay now",
      actionUrl: "https://console.uno4.dev/billing",
    });
  });

  it("parses a paused notice", () => {
    const notice = parsePaymentNotice({
      ...grace,
      state: "paused",
      title: "Your computer is paused",
      delete_after: "2026-10-13T03:23:38Z",
    });
    expect(notice?.state).toBe("paused");
    expect(notice?.title).toBe("Your computer is paused");
    expect(notice?.deleteAfter).toBe("2026-10-13T03:23:38Z");
  });

  it("absent, null or empty reads as no notice", () => {
    expect(parsePaymentNotice(undefined)).toBeNull();
    expect(parsePaymentNotice(null)).toBeNull();
    expect(parsePaymentNotice("overdue")).toBeNull();
    expect(parsePaymentNotice([])).toBeNull();
    expect(parsePaymentNotice({ state: "grace" })).toBeNull();
  });

  it("drops a non-http action and its label", () => {
    const notice = parsePaymentNotice({ ...grace, action_url: "javascript:alert(1)" });
    expect(notice?.actionUrl).toBeNull();
    expect(notice?.actionLabel).toBeNull();
    expect(notice?.message).toBe(grace.message);
    expect(parsePaymentNotice({ ...grace, action_url: 42 })?.actionUrl).toBeNull();
  });

  it("rides on the subscription; missing means null", () => {
    expect(parseSubscription({ plan: "plus", payment_notice: grace })?.paymentNotice?.title).toBe(
      "Payment overdue",
    );
    expect(parseSubscription({ plan: "plus" })?.paymentNotice).toBeNull();
    expect(parseSubscription({ plan: "plus", payment_notice: null })?.paymentNotice).toBeNull();
  });

  it("a new state or date shows a dismissed notice again", () => {
    const a = parsePaymentNotice(grace)!;
    const b = parsePaymentNotice({ ...grace, state: "paused", title: "Your computer is paused" })!;
    const c = parsePaymentNotice({ ...grace, pay_by: "2026-10-29T03:23:38Z" })!;
    expect(paymentNoticeKey(a)).toBe(paymentNoticeKey(parsePaymentNotice(grace)!));
    expect(paymentNoticeKey(a)).not.toBe(paymentNoticeKey(b));
    expect(paymentNoticeKey(a)).not.toBe(paymentNoticeKey(c));
  });
});
