import { describe, expect, it } from "vitest";

import {
  CONNECTED,
  CONNECTION_ATTENTION_MS,
  CONNECTION_GRACE_MS,
  CONNECTION_OFFLINE_MS,
  type ConnectionFacts,
  agoLabel,
  describeConnection,
} from "./connectionStatus";

const NOW = Date.parse("2026-10-05T12:00:00Z");

function facts(overrides: Partial<ConnectionFacts> = {}): ConnectionFacts {
  return {
    link: "down",
    downSince: NOW,
    networkOnline: true,
    economy: null,
    signInNeeded: false,
    now: NOW,
    ...overrides,
  };
}

const downFor = (ms: number) => facts({ downSince: NOW - ms });

describe("describeConnection — said quietly in the computer chip", () => {
  it("says nothing in the chip while connected", () => {
    expect(describeConnection(facts({ link: "connected", downSince: null }))).toEqual(CONNECTED);
    expect(CONNECTED.chip).toBeNull();
    expect(CONNECTED.line).toBe("Connected");
  });

  it("a short drop is not news: the chip stays quiet, the menu tells the truth", () => {
    const status = describeConnection(downFor(CONNECTION_GRACE_MS - 1));
    expect(status.chip).toBeNull();
    expect(status.line).toBe("Reconnecting…");
    expect(status.attention).toBe(false);
  });

  it("an unknown outage start counts as a fresh drop", () => {
    expect(describeConnection(facts({ downSince: null })).chip).toBeNull();
  });

  it("then Reconnecting…, then Offline — retrying with the last sync, both quiet", () => {
    const reconnecting = describeConnection(downFor(CONNECTION_GRACE_MS));
    expect(reconnecting).toMatchObject({
      kind: "reconnecting",
      chip: "Reconnecting…",
      line: "Reconnecting…",
      attention: false,
      action: null,
    });

    const offline = describeConnection(downFor(CONNECTION_OFFLINE_MS + 5_000));
    expect(offline).toMatchObject({
      kind: "offline",
      chip: "Offline — retrying",
      line: "Offline — retrying · synced 1 min ago",
      attention: false,
      action: "retry",
    });
  });

  it("asks for the person only after a long outage: No connection → Retry", () => {
    const lost = describeConnection(downFor(CONNECTION_ATTENTION_MS + 60_000));
    expect(lost).toMatchObject({
      kind: "lost",
      chip: "No connection",
      line: "Can't reach this computer · synced 4 min ago",
      attention: true,
      action: "retry",
    });
  });

  it("no network on the device: Offline, waiting — never an alarm", () => {
    expect(
      describeConnection({ ...downFor(CONNECTION_ATTENTION_MS * 2), networkOnline: false }),
    ).toMatchObject({
      kind: "no-network",
      chip: "Offline",
      line: "Offline — waiting for network · synced 6 min ago",
      attention: false,
    });
    expect(describeConnection({ ...downFor(1_000), networkOnline: false }).chip).toBeNull();
  });

  it("an economy computer resting while you're away is Asleep, with Wake up in the menu", () => {
    expect(describeConnection(facts({ economy: "sleeping" }))).toMatchObject({
      kind: "asleep",
      chip: "Asleep",
      attention: false,
      action: "wake",
    });
    expect(describeConnection(facts({ economy: "waking" }))).toMatchObject({
      kind: "waking",
      chip: "Waking…",
      action: null,
    });
    // Asleep wins over a connection that is still technically open.
    expect(describeConnection(facts({ link: "connected", economy: "sleeping" })).kind).toBe(
      "asleep",
    );
  });

  it("a session that needs signing in again needs the person at once", () => {
    expect(describeConnection(facts({ link: "connected", signInNeeded: true }))).toMatchObject({
      kind: "sign-in",
      chip: "Sign in",
      attention: true,
      action: "sign-in",
    });
  });

  it("the first connection: quiet, then Connecting…, then No connection", () => {
    expect(describeConnection({ ...downFor(1_000), link: "first" }).chip).toBeNull();
    expect(describeConnection({ ...downFor(CONNECTION_GRACE_MS), link: "first" }).chip).toBe(
      "Connecting…",
    );
    expect(describeConnection({ ...downFor(CONNECTION_ATTENTION_MS), link: "first" }).kind).toBe(
      "lost",
    );
  });
});

describe("agoLabel", () => {
  it("reads like a person", () => {
    expect(agoLabel(NOW - 3_000, NOW)).toBe("just now");
    expect(agoLabel(NOW - 40_000, NOW)).toBe("40s ago");
    expect(agoLabel(NOW - 61_000, NOW)).toBe("1 min ago");
    expect(agoLabel(NOW - 2 * 3_600_000, NOW)).toBe("2 h ago");
    expect(agoLabel(NOW - 3 * 86_400_000, NOW)).toBe("3 d ago");
  });
});
