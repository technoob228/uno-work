import { describe, expect, it } from "vitest";

import {
  PORT_SESSION_REUSE_MS,
  forgetPortSession,
  isPortReenterMessage,
  readPortSession,
  rememberPortSession,
} from "./portPreview";

function memoryStore() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const ORIGIN = "https://p8471--3csvnrcm77.uno4.work";

describe("port sessions (no new link — and no Security line — on every Home visit)", () => {
  it("reuses the port's session for the same computer while the cookie lives", () => {
    const store = memoryStore();
    rememberPortSession(store, { port: 8471, boxId: 42, origin: ORIGIN, now: 1_000 });
    expect(readPortSession(store, { port: 8471, boxId: 42, now: 2_000 })?.origin).toBe(ORIGIN);
    expect(
      readPortSession(store, { port: 8471, boxId: 42, now: 1_000 + PORT_SESSION_REUSE_MS }),
    ).toBeNull();
  });

  it("another computer on the same port mints its own link (the cookie names one computer)", () => {
    const store = memoryStore();
    rememberPortSession(store, { port: 8471, boxId: 42, origin: ORIGIN, now: 1_000 });
    expect(readPortSession(store, { port: 8471, boxId: 7, now: 2_000 })).toBeNull();
    expect(readPortSession(store, { port: 5173, boxId: 42, now: 2_000 })).toBeNull();
  });

  it("forgets a port whose frame came back with 'Open this page from Uno Work'", () => {
    const store = memoryStore();
    rememberPortSession(store, { port: 8471, boxId: 42, origin: ORIGIN, now: 1_000 });
    forgetPortSession(store, 8471);
    expect(readPortSession(store, { port: 8471, boxId: 42, now: 2_000 })).toBeNull();
    expect(isPortReenterMessage({ __unoPortPreview: "uno-port-preview:reenter" })).toBe(true);
    expect(isPortReenterMessage({ __unoPageTools: true })).toBe(false);
  });

  it("survives junk in storage", () => {
    const store = memoryStore();
    store.setItem("uno-work:port-sessions:v1", "{not json");
    expect(readPortSession(store, { port: 8471, boxId: 42, now: 1 })).toBeNull();
    rememberPortSession(store, { port: 8471, boxId: 42, origin: ORIGIN, now: 1 });
    expect(readPortSession(store, { port: 8471, boxId: 42, now: 2 })?.origin).toBe(ORIGIN);
  });
});
