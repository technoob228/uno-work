import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type AppApiCaller,
  type AppApiCore,
  makeAppApiHandler,
  parseCalendarProvider,
} from "./appApiHttp.ts";
import { appCallsBridge, setAppCallsCore } from "./appCallsBridge.ts";

const caller = (appId: string, calls: boolean, calendar = false): AppApiCaller => ({
  appId,
  appName: appId,
  chat: false,
  tasks: false,
  limitUsd: 10,
  spentUsd: 0,
  tasksSpentUsd: 0,
  manifestCwd: null,
  taskToolsCap: "ask",
  storage: null,
  calls,
  calendar,
});

const TOKENS: Record<string, AppApiCaller> = {
  uno_app_nt: caller("notetaker", true),
  uno_app_plain: caller("plain", false),
  // A Notetaker whose manifest asks only for calendars (no assistant's calls).
  uno_app_cal: caller("notetaker", false, true),
};

const seen: Array<{ what: string; appId: string; arg: unknown }> = [];
let api: http.Server;
let url = "";

beforeAll(async () => {
  const core = {
    home: "/tmp",
    authenticate: async (token: string) => TOKENS[token] ?? null,
    calls: appCallsBridge,
  } as unknown as AppApiCore;
  api = http.createServer(makeAppApiHandler(core));
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(() => {
  setAppCallsCore(null);
  api.close();
});

const call = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(url + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

describe("App API: Join my calls", () => {
  it("is only for apps whose manifest asks for calls", async () => {
    const r = await call("uno_app_plain", "GET", "/v1/assistant/link");
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("calls_not_allowed");
  });

  it("says unavailable until the calls service is up", async () => {
    setAppCallsCore(null);
    const r = await call("uno_app_nt", "GET", "/v1/assistant/link");
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("calls_unavailable");
  });

  it("forwards the link, the calendar range and events", async () => {
    setAppCallsCore({
      link: async (c) => {
        seen.push({ what: "link", appId: c.appId, arg: null });
        return { status: 200, body: { enabled: true } };
      },
      calendars: async (c) => {
        seen.push({ what: "calendars", appId: c.appId, arg: null });
        return { status: 200, body: { calendars: [] } };
      },
      calendar: async (c, range) => {
        seen.push({ what: "calendar", appId: c.appId, arg: range });
        return { status: 200, body: { events: [] } };
      },
      event: async (c, body) => {
        seen.push({ what: "event", appId: c.appId, arg: body });
        return { status: 202, body: { ok: true } };
      },
    });
    expect((await call("uno_app_nt", "GET", "/v1/assistant/link")).body).toEqual({ enabled: true });
    expect(
      (await call("uno_app_nt", "GET", "/v1/calendar/events?from=2026-10-28T00:00:00Z")).body,
    ).toEqual({ events: [] });
    const posted = await call("uno_app_nt", "POST", "/v1/assistant/events", {
      id: "e1",
      kind: "calls.upcoming",
    });
    expect(posted.status).toBe(202);
    expect(seen).toEqual([
      { what: "link", appId: "notetaker", arg: null },
      {
        what: "calendar",
        appId: "notetaker",
        arg: { from: "2026-10-28T00:00:00Z", to: null, provider: "gmail" },
      },
      { what: "event", appId: "notetaker", arg: { id: "e1", kind: "calls.upcoming" } },
    ]);
    const bad = await call("uno_app_nt", "POST", "/v1/assistant/events", "{nope");
    expect(bad.status).toBe(400);
  });

  it("calendars: for calendar or calls manifests, either provider, no assistant needed", async () => {
    seen.length = 0;
    setAppCallsCore({
      link: async () => ({ status: 409, body: { error: { code: "calls_off" } } }),
      calendars: async (c) => {
        seen.push({ what: "calendars", appId: c.appId, arg: null });
        return { status: 200, body: { calendars: [] } };
      },
      calendar: async (c, range) => {
        seen.push({ what: "calendar", appId: c.appId, arg: range });
        return { status: 200, body: { events: [] } };
      },
      event: async () => ({ status: 202, body: { ok: true } }),
    });
    expect((await call("uno_app_cal", "GET", "/v1/calendars")).body).toEqual({ calendars: [] });
    expect((await call("uno_app_nt", "GET", "/v1/calendars")).status).toBe(200);
    const ms = await call(
      "uno_app_cal",
      "GET",
      "/v1/calendar/events?from=2026-10-29T00:00:00Z&to=2026-10-30T00:00:00Z&provider=microsoft",
    );
    expect(ms.status).toBe(200);
    expect(seen).toContainEqual({
      what: "calendar",
      appId: "notetaker",
      arg: { from: "2026-10-29T00:00:00Z", to: "2026-10-30T00:00:00Z", provider: "microsoft" },
    });
    const bad = await call("uno_app_cal", "GET", "/v1/calendar/events?provider=yandex");
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_request");

    const plain = await call("uno_app_plain", "GET", "/v1/calendars");
    expect(plain.status).toBe(403);
    expect(plain.body.error.code).toBe("calendar_not_allowed");
    // The assistant's own routes still want "calls".
    const link = await call("uno_app_cal", "GET", "/v1/assistant/link");
    expect(link.status).toBe(403);
    expect(link.body.error.code).toBe("calls_not_allowed");

    setAppCallsCore(null);
    const down = await call("uno_app_cal", "GET", "/v1/calendars");
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe("calendar_unavailable");
  });

  it("reads the provider: absent = gmail, case-insensitive, unknown refused", () => {
    expect(parseCalendarProvider(null)).toBe("gmail");
    expect(parseCalendarProvider("")).toBe("gmail");
    expect(parseCalendarProvider("Microsoft")).toBe("microsoft");
    expect(parseCalendarProvider("gmail")).toBe("gmail");
    expect(parseCalendarProvider("icloud")).toBeNull();
  });
});
