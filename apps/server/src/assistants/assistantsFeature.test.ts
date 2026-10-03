import type { ServerSettings } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  assistantsMvpEnabled,
  featuresHaveAssistants,
  resetAssistantsFeatureCache,
} from "./assistantsFeature.ts";

const settings = (boxToken: string) =>
  ({ uno: { boxToken, apiKey: "" } }) as unknown as Pick<ServerSettings, "uno">;

const answering = (body: unknown, status = 200) => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

describe("does the account have the new assistants", () => {
  beforeEach(() => resetAssistantsFeatureCache());
  const base = { baseUrl: "https://console.test", env: {} };

  it("reads features of /auth/me", () => {
    expect(featuresHaveAssistants({ features: ["x", "assistants_mvp"] })).toBe(true);
    expect(featuresHaveAssistants({ features: [] })).toBe(false);
    expect(featuresHaveAssistants(null)).toBe(false);
  });

  it("is off without an Uno account on this computer, and asks nobody", async () => {
    const { calls, fetchImpl } = answering({ features: ["assistants_mvp"] });
    expect(await assistantsMvpEnabled(settings(""), { ...base, fetchImpl })).toBe(false);
    expect(await assistantsMvpEnabled(null, { ...base, fetchImpl })).toBe(false);
    expect(calls).toEqual([]);
  });

  it("is on when the console lists the feature, and remembers the answer", async () => {
    const { calls, fetchImpl } = answering({ features: ["assistants_mvp"] });
    let now = 1_000;
    const options = { ...base, fetchImpl, now: () => now };
    expect(await assistantsMvpEnabled(settings("tok"), options)).toBe(true);
    expect(await assistantsMvpEnabled(settings("tok"), options)).toBe(true);
    expect(calls).toEqual(["https://console.test/auth/me"]);
    now += 11 * 60_000;
    await assistantsMvpEnabled(settings("tok"), options);
    expect(calls).toHaveLength(2);
  });

  it("is off when the flag is off, and when the console doesn't answer", async () => {
    const off = answering({ features: [] });
    expect(await assistantsMvpEnabled(settings("tok"), { ...base, fetchImpl: off.fetchImpl })).toBe(
      false,
    );
    resetAssistantsFeatureCache();
    const down = answering({ error: "boom" }, 500);
    expect(
      await assistantsMvpEnabled(settings("tok"), { ...base, fetchImpl: down.fetchImpl }),
    ).toBe(false);
    resetAssistantsFeatureCache();
    const throwing = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    expect(await assistantsMvpEnabled(settings("tok"), { ...base, fetchImpl: throwing })).toBe(
      false,
    );
  });

  it("can be forced on a stand", async () => {
    const { calls, fetchImpl } = answering({ features: [] });
    expect(
      await assistantsMvpEnabled(settings("tok"), {
        ...base,
        fetchImpl,
        env: { UNO_ASSISTANTS_MVP: "on" },
      }),
    ).toBe(true);
    expect(
      await assistantsMvpEnabled(settings(""), { ...base, env: { UNO_ASSISTANTS_MVP: "off" } }),
    ).toBe(false);
    expect(calls).toEqual([]);
  });
});
