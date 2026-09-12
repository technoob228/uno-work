import { describe, expect, it } from "vitest";

import { LinkRequestStore, type LinkRequestPairing } from "./linkRequests.ts";

function makeStore(options?: { readonly ttlMs?: number; readonly maxPending?: number }) {
  let now = 1_000_000;
  let counter = 0;
  const store = new LinkRequestStore({
    now: () => now,
    generateId: () => `req-${(counter += 1)}`,
    ...options,
  });
  return {
    store,
    advance(ms: number) {
      now += ms;
    },
  };
}

const pairing: LinkRequestPairing = {
  id: "link-1",
  credential: "secret",
  expiresAtMs: 1_000_000 + 120_000,
};

describe("LinkRequestStore", () => {
  it("creates a pending request that expires after the ttl", () => {
    const { store, advance } = makeStore({ ttlMs: 1_000 });
    const { record } = store.create({ origin: "https://app.uno4.work", label: "Chrome" });

    expect(record.status).toBe("pending");
    expect(record.expiresAtMs - record.createdAtMs).toBe(1_000);
    expect(store.poll(record.id)?.status).toBe("pending");

    advance(1_000);
    expect(store.poll(record.id)?.status).toBe("expired");
    expect(store.listPending()).toHaveLength(0);
  });

  it("hands the pairing credential out exactly once after approval", () => {
    const { store } = makeStore();
    const { record } = store.create({ origin: "https://app.uno4.work", label: "Chrome" });

    const approved = store.approve(record.id, pairing);
    expect(approved.ok).toBe(true);

    const first = store.poll(record.id);
    expect(first?.status).toBe("approved");
    expect(first?.pairing?.credential).toBe("secret");

    const second = store.poll(record.id);
    expect(second?.status).toBe("consumed");
    expect(second?.pairing).toBeNull();
  });

  it("denies a pending request and refuses further decisions", () => {
    const { store } = makeStore();
    const { record } = store.create({ origin: "https://app.uno4.work", label: "Chrome" });

    expect(store.deny(record.id).ok).toBe(true);
    expect(store.poll(record.id)?.status).toBe("denied");

    const late = store.approve(record.id, pairing);
    expect(late).toEqual({ ok: false, error: { kind: "not-pending", status: "denied" } });
  });

  it("does not let an expired request be approved", () => {
    const { store, advance } = makeStore({ ttlMs: 500 });
    const { record } = store.create({ origin: "https://app.uno4.work", label: "Chrome" });
    advance(500);

    expect(store.approve(record.id, pairing)).toEqual({
      ok: false,
      error: { kind: "not-pending", status: "expired" },
    });
    expect(store.approve("missing", pairing)).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect(store.deny("missing")).toEqual({ ok: false, error: { kind: "not-found" } });
  });

  it("expires an approval that was never polled once its pairing token lapses", () => {
    const { store, advance } = makeStore({ ttlMs: 120_000 });
    const { record } = store.create({ origin: "https://app.uno4.work", label: "Chrome" });
    store.approve(record.id, { ...pairing, expiresAtMs: 1_000_000 + 10_000 });
    advance(10_000);

    expect(store.poll(record.id)?.status).toBe("expired");
    expect(store.poll(record.id)?.pairing).toBeNull();
  });

  it("supersedes an earlier pending request from the same origin", () => {
    const { store } = makeStore();
    const first = store.create({ origin: "https://app.uno4.work", label: "Chrome" });
    const second = store.create({ origin: "https://app.uno4.work", label: "Chrome again" });

    expect(second.expired.map((record) => record.id)).toEqual([first.record.id]);
    expect(store.poll(first.record.id)?.status).toBe("expired");
    expect(store.listPending().map((record) => record.id)).toEqual([second.record.id]);
  });

  it("caps live requests by expiring the oldest pending one", () => {
    const { store } = makeStore({ maxPending: 2 });
    const a = store.create({ origin: "https://a.example", label: "A" });
    const b = store.create({ origin: "https://b.example", label: "B" });
    const c = store.create({ origin: "https://c.example", label: "C" });

    expect(c.expired.map((record) => record.id)).toEqual([a.record.id]);
    expect(store.listPending().map((record) => record.id)).toEqual([b.record.id, c.record.id]);
  });

  it("forgets terminal records one ttl after they ended", () => {
    const { store, advance } = makeStore({ ttlMs: 1_000 });
    const { record } = store.create({ origin: "https://app.uno4.work", label: "Chrome" });
    store.deny(record.id);

    advance(1_000);
    expect(store.get(record.id)?.status).toBe("denied");

    advance(1_001);
    store.sweep();
    expect(store.get(record.id)).toBeNull();
  });
});
