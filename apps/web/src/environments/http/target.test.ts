import type { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PRIMARY_ID = "primary-env" as EnvironmentId;
const SAVED_ID = "saved-env" as EnvironmentId;

const getPrimaryKnownEnvironment = vi.fn<() => { environmentId: EnvironmentId } | null>();
const resolvePrimaryEnvironmentHttpUrl =
  vi.fn<(pathname: string, searchParams?: Record<string, string>) => string>();
const getSavedEnvironmentRecord =
  vi.fn<(id: EnvironmentId) => { label: string; httpBaseUrl: string } | null>();
const readSavedEnvironmentBearerToken = vi.fn<(id: EnvironmentId) => Promise<string | null>>();

vi.mock("../primary", () => ({
  getPrimaryKnownEnvironment: () => getPrimaryKnownEnvironment(),
}));
vi.mock("../primary/target", () => ({
  resolvePrimaryEnvironmentHttpUrl: (pathname: string, searchParams?: Record<string, string>) =>
    resolvePrimaryEnvironmentHttpUrl(pathname, searchParams),
}));
vi.mock("../runtime/catalog", () => ({
  getSavedEnvironmentRecord: (id: EnvironmentId) => getSavedEnvironmentRecord(id),
  readSavedEnvironmentBearerToken: (id: EnvironmentId) => readSavedEnvironmentBearerToken(id),
}));

const {
  environmentFetchJson,
  isEnvironmentHttpError,
  isEnvironmentUnavailableError,
  resolveEnvironmentHttpTarget,
} = await import("./target.ts");

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("resolveEnvironmentHttpTarget", () => {
  beforeEach(() => {
    getPrimaryKnownEnvironment.mockReturnValue({ environmentId: PRIMARY_ID });
    getSavedEnvironmentRecord.mockReturnValue({
      label: "Hostkey",
      httpBaseUrl: "https://hostkey.example:3773/",
    });
    readSavedEnvironmentBearerToken.mockResolvedValue("secret-bearer");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("resolves the renderer's own environment to a primary target", async () => {
    await expect(resolveEnvironmentHttpTarget(PRIMARY_ID)).resolves.toEqual({ kind: "primary" });
  });

  it("resolves a saved environment to its own base url and bearer session", async () => {
    await expect(resolveEnvironmentHttpTarget(SAVED_ID)).resolves.toEqual({
      kind: "saved",
      environmentId: SAVED_ID,
      httpBaseUrl: "https://hostkey.example:3773/",
      bearerToken: "secret-bearer",
    });
  });

  it("refuses an environment this device has never saved", async () => {
    getSavedEnvironmentRecord.mockReturnValue(null);

    await expect(resolveEnvironmentHttpTarget(SAVED_ID)).rejects.toSatisfy(
      isEnvironmentUnavailableError,
    );
  });

  it("refuses a saved environment whose session is gone, instead of using primary", async () => {
    readSavedEnvironmentBearerToken.mockResolvedValue(null);

    const error = await resolveEnvironmentHttpTarget(SAVED_ID).catch((cause: unknown) => cause);

    expect(isEnvironmentUnavailableError(error)).toBe(true);
    expect((error as Error).message).toContain("Reconnect Hostkey");
  });
});

describe("environmentFetchJson", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getPrimaryKnownEnvironment.mockReturnValue({ environmentId: PRIMARY_ID });
    getSavedEnvironmentRecord.mockReturnValue({
      label: "Hostkey",
      httpBaseUrl: "https://hostkey.example:3773/",
    });
    readSavedEnvironmentBearerToken.mockResolvedValue("secret-bearer");
    resolvePrimaryEnvironmentHttpUrl.mockImplementation((pathname, searchParams) => {
      const url = new URL("http://127.0.0.1:13773/");
      url.pathname = pathname;
      if (searchParams) url.search = new URLSearchParams(searchParams).toString();
      return url.toString();
    });
    fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("sends the primary request with cookies and no bearer header", async () => {
    await environmentFetchJson({
      environmentId: PRIMARY_ID,
      pathname: "/api/manager/assistant",
      searchParams: { projectId: "assistant-home" },
    });

    const [requestUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(requestUrl).toBe(
      "http://127.0.0.1:13773/api/manager/assistant?projectId=assistant-home",
    );
    expect(init.credentials).toBe("include");
    expect(init.headers).not.toHaveProperty("authorization");
  });

  it("sends a saved-environment request to an absolute url with a bearer header", async () => {
    await environmentFetchJson({
      environmentId: SAVED_ID,
      pathname: "/api/manager/assistant/slack",
      method: "POST",
      body: { projectId: "assistant-home", enabled: true },
    });

    const [requestUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(requestUrl).toBe("https://hostkey.example:3773/api/manager/assistant/slack");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-bearer");
    expect(init.credentials).toBe("omit");
    expect(init.method).toBe("POST");
  });

  it("never puts the bearer token in the request url", async () => {
    await environmentFetchJson({
      environmentId: SAVED_ID,
      pathname: "/api/manager/assistant",
      searchParams: { projectId: "assistant-home" },
    });

    const [requestUrl] = fetchMock.mock.calls[0] as [string];
    expect(requestUrl).not.toContain("secret-bearer");
  });

  it("surfaces a remote 401 as an error and never retries against primary", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "Unauthorized" }, 401));

    const error = await environmentFetchJson({
      environmentId: SAVED_ID,
      pathname: "/api/manager/assistant",
    }).catch((cause: unknown) => cause);

    expect(isEnvironmentHttpError(error)).toBe(true);
    expect((error as { status: number }).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolvePrimaryEnvironmentHttpUrl).not.toHaveBeenCalled();
  });

  it("reports an unreachable environment without falling back", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const error = await environmentFetchJson({
      environmentId: SAVED_ID,
      pathname: "/api/manager/assistant",
    }).catch((cause: unknown) => cause);

    expect(isEnvironmentUnavailableError(error)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolvePrimaryEnvironmentHttpUrl).not.toHaveBeenCalled();
  });

  it("does not leak the bearer token into the error message", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "Unauthorized" }, 401));

    const error = await environmentFetchJson({
      environmentId: SAVED_ID,
      pathname: "/api/manager/assistant",
    }).catch((cause: unknown) => cause);

    expect(String(error)).not.toContain("secret-bearer");
  });
});
