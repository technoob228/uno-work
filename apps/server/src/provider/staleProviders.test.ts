import { ProviderInstanceId } from "@t3tools/contracts";
import { Duration } from "effect";
import { describe, expect, it } from "vitest";

import { SNAPSHOT_REFRESH_INTERVAL as OPENCODE_SNAPSHOT_REFRESH_INTERVAL } from "./Drivers/OpenCodeDriver.ts";
import { SNAPSHOT_REFRESH_INTERVAL as UNO_SNAPSHOT_REFRESH_INTERVAL } from "./Drivers/UnoDriver.ts";

import { PROVIDER_CONNECT_REFRESH_MAX_AGE_MS, staleProviderInstanceIds } from "./staleProviders.ts";

const at = (iso: string) => Date.parse(iso);
const p = (id: string, checkedAt: string) =>
  ({ instanceId: ProviderInstanceId.make(id), checkedAt }) as const;

describe("staleProviderInstanceIds", () => {
  const now = at("2026-09-23T15:00:00.000Z");

  it("a client opening the page after a recent periodic probe starts nothing", () => {
    expect(
      staleProviderInstanceIds(
        [
          p("claude", "2026-09-23T14:57:00.000Z"),
          p("opencode", "2026-09-23T14:31:10.000Z"),
          p("uno", "2026-09-23T14:59:59.000Z"),
        ],
        now,
      ),
    ).toEqual([]);
  });

  it("re-probes only the instances the timer has clearly missed", () => {
    expect(
      staleProviderInstanceIds(
        [
          p("claude", "2026-09-23T14:57:00.000Z"),
          p("hermes", "2026-09-23T14:10:00.000Z"),
          p("broken", "not a date"),
        ],
        now,
      ),
    ).toEqual(["hermes", "broken"]);
  });

  it("the default age outlasts the longest periodic cycle plus a slow probe", () => {
    expect(PROVIDER_CONNECT_REFRESH_MAX_AGE_MS).toBeGreaterThan(
      Math.max(
        Duration.toMillis(UNO_SNAPSHOT_REFRESH_INTERVAL),
        Duration.toMillis(OPENCODE_SNAPSHOT_REFRESH_INTERVAL),
      ) + 30_000,
    );
  });
});
