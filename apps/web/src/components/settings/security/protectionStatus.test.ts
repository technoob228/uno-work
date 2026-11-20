import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountHttpError, accountRequest } from "../../../account/unoAccount";
import { protectionNotEnabled, protectionStatus, securityRowDescription } from "./protectionStatus";

const failed = (error: unknown) => ({ isSuccess: false, isError: true, error });

describe("protectionStatus", () => {
  it("404 from the server = not on for this account yet", () => {
    const notOn = new AccountHttpError(404, '404: {"error":"NOT_ENABLED"}', {
      error: "NOT_ENABLED",
    });
    expect(protectionNotEnabled(notOn)).toBe(true);
    expect(protectionStatus(failed(notOn))).toBe("not-on");
  });

  it("other refusals are errors, not 'not on'", () => {
    expect(protectionStatus(failed(new AccountHttpError(500, "HTTP 500", null)))).toBe("error");
    expect(protectionStatus(failed(new AccountHttpError(403, "HTTP 403", null)))).toBe("error");
    expect(protectionStatus(failed(new Error("offline")))).toBe("error");
  });

  it("an answer = on; nothing yet = loading", () => {
    expect(protectionStatus({ isSuccess: true, isError: false, error: null })).toBe("on");
    expect(protectionStatus({ isSuccess: false, isError: false, error: null })).toBe("loading");
  });

  it("the Computer row promises the switches only when they are on", () => {
    expect(securityRowDescription("on")).toContain("red button");
    for (const status of ["not-on", "error", "loading"] as const) {
      expect(securityRowDescription(status)).not.toContain("red button");
    }
  });
});

describe("SECURITY_HOLD", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the server's plain words, not the JSON", async () => {
    vi.stubGlobal("window", { location: { hostname: "abc123.uno4.work" } });
    const detail =
      "Computers on this account were stopped with Stop everything & report. They stay stopped until you start them yourself.";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "SECURITY_HOLD", detail }), { status: 409 }),
      ),
    );
    const error = await accountRequest("POST", "/api/v1/boxes/1/wake").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccountHttpError);
    expect((error as AccountHttpError).message).toBe(detail);
    expect((error as AccountHttpError).status).toBe(409);
  });
});
