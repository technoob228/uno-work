import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { UnoAccountService, isAllowedAccountRequest } from "./unoAccount.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) FS.rmSync(dir, { recursive: true, force: true });
});

const codec = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`enc:${value}`),
  decryptString: (value: Buffer) => value.toString().replace(/^enc:/, ""),
};

function makeService(consoleFetch: typeof fetch) {
  const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "uno-account-"));
  dirs.push(dir);
  const filePath = Path.join(dir, "uno-account.bin");
  const service = new UnoAccountService({
    filePath,
    codec,
    consoleUrl: "https://console.test",
    deviceName: "test-mac",
    // Plays the browser: follow the console page straight to the loopback callback.
    openExternal: async (url) => {
      const page = new URL(url);
      expect(page.pathname).toBe("/work/desktop");
      expect(page.searchParams.get("device")).toBe("test-mac");
      const callback = `http://127.0.0.1:${page.searchParams.get("port")}/uno-callback?code=CODE123&state=${page.searchParams.get("state")}`;
      const response = await fetch(callback);
      expect(response.status).toBe(200);
    },
    fetch: consoleFetch,
  });
  return { service, filePath };
}

describe("UnoAccountService", () => {
  it("signs in through the loopback code and keeps only an encrypted token", async () => {
    const seen: string[] = [];
    const consoleFetch = (async (input: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${input}`);
      if (input.endsWith("/api/v1/work/desktop-token")) {
        const body = JSON.parse(String(init?.body)) as { code: string };
        expect(body.code).toBe("CODE123");
        return new Response(JSON.stringify({ token: "uno_usr_secret", user: { email: "m@x" } }));
      }
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer uno_usr_secret");
      return new Response(JSON.stringify({ boxes: [] }));
    }) as typeof fetch;
    const { service, filePath } = makeService(consoleFetch);
    expect(service.status()).toEqual({ signedIn: false, email: null });
    expect(await service.signIn()).toEqual({ signedIn: true, email: "m@x" });
    expect(FS.readFileSync(filePath).toString().startsWith("enc:")).toBe(true);
    const listed = await service.request({ method: "GET", path: "/api/v1/boxes" });
    expect(listed).toEqual({ status: 200, body: { boxes: [] } });
    expect(seen.at(-1)).toBe("GET https://console.test/api/v1/boxes");
  });

  it("refuses anything outside the allowlist without calling the console", async () => {
    const { service } = makeService((async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch);
    expect(await service.request({ method: "POST", path: "/api/v1/tokens" })).toEqual({
      status: 403,
      body: { error: "NOT_ALLOWED" },
    });
    expect(isAllowedAccountRequest("GET", "/api/v1/boxes/12")).toBe(true);
    expect(isAllowedAccountRequest("POST", "/api/v1/boxes/12/delete")).toBe(false);
    expect(isAllowedAccountRequest("GET", "/api/v1/boxes/../tokens")).toBe(false);
    // "My Uno": read the account, set a role, add a server — never move money.
    expect(isAllowedAccountRequest("GET", "/api/v1/work/plans")).toBe(true);
    expect(isAllowedAccountRequest("GET", "/api/v1/work/sites")).toBe(true);
    expect(isAllowedAccountRequest("POST", "/api/v1/work/servers")).toBe(true);
    expect(isAllowedAccountRequest("GET", "/pay/history")).toBe(true);
    expect(isAllowedAccountRequest("PATCH", "/api/v1/boxes/12")).toBe(true);
    expect(isAllowedAccountRequest("GET", "/api/v1/boxes/12/metrics")).toBe(true);
    expect(isAllowedAccountRequest("GET", "/api/v1/boxes/12/applogs?source=auto&tail=200")).toBe(
      true,
    );
    expect(isAllowedAccountRequest("GET", "/api/v1/boxes/12/applogs?source=auto&tail=2?x")).toBe(
      false,
    );
    expect(isAllowedAccountRequest("GET", "/api/v1/boxes/12/metrics?token=x")).toBe(false);
    expect(isAllowedAccountRequest("GET", "/api/v1/boxes?x=1")).toBe(false);
    expect(isAllowedAccountRequest("POST", "/api/v1/box-subscription/change")).toBe(false);
    expect(isAllowedAccountRequest("POST", "/pay/direct/create")).toBe(false);
    expect(isAllowedAccountRequest("POST", "/api/v1/boxes")).toBe(false);
    expect(await service.request({ method: "GET", path: "/api/v1/boxes" })).toEqual({
      status: 401,
      body: { error: "NOT_SIGNED_IN" },
    });
  });
});
