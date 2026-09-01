/**
 * Two daemons, one app: proves that naming an environment is enough to keep
 * every manager read and write on that machine — the failure this API was
 * reshaped to prevent was a Telegram token saved to the local daemon while
 * the user was looking at a remote one.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PRIMARY_ID = "primary-env" as EnvironmentId;
const REMOTE_ID = "remote-env" as EnvironmentId;

const PRIMARY_ORIGIN = "http://127.0.0.1:13773";
const REMOTE_ORIGIN = "https://hostkey.example:3773";

const readSavedEnvironmentBearerToken = vi.fn<(id: EnvironmentId) => Promise<string | null>>();

vi.mock("~/environments/primary", () => ({
  getPrimaryKnownEnvironment: () => ({ environmentId: PRIMARY_ID }),
}));
vi.mock("~/environments/primary/target", () => ({
  resolvePrimaryEnvironmentHttpUrl: (pathname: string, searchParams?: Record<string, string>) => {
    const url = new URL(PRIMARY_ORIGIN);
    url.pathname = pathname;
    if (searchParams) url.search = new URLSearchParams(searchParams).toString();
    return url.toString();
  },
}));
vi.mock("~/environments/runtime/catalog", () => ({
  getSavedEnvironmentRecord: (id: EnvironmentId) =>
    id === REMOTE_ID ? { label: "Hostkey", httpBaseUrl: `${REMOTE_ORIGIN}/` } : null,
  readSavedEnvironmentBearerToken: (id: EnvironmentId) => readSavedEnvironmentBearerToken(id),
}));

const {
  getAssistant,
  isEnvironmentUnavailableError,
  isManagerApiError,
  saveAssistantSlack,
  saveAssistantTelegram,
} = await import("./managerApi.ts");

interface RecordedCall {
  readonly origin: string;
  readonly pathname: string;
  readonly method: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

describe("managerApi against two daemons", () => {
  let calls: Array<RecordedCall>;
  let respond: (url: URL) => Response;

  beforeEach(() => {
    calls = [];
    readSavedEnvironmentBearerToken.mockResolvedValue("remote-session-token");
    respond = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init: RequestInit) => {
        const url = new URL(input);
        const headers = (init.headers ?? {}) as Record<string, string>;
        calls.push({
          origin: url.origin,
          pathname: url.pathname,
          method: init.method ?? "GET",
          authorization: headers.authorization,
          body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
        });
        return Promise.resolve(respond(url));
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("reads a remote assistant only from the remote daemon", async () => {
    respond = () => new Response(JSON.stringify({ title: "Assistant" }), { status: 200 });

    await getAssistant({ environmentId: REMOTE_ID, projectId: "assistant-home" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.origin).toBe(REMOTE_ORIGIN);
    expect(calls.some((call) => call.origin === PRIMARY_ORIGIN)).toBe(false);
  });

  it("sends a Telegram save to the remote daemon and nothing to primary", async () => {
    await saveAssistantTelegram({
      environmentId: REMOTE_ID,
      projectId: "assistant-home",
      botToken: "12345:secret-bot-token",
      allowedChatIds: ["-100123"],
      enabled: true,
    });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.origin).toBe(REMOTE_ORIGIN);
    expect(call?.pathname).toBe("/api/manager/assistant/telegram");
    expect(call?.authorization).toBe("Bearer remote-session-token");
    expect(call?.body).toMatchObject({ projectId: "assistant-home", enabled: true });
    // The routing key is not smuggled into the payload the daemon stores.
    expect(call?.body).not.toHaveProperty("environmentId");
  });

  it("keeps a primary save on primary, with cookies instead of a bearer", async () => {
    await saveAssistantSlack({
      environmentId: PRIMARY_ID,
      projectId: "assistant-home",
      allowedChannelIds: ["C123"],
      enabled: true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.origin).toBe(PRIMARY_ORIGIN);
    expect(calls[0]?.authorization).toBeUndefined();
  });

  it("never retries a remote 401 against primary", async () => {
    respond = () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });

    const error = await saveAssistantTelegram({
      environmentId: REMOTE_ID,
      projectId: "assistant-home",
      allowedChatIds: [],
      enabled: false,
    }).catch((cause: unknown) => cause);

    expect(isManagerApiError(error)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.origin).toBe(REMOTE_ORIGIN);
  });

  it("refuses to write at all when the remote session is gone", async () => {
    readSavedEnvironmentBearerToken.mockResolvedValue(null);

    const error = await saveAssistantTelegram({
      environmentId: REMOTE_ID,
      projectId: "assistant-home",
      botToken: "12345:secret-bot-token",
      allowedChatIds: [],
      enabled: true,
    }).catch((cause: unknown) => cause);

    expect(isEnvironmentUnavailableError(error)).toBe(true);
    // Not "sent somewhere else" — not sent at all.
    expect(calls).toHaveLength(0);
  });
});
