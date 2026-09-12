import { afterEach, describe, expect, it, vi } from "vitest";

import {
  discoverLocalDaemon,
  localDaemonHttpBaseUrl,
  parseLocalDaemonDescriptor,
} from "./localDaemonDiscovery";

const descriptorBody = {
  environmentId: "env-mac",
  label: "Mikhail's MacBook",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.51",
  capabilities: { repositoryIdentity: true },
};

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
    ...init,
  });
}

describe("parseLocalDaemonDescriptor", () => {
  it("accepts a real daemon descriptor and records where it came from", () => {
    expect(parseLocalDaemonDescriptor(descriptorBody, "http://127.0.0.1:3773/")).toEqual({
      environmentId: "env-mac",
      label: "Mikhail's MacBook",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.51",
      httpBaseUrl: "http://127.0.0.1:3773/",
    });
  });

  it("rejects anything that is not a daemon descriptor", () => {
    expect(parseLocalDaemonDescriptor(null, "http://127.0.0.1:3773/")).toBeNull();
    expect(parseLocalDaemonDescriptor("<html>", "http://127.0.0.1:3773/")).toBeNull();
    expect(
      parseLocalDaemonDescriptor({ ...descriptorBody, environmentId: " " }, "http://x/"),
    ).toBeNull();
    expect(parseLocalDaemonDescriptor({ ...descriptorBody, platform: {} }, "http://x/")).toBeNull();
  });
});

describe("discoverLocalDaemon", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the descriptor from the well-known port", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(descriptorBody));

    const result = await discoverLocalDaemon({ fetch: fetchMock, enabled: true, ports: [3773] });

    expect(result?.environmentId).toBe("env-mac");
    expect(result?.httpBaseUrl).toBe(localDaemonHttpBaseUrl(3773));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:3773/.well-known/t3/environment");
    expect((init as Record<string, unknown>)["targetAddressSpace"]).toBe("loopback");
  });

  it("returns null when nothing answers", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(
      discoverLocalDaemon({ fetch: fetchMock, enabled: true, ports: [3773] }),
    ).resolves.toBeNull();
  });

  it("returns null for a non-daemon answer on the port", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("<html>hi</html>", { status: 200 }));

    await expect(
      discoverLocalDaemon({ fetch: fetchMock, enabled: true, ports: [3773] }),
    ).resolves.toBeNull();
  });

  it("gives up after the probe timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );

    const pending = discoverLocalDaemon({
      fetch: fetchMock,
      enabled: true,
      ports: [3773],
      timeoutMs: 1_500,
    });
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(pending).resolves.toBeNull();
  });

  it("tries the next port when the first is silent", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("refused"))
      .mockResolvedValueOnce(jsonResponse(descriptorBody));

    const result = await discoverLocalDaemon({
      fetch: fetchMock,
      enabled: true,
      ports: [3773, 13773],
    });

    expect(result?.httpBaseUrl).toBe("http://127.0.0.1:13773/");
  });

  it("never probes when disabled (desktop build)", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    await expect(discoverLocalDaemon({ fetch: fetchMock, enabled: false })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
