import { describe, expect, it } from "vitest";

import {
  describeEnvironmentAvailability,
  environmentAvailabilityLabel,
  environmentSyncSummary,
} from "./availability.ts";

describe("describeEnvironmentAvailability", () => {
  it("allows writes only against a confirmed live connection", () => {
    expect(describeEnvironmentAvailability("connected")).toEqual({
      status: "connected",
      canMutate: true,
      showsCachedData: false,
      canReconnect: false,
    });
  });

  it.each(["connecting", "reconnecting"] as const)(
    "treats %s as read-only cached data rather than live",
    (state) => {
      const availability = describeEnvironmentAvailability(state);
      expect(availability.status).toBe("reconnecting");
      expect(availability.canMutate).toBe(false);
      expect(availability.showsCachedData).toBe(true);
    },
  );

  it.each(["disconnected", "error"] as const)(
    "refuses writes and offers a reconnect when %s",
    (state) => {
      const availability = describeEnvironmentAvailability(state);
      expect(availability.status).toBe("offline");
      expect(availability.canMutate).toBe(false);
      expect(availability.canReconnect).toBe(true);
    },
  );
});

describe("environmentSyncSummary", () => {
  it("says data is cached, with its age, whenever the link is not live", () => {
    expect(environmentSyncSummary({ status: "reconnecting", elapsedLabel: "4m" })).toBe(
      "Cached from 4m ago",
    );
    expect(environmentSyncSummary({ status: "offline", elapsedLabel: "2h" })).toBe(
      "Cached from 2h ago",
    );
  });

  it("reports a live connection as synced", () => {
    expect(environmentSyncSummary({ status: "connected", elapsedLabel: "10s" })).toBe(
      "Synced 10s ago",
    );
  });

  it("is honest about never having synced", () => {
    expect(environmentSyncSummary({ status: "offline", elapsedLabel: null })).toBe("Never synced");
    expect(environmentSyncSummary({ status: "connected", elapsedLabel: null })).toBe("Syncing…");
  });
});

describe("environmentAvailabilityLabel", () => {
  it("names the three states the header shows", () => {
    expect(environmentAvailabilityLabel("connected")).toBe("Connected");
    expect(environmentAvailabilityLabel("reconnecting")).toBe("Reconnecting");
    expect(environmentAvailabilityLabel("offline")).toBe("Offline");
  });
});
