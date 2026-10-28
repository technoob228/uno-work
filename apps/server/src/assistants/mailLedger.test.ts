import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAIL_LEDGER_IDS_LIMIT,
  normalizeLedger,
  readMailLedger,
  recordMailSent,
  sentOn,
  withSent,
} from "./mailLedger.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("an assistant's sent letters", () => {
  it("counts today's letters and starts over the next UTC day", () => {
    const morning = new Date("2026-10-22T08:00:00Z");
    let ledger = withSent(normalizeLedger(null), { id: "1", messageId: "<a@x>" }, morning);
    ledger = withSent(ledger, { id: "2", messageId: null }, morning);
    expect(sentOn(ledger, morning)).toBe(2);
    expect(ledger.sentIds).toEqual(["1", "2"]);
    expect(ledger.messageIds).toEqual(["<a@x>"]);
    const tomorrow = new Date("2026-10-23T00:00:01Z");
    expect(sentOn(ledger, tomorrow)).toBe(0);
    expect(withSent(ledger, { id: "3", messageId: null }, tomorrow).sentToday).toBe(1);
  });

  it("keeps the newest ids only and reads anything", () => {
    const many = {
      day: "2026-10-22",
      sentToday: 1,
      sentIds: Array.from({ length: 900 }, (_, i) => `${i}`),
    };
    expect(normalizeLedger(many).sentIds).toHaveLength(MAIL_LEDGER_IDS_LIMIT);
    expect(normalizeLedger({ sentToday: -4, sentIds: [1, "x"] })).toEqual({
      day: "",
      sentToday: 0,
      sentIds: ["x"],
      messageIds: [],
    });
  });

  it("writes one letter at a time to the daemon's state", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "uno-mail-ledger-"));
    dirs.push(dir);
    const now = new Date("2026-10-22T08:00:00Z");
    await Promise.all(
      ["1", "2", "3"].map((id) =>
        recordMailSent(dir, "assistant-scout", { id, messageId: null }, now),
      ),
    );
    const ledger = await readMailLedger(dir, "assistant-scout");
    expect(ledger.sentToday).toBe(3);
    expect([...ledger.sentIds].toSorted()).toEqual(["1", "2", "3"]);
  });
});
