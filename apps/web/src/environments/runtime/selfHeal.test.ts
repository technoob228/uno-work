import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RemoteEnvironmentUnreachableError } from "../remote/api";
import {
  classifyPermanentFailure,
  configureSelfHeal,
  getSelfHealBackoffDelayMs,
  getSelfHealNeedsAttention,
  healSavedEnvironment,
  noteSavedEnvironmentFailure,
  noteSavedEnvironmentHealthy,
  resetSelfHeal,
  resetSelfHealForTests,
} from "./selfHeal";

const environmentId = EnvironmentId.make("env-broken");

const HOST_KEY_ERROR = new Error(
  "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.",
);
const DNS_ERROR = new Error(
  "ssh: Could not resolve hostname box-2298.example: nodename nor servname provided, or not known",
);
const WS_TOKEN_404 = new Error(
  "Error invoking remote method 'desktop:issue-ssh-ws-token': [ssh_http:404] Not Found (POST http://127.0.0.1:52011/api/auth/ws-token)",
);

function configure(overrides?: { online?: boolean }) {
  const performReconnect = vi.fn<(id: EnvironmentId) => Promise<void>>();
  const onNeedsAttention = vi.fn();
  configureSelfHeal({
    performReconnect,
    isAuthRequiredError: () => false,
    onAuthRequired: vi.fn(),
    onNeedsAttention,
    isDeviceOnline: () => overrides?.online ?? true,
  });
  return { performReconnect, onNeedsAttention };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
  resetSelfHealForTests();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  resetSelfHealForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("classifyPermanentFailure", () => {
  it("recognizes failures no retry can fix", () => {
    expect(classifyPermanentFailure(HOST_KEY_ERROR)?.kind).toBe("host-key-changed");
    expect(classifyPermanentFailure(DNS_ERROR)?.kind).toBe("address-not-found");
    expect(classifyPermanentFailure(WS_TOKEN_404)?.kind).toBe("endpoint-missing");
  });

  it("leaves slow and transient failures to the normal backoff", () => {
    expect(
      classifyPermanentFailure(
        new RemoteEnvironmentUnreachableError("No answer within 15 s.", {
          requestUrl: "https://box.example/api/auth/session",
          timedOut: true,
        }),
      ),
    ).toBeNull();
    expect(classifyPermanentFailure(new Error("[ssh_http:503] Service Unavailable"))).toBeNull();
    expect(
      classifyPermanentFailure(new Error("ssh: connect to host x port 22: Operation timed out")),
    ).toBeNull();
    expect(
      classifyPermanentFailure(new Error("No answer from http://127.0.0.1:1/ within 20 s.")),
    ).toBeNull();
  });
});

describe("needs attention", () => {
  it("stops automatic retries at the first changed host key until a manual reconnect", async () => {
    const { performReconnect, onNeedsAttention } = configure();
    performReconnect.mockRejectedValue(HOST_KEY_ERROR);

    await healSavedEnvironment(environmentId, "test");
    expect(performReconnect).toHaveBeenCalledTimes(1);
    expect(onNeedsAttention).toHaveBeenCalledWith(
      environmentId,
      expect.objectContaining({ kind: "host-key-changed" }),
    );
    expect(getSelfHealNeedsAttention(environmentId)?.message).toMatch(/security key has changed/);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await healSavedEnvironment(environmentId, "tunnel-up", { immediate: true });
    expect(performReconnect).toHaveBeenCalledTimes(1);

    resetSelfHeal(environmentId);
    expect(getSelfHealNeedsAttention(environmentId)).toBeNull();
    performReconnect.mockResolvedValue(undefined);
    await healSavedEnvironment(environmentId, "manual", { immediate: true });
    expect(performReconnect).toHaveBeenCalledTimes(2);
  });

  it("needs a long streak of address-not-found before giving up", () => {
    const { onNeedsAttention } = configure();

    for (let index = 0; index < 10; index += 1) {
      expect(noteSavedEnvironmentFailure(environmentId, DNS_ERROR)).toBe(false);
      vi.advanceTimersByTime(30_000);
    }
    // 10 failures but only ~5 minutes: a Wi-Fi outage, not a gone machine.
    expect(onNeedsAttention).not.toHaveBeenCalled();

    vi.advanceTimersByTime(6 * 60_000);
    expect(noteSavedEnvironmentFailure(environmentId, DNS_ERROR)).toBe(true);
    expect(onNeedsAttention).toHaveBeenCalledTimes(1);
  });

  it("does not count address lookups that fail while the device is offline", () => {
    const { onNeedsAttention } = configure({ online: false });
    for (let index = 0; index < 20; index += 1) {
      noteSavedEnvironmentFailure(environmentId, DNS_ERROR);
      vi.advanceTimersByTime(60_000);
    }
    expect(onNeedsAttention).not.toHaveBeenCalled();
  });

  it("forgets the streak once the environment connects", () => {
    const { onNeedsAttention } = configure();
    noteSavedEnvironmentFailure(environmentId, WS_TOKEN_404);
    noteSavedEnvironmentFailure(environmentId, WS_TOKEN_404);
    vi.advanceTimersByTime(3 * 60_000);
    noteSavedEnvironmentHealthy(environmentId);
    expect(noteSavedEnvironmentFailure(environmentId, WS_TOKEN_404)).toBe(false);
    vi.advanceTimersByTime(3 * 60_000);
    expect(noteSavedEnvironmentFailure(environmentId, WS_TOKEN_404)).toBe(false);
    expect(noteSavedEnvironmentFailure(environmentId, WS_TOKEN_404)).toBe(true);
    expect(onNeedsAttention).toHaveBeenCalledTimes(1);
  });
});

describe("getSelfHealBackoffDelayMs", () => {
  it("doubles from 1 s to a 64 s cap, jittered within the upper half of each step", () => {
    expect(getSelfHealBackoffDelayMs(1, 0)).toBe(500);
    expect(getSelfHealBackoffDelayMs(1, 0.999_999)).toBe(1_000);
    expect(getSelfHealBackoffDelayMs(2, 0)).toBe(1_000);
    expect(getSelfHealBackoffDelayMs(4, 0.5)).toBe(6_000);
    expect(getSelfHealBackoffDelayMs(7, 0)).toBe(32_000);
    expect(getSelfHealBackoffDelayMs(50, 1)).toBe(64_000);
  });

  it("spreads machines that failed together", () => {
    const delays = new Set(
      Array.from({ length: 20 }, (_, index) => getSelfHealBackoffDelayMs(5, index / 20)),
    );
    expect(delays.size).toBeGreaterThan(10);
  });
});
