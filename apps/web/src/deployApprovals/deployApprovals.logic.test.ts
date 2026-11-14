import { describe, expect, it } from "vitest";

import {
  conflictMessage,
  deployCardView,
  minutesLeft,
  newlyWaiting,
  openUnavailableHint,
  parseDeployApprovals,
  safeApproveUrl,
  visibleRequests,
  waitingCount,
} from "./deployApprovals.logic";

const NOW = Date.parse("2026-11-13T12:00:00Z");

function raw(requests: unknown[], extra: Record<string, unknown> = {}) {
  return { approver: true, frozen: false, web: true, passkeys: 1, requests, ...extra };
}

const waiting = {
  id: 7,
  machine: "box-395",
  summary: "выкатить fishcode 1.42",
  minutes: 20,
  status: "requested",
  created_at: "2026-11-13T11:58:00Z",
  via: "",
  status_line: "⏳ ждёт решения",
  approve_url: "https://gate.uno4.work/r/7",
};
const open = {
  id: 6,
  machine: "box-395",
  summary: "миграция",
  minutes: 15,
  status: "approved",
  decided_by: "Миша",
  expires_at: "2026-11-13T12:09:30Z",
  status_line: "✅ открыто",
};
const denied = {
  id: 5,
  machine: "box-395",
  summary: "x",
  minutes: 10,
  status: "denied",
  status_line: "❌ Отказано · в Uno Work",
};

describe("parseDeployApprovals", () => {
  it("is nothing for a non-approver or garbage", () => {
    expect(parseDeployApprovals({ approver: false, requests: [waiting] }).requests).toEqual([]);
    expect(parseDeployApprovals(null).approver).toBe(false);
    expect(parseDeployApprovals("<html>").approver).toBe(false);
  });

  it("keeps valid requests newest first and drops broken ones", () => {
    const gate = parseDeployApprovals(
      raw([denied, waiting, { id: "8", status: "requested" }, { id: 9, status: "weird" }, open]),
    );
    expect(gate.requests.map((q) => q.id)).toEqual([7, 6, 5]);
    expect(gate.requests[0]!.approveUrl).toBe("https://gate.uno4.work/r/7");
  });

  it("drops an approve address that isn't the gate page over https", () => {
    expect(safeApproveUrl("https://gate.uno4.work/r/7")).toBe("https://gate.uno4.work/r/7");
    expect(safeApproveUrl("http://gate.uno4.work/r/7")).toBeNull();
    expect(safeApproveUrl("javascript:alert(1)")).toBeNull();
    expect(safeApproveUrl("https://gate.uno4.work/api/decide")).toBeNull();
    expect(safeApproveUrl("https://u:p@gate.uno4.work/r/7")).toBeNull();
    // Only a waiting request carries one.
    const gate = parseDeployApprovals(
      raw([{ ...open, approve_url: "https://gate.uno4.work/r/6" }]),
    );
    expect(gate.requests[0]!.approveUrl).toBeNull();
  });
});

describe("deployCardView", () => {
  const gate = parseDeployApprovals(raw([waiting, open, denied]));
  const [w, o, d] = gate.requests;

  it("a waiting request: what, who, how long — Open (Touch ID page) and Deny", () => {
    const view = deployCardView(w!, NOW, gate);
    expect(view.tone).toBe("waiting");
    expect(view.title).toBe("box-395 просит окно в прод");
    expect(view.summary).toBe("выкатить fishcode 1.42");
    expect(view.openLabel).toBe("Открыть на 20 мин");
    expect(view.actions).toEqual(["open", "deny"]);
  });

  it("no Open without the gate page, a passkey, or while frozen", () => {
    for (const extra of [{ web: false }, { passkeys: 0 }, { frozen: true }]) {
      const g = parseDeployApprovals(raw([waiting], extra));
      expect(deployCardView(g.requests[0]!, NOW, g).actions).toEqual(["deny"]);
      expect(openUnavailableHint(g)).not.toBeNull();
    }
    expect(openUnavailableHint(gate)).toBeNull();
  });

  it("an open window: minutes left and Close now", () => {
    const view = deployCardView(o!, NOW, gate);
    expect(view.tone).toBe("open");
    expect(view.meta).toContain("осталось 10 мин");
    expect(view.meta).toContain("Миша");
    expect(view.actions).toEqual(["close"]);
    // Past its end it is just history.
    expect(deployCardView(o!, Date.parse("2026-11-13T12:10:00Z"), gate).actions).toEqual([]);
  });

  it("a decided one shows the console's line, nothing to press", () => {
    const view = deployCardView(d!, NOW, gate);
    expect(view.tone).toBe("done");
    expect(view.meta).toBe("❌ Отказано · в Uno Work");
    expect(view.actions).toEqual([]);
  });
});

describe("lists and counts", () => {
  it("live first, then a few decided; Needs you — live only", () => {
    const gate = parseDeployApprovals(
      raw([
        waiting,
        open,
        denied,
        { ...denied, id: 4 },
        { ...denied, id: 3 },
        { ...denied, id: 2 },
      ]),
    );
    expect(visibleRequests(gate, NOW).map((q) => q.id)).toEqual([7, 6, 5, 4, 3]);
    expect(visibleRequests(gate, NOW, 0).map((q) => q.id)).toEqual([7, 6]);
    expect(waitingCount(gate)).toBe(1);
    expect(waitingCount(null)).toBe(0);
  });

  it("notifies only requests that started waiting since the last answer", () => {
    const before = parseDeployApprovals(raw([open]));
    const after = parseDeployApprovals(raw([waiting, open]));
    expect(newlyWaiting(before, after).map((q) => q.id)).toEqual([7]);
    expect(newlyWaiting(after, after)).toEqual([]);
    // The first answer after start: nothing pops up (Telegram already told).
    expect(newlyWaiting(null, after)).toEqual([]);
  });

  it("minutes left round up and never go negative", () => {
    expect(minutesLeft("2026-11-13T12:00:01Z", NOW)).toBe(1);
    expect(minutesLeft("2026-11-13T11:00:00Z", NOW)).toBe(0);
    expect(minutesLeft(null, NOW)).toBe(0);
  });

  it("a 409 carries the console's reason", () => {
    expect(conflictMessage({ ok: false, message: "Уже решено" })).toBe("Уже решено");
    expect(conflictMessage("nope")).toBeNull();
  });
});
