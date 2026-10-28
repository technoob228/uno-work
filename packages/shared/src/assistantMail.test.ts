import { describe, expect, it } from "vitest";

import {
  applyMailPatch,
  assistantMailAddress,
  assistantMailTag,
  DEFAULT_ASSISTANT_MAIL_POLICY,
  mailBelongsTo,
  mailPolicyBeyond,
  mailPolicyLine,
  mailSendDecision,
  normalizeMailPolicy,
} from "./assistantMail.ts";

describe("an assistant's own mail", () => {
  it("each assistant has its own plus address in the computer's mailbox; Uno the plain one", () => {
    expect(assistantMailAddress("misha-otter@uno4.me", "assistant-home")).toBe(
      "misha-otter@uno4.me",
    );
    expect(assistantMailAddress("misha-otter@uno4.me", "assistant-scout")).toBe(
      "misha-otter+scout@uno4.me",
    );
    expect(assistantMailAddress("Misha-Otter@uno4.me", "assistant-Ada Lovelace-a1b2c3")).toBe(
      "misha-otter+ada-lovelace-a1b2c3@uno4.me",
    );
    expect(assistantMailTag("assistant-home")).toBeNull();
    expect(assistantMailTag(`assistant-${"x".repeat(60)}`)).toHaveLength(30);
  });

  it("reads anything as rules and cleans a change", () => {
    expect(normalizeMailPolicy(null)).toEqual(DEFAULT_ASSISTANT_MAIL_POLICY);
    expect(
      normalizeMailPolicy({
        enabled: "yes",
        recipients: "all",
        allow: ["A@B.co", "nope"],
        dailyLimit: 900,
      }),
    ).toEqual({ enabled: true, recipients: "anyone", allow: ["a@b.co"], dailyLimit: 50 });
    expect(
      applyMailPatch(DEFAULT_ASSISTANT_MAIL_POLICY, {
        recipients: "list",
        allow: ["X@Y.io", "x@y.io"],
      }),
    ).toMatchObject({ recipients: "list", allow: ["x@y.io"] });
  });

  it("says what a change would widen", () => {
    const list = { enabled: true, recipients: "list" as const, allow: ["a@b.co"], dailyLimit: 5 };
    expect(mailPolicyBeyond(list, { ...list, recipients: "owner" })).toEqual([]);
    expect(mailPolicyBeyond(list, { ...list, enabled: false })).toEqual([]);
    expect(mailPolicyBeyond(list, { ...list, recipients: "anyone" })).toEqual(["mail to anyone"]);
    expect(mailPolicyBeyond(list, { ...list, allow: ["a@b.co", "c@d.co"] })).toEqual([
      "mail to c@d.co",
    ]);
    expect(mailPolicyBeyond(list, { ...list, dailyLimit: 6 })).toEqual(["6 letters a day (now 5)"]);
    expect(mailPolicyBeyond({ ...list, enabled: false }, list)).toEqual(["its mail switched on"]);
  });

  it("decides a letter: off, the limit, who it may write to (the person always)", () => {
    const base = { ownerEmail: "misha@example.com", recipients: ["a@b.co"], sentToday: 0 };
    expect(mailSendDecision({ ...base, policy: DEFAULT_ASSISTANT_MAIL_POLICY })).toEqual({
      ok: true,
    });
    expect(
      mailSendDecision({ ...base, policy: { ...DEFAULT_ASSISTANT_MAIL_POLICY, enabled: false } }),
    ).toEqual({ ok: false, reason: "off" });
    expect(
      mailSendDecision({ ...base, sentToday: 50, policy: DEFAULT_ASSISTANT_MAIL_POLICY }),
    ).toEqual({ ok: false, reason: "limit" });
    const owner = { ...DEFAULT_ASSISTANT_MAIL_POLICY, recipients: "owner" as const };
    expect(mailSendDecision({ ...base, policy: owner })).toEqual({
      ok: false,
      reason: "recipients",
      refused: ["a@b.co"],
    });
    expect(mailSendDecision({ ...base, recipients: ["MISHA@example.com"], policy: owner })).toEqual(
      { ok: true },
    );
    expect(mailSendDecision({ ...base, ownerEmail: null, policy: owner })).toEqual({
      ok: false,
      reason: "no-owner",
    });
    const list = {
      ...DEFAULT_ASSISTANT_MAIL_POLICY,
      recipients: "list" as const,
      allow: ["a@b.co"],
    };
    expect(
      mailSendDecision({ ...base, recipients: ["a@b.co", "misha@example.com"], policy: list }),
    ).toEqual({ ok: true });
  });

  it("one line of rules", () => {
    expect(mailPolicyLine(DEFAULT_ASSISTANT_MAIL_POLICY, null)).toBe(
      "Writes to anyone · up to 50 letters a day",
    );
    expect(
      mailPolicyLine(
        { ...DEFAULT_ASSISTANT_MAIL_POLICY, recipients: "owner", dailyLimit: 1 },
        "m@x.io",
      ),
    ).toBe("Writes only to you (m@x.io) · up to 1 letter a day");
    expect(mailPolicyLine({ ...DEFAULT_ASSISTANT_MAIL_POLICY, enabled: false }, null)).toBe(
      "Mail is off",
    );
  });

  it("a letter is another assistant's when it went to its address or it sent it", () => {
    const scout = {
      isUno: false,
      address: "misha-otter+scout@uno4.me",
      sentIds: new Set(["7"]),
    };
    expect(
      mailBelongsTo({ id: "1", direction: "in", to: ["Misha-Otter+Scout@uno4.me"] }, scout),
    ).toBe(true);
    expect(mailBelongsTo({ id: "2", direction: "in", to: ["misha-otter@uno4.me"] }, scout)).toBe(
      false,
    );
    expect(mailBelongsTo({ id: "7", direction: "out", to: ["a@b.co"] }, scout)).toBe(true);
    expect(mailBelongsTo({ id: "8", direction: "out", to: ["a@b.co"] }, scout)).toBe(false);
    expect(mailBelongsTo({ id: "2", direction: "in", to: [] }, { ...scout, isUno: true })).toBe(
      true,
    );
  });
});
