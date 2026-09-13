import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  describeBrowserForLink,
  requestLocalDaemonLink,
  OUTDATED_DAEMON_MESSAGE,
} from "./localDaemonLink";

const daemon = { httpBaseUrl: "http://127.0.0.1:3773/" };

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
    ...init,
  });
}

const createdBody = { requestId: "req-1", expiresAt: "2026-09-12T10:02:00.000Z" };

describe("requestLocalDaemonLink", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a request, polls until approved, and returns the credential once", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(createdBody))
      .mockResolvedValueOnce(jsonResponse({ ...createdBody, status: "pending" }))
      .mockResolvedValueOnce(
        jsonResponse({
          ...createdBody,
          status: "approved",
          pairing: { id: "link", credential: "one-time-secret", expiresAt: createdBody.expiresAt },
        }),
      );
    const onPending = vi.fn();

    const outcome = requestLocalDaemonLink({
      daemon,
      origin: "https://app.uno4.work",
      label: "Chrome on macOS",
      fetch: fetchMock,
      pollIntervalMs: 1_000,
      onPending,
    });
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(outcome).resolves.toEqual({ status: "approved", credential: "one-time-secret" });
    expect(onPending).toHaveBeenCalledWith({
      requestId: "req-1",
      expiresAt: createdBody.expiresAt,
    });

    const [createUrl, createInit] = fetchMock.mock.calls[0]!;
    expect(String(createUrl)).toBe("http://127.0.0.1:3773/api/auth/link-request");
    expect(createInit?.method).toBe("POST");
    expect(JSON.parse(String(createInit?.body))).toEqual({
      origin: "https://app.uno4.work",
      label: "Chrome on macOS",
    });
    expect(String(fetchMock.mock.calls[1]![0])).toBe(
      "http://127.0.0.1:3773/api/auth/link-request/req-1",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reports a denial from the computer", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(createdBody))
      .mockResolvedValueOnce(jsonResponse({ ...createdBody, status: "denied" }));

    const outcome = requestLocalDaemonLink({
      daemon,
      origin: "https://app.uno4.work",
      label: "Chrome",
      fetch: fetchMock,
      pollIntervalMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(outcome).resolves.toEqual({ status: "denied" });
  });

  it("times out when nobody answers on the computer", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(createdBody))
      .mockImplementation(async () => jsonResponse({ ...createdBody, status: "pending" }));

    const outcome = requestLocalDaemonLink({
      daemon,
      origin: "https://app.uno4.work",
      label: "Chrome",
      fetch: fetchMock,
      pollIntervalMs: 1_000,
      timeoutMs: 3_500,
    });
    await vi.advanceTimersByTimeAsync(4_000);

    await expect(outcome).resolves.toEqual({ status: "timeout" });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("explains an outdated daemon instead of quoting a 404 on the link request", async () => {
    // Pre-0.0.52 desktops answer a bare 404 with an empty body.
    const oldDaemonFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 404 }));
    const outcome = await requestLocalDaemonLink({
      daemon,
      origin: "https://app.uno4.work",
      label: "Chrome",
      fetch: oldDaemonFetch,
      pollIntervalMs: 1_000,
    });
    expect(outcome).toEqual({ status: "unavailable", message: OUTDATED_DAEMON_MESSAGE });
  });

  it("treats an expired or forgotten request as no answer", async () => {
    const expiredFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(createdBody))
      .mockResolvedValueOnce(jsonResponse({ ...createdBody, status: "expired" }));
    const expired = requestLocalDaemonLink({
      daemon,
      origin: "https://app.uno4.work",
      label: "Chrome",
      fetch: expiredFetch,
      pollIntervalMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(expired).resolves.toEqual({ status: "timeout" });

    const forgottenFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(createdBody))
      .mockResolvedValueOnce(jsonResponse({ error: "Unknown link request." }, { status: 404 }));
    const forgotten = requestLocalDaemonLink({
      daemon,
      origin: "https://app.uno4.work",
      label: "Chrome",
      fetch: forgottenFetch,
      pollIntervalMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(forgotten).resolves.toEqual({ status: "timeout" });
  });

  it("keeps polling through a missed poll", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(createdBody))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(
        jsonResponse({
          ...createdBody,
          status: "approved",
          pairing: { id: "link", credential: "secret", expiresAt: createdBody.expiresAt },
        }),
      );

    const outcome = requestLocalDaemonLink({
      daemon,
      origin: "https://app.uno4.work",
      label: "Chrome",
      fetch: fetchMock,
      pollIntervalMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(outcome).resolves.toEqual({ status: "approved", credential: "secret" });
  });

  it("surfaces a daemon that refuses to take requests", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: "This machine has no desktop app to approve the request." },
          { status: 404 },
        ),
      );

    await expect(
      requestLocalDaemonLink({
        daemon,
        origin: "https://app.uno4.work",
        label: "Chrome",
        fetch: fetchMock,
      }),
    ).resolves.toEqual({
      status: "unavailable",
      message: "This machine has no desktop app to approve the request.",
    });
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(createdBody))
      .mockImplementation(async () => jsonResponse({ ...createdBody, status: "pending" }));

    const outcome = requestLocalDaemonLink({
      daemon,
      origin: "https://app.uno4.work",
      label: "Chrome",
      fetch: fetchMock,
      pollIntervalMs: 1_000,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(outcome).resolves.toEqual({ status: "timeout" });
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe("describeBrowserForLink", () => {
  it("names common browsers and platforms", () => {
    expect(
      describeBrowserForLink(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      ),
    ).toBe("Chrome on macOS");
    expect(
      describeBrowserForLink(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0",
      ),
    ).toBe("Firefox on Windows");
    expect(describeBrowserForLink("")).toBe("Browser");
  });
});
