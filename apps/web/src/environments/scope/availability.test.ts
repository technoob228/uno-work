import { describe, expect, it } from "vitest";

import {
  describeEnvironmentAvailability,
  environmentAvailabilityLabel,
  environmentMutationBlockMessage,
  environmentSyncSummary,
} from "./availability.ts";

describe("describeEnvironmentAvailability", () => {
  it("allows writes only against a confirmed live connection", () => {
    expect(describeEnvironmentAvailability("connected")).toEqual({
      status: "connected",
      canMutate: true,
      showsCachedData: false,
      canReconnect: false,
      mutationBlock: null,
    });
  });

  it("refuses writes over a client-only session even while connected", () => {
    const availability = describeEnvironmentAvailability("connected", { sessionRole: "client" });

    expect(availability.status).toBe("connected");
    expect(availability.canMutate).toBe(false);
    expect(availability.mutationBlock).toBe("client-session");
    // Re-pairing is what actually fixes it, so the affordance has to be there.
    expect(availability.canReconnect).toBe(true);
  });

  it("keeps writes open for an owner session", () => {
    expect(describeEnvironmentAvailability("connected", { sessionRole: "owner" }).canMutate).toBe(
      true,
    );
  });

  it("reports the connection problem first when the link is also down", () => {
    const availability = describeEnvironmentAvailability("disconnected", { sessionRole: "client" });

    expect(availability.mutationBlock).toBe("not-connected");
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

describe("environmentMutationBlockMessage", () => {
  it("explains a view-only session instead of leaving a 403 to surface later", () => {
    expect(environmentMutationBlockMessage("client-session")).toContain("view-only session");
    expect(environmentMutationBlockMessage("not-connected")).toContain("Reconnect");
  });
});

describe("environmentAvailabilityLabel", () => {
  it("names the three states the header shows", () => {
    expect(environmentAvailabilityLabel("connected")).toBe("Connected");
    expect(environmentAvailabilityLabel("reconnecting")).toBe("Reconnecting");
    expect(environmentAvailabilityLabel("offline")).toBe("Offline");
  });
});
