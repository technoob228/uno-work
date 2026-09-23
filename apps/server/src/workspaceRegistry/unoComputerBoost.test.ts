import { describe, expect, it } from "vitest";

import { ControlPlaneHttpError } from "./unoCloudParse.ts";
import { parseComputerBox } from "./unoComputer.ts";
import {
  boostErrorCode,
  boostRefusalMessage,
  endBoost,
  parseComputerBoost,
  startBoost,
} from "./unoComputerBoost.ts";

const BOOST_OFF = {
  available: true,
  state: "off",
  ram_mb: 8192,
  vcpu: 4,
  base_ram_mb: 4096,
  base_vcpu: 2,
  hours: 1,
  started_at: null,
  ends_at: null,
  hours_left_today: 3,
  hours_per_day: 4,
  reason: "",
};
const BOX = { id: 42, status: "running", ram_mb: 4096, vcpu: 2, disk_gb: 10, boost: BOOST_OFF };

const refusal = (status: number, code: string) =>
  new ControlPlaneHttpError(status, `${status}: {"error":"${code}"}`);

describe("parseComputerBoost", () => {
  it("reads the control plane's boost object", () => {
    expect(parseComputerBoost(BOOST_OFF)).toEqual({
      available: true,
      state: "off",
      ramMb: 8192,
      vcpu: 4,
      baseRamMb: 4096,
      baseVcpu: 2,
      hours: 1,
      startedAt: null,
      endsAt: null,
      hoursLeftToday: 3,
      hoursPerDay: 4,
      reason: null,
    });
  });

  it("treats an unknown state as off and keeps the reason", () => {
    const boost = parseComputerBoost({
      ...BOOST_OFF,
      state: "weird",
      available: false,
      reason: "Not on trial",
    });
    expect(boost).toMatchObject({ state: "off", available: false, reason: "Not on trial" });
  });

  it("puts boost on the box only when the control plane sends it", () => {
    expect(parseComputerBox(BOX, [])?.boost?.ramMb).toBe(8192);
    const { boost: _drop, ...plain } = BOX;
    expect(parseComputerBox(plain, [])).not.toHaveProperty("boost");
  });
});

describe("boost refusals", () => {
  it("finds the code and says it in plain words", () => {
    expect(boostErrorCode(refusal(409, "BOOST_NO_CAPACITY"))).toBe("BOOST_NO_CAPACITY");
    expect(boostRefusalMessage(refusal(409, "BOOST_NO_CAPACITY"))).toBe(
      "Uno can't boost right now — try again in a few minutes.",
    );
    expect(boostRefusalMessage(refusal(429, "BOOST_DAILY_LIMIT"))).toMatch(/today's boost hours/);
    expect(boostRefusalMessage(refusal(409, "BOX_NOT_RUNNING"))).toMatch(/needs to be on/);
    expect(boostRefusalMessage(new ControlPlaneHttpError(500, "500: boom"))).toBeNull();
  });

  it("does not confuse BOOST_NOT_ACTIVE with BOOST_ACTIVE", () => {
    expect(boostErrorCode(refusal(409, "BOOST_NOT_ACTIVE"))).toBe("BOOST_NOT_ACTIVE");
  });
});

describe("startBoost / endBoost", () => {
  const routes = (action: (method: string) => unknown, box: unknown = BOX) => {
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    const fetchJson = async (_key: string, path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (path === "/api/v1/boxes/42/boost") return action(method);
      if (path === "/api/v1/boxes/42") return box;
      throw new ControlPlaneHttpError(404, "404");
    };
    return { calls, fetchJson };
  };

  it("asks for one hour and returns the starting state", async () => {
    const { calls, fetchJson } = routes(() => ({
      boost: { ...BOOST_OFF, state: "starting", ends_at: "2026-09-24T12:00:00Z" },
    }));
    const result = await startBoost({ apiKey: "k", fetchJson, boxId: 42 });
    expect(calls[0]).toEqual({
      path: "/api/v1/boxes/42/boost",
      method: "POST",
      body: { hours: 1 },
    });
    expect(result).toMatchObject({
      outcome: "started",
      boost: { state: "starting", endsAt: "2026-09-24T12:00:00Z" },
    });
  });

  it("answers a refusal with words and the fresh state", async () => {
    const { fetchJson } = routes(() => {
      throw refusal(429, "BOOST_DAILY_LIMIT");
    });
    const result = await startBoost({ apiKey: "k", fetchJson, boxId: 42 });
    expect(result.outcome).toBe("refused");
    expect(result.message).toMatch(/today's boost hours/);
    expect(result.boost?.hoursLeftToday).toBe(3);
  });

  it("prefers the control plane's reason when boost is not available", async () => {
    const { fetchJson } = routes(
      () => {
        throw refusal(403, "BOOST_NOT_AVAILABLE");
      },
      { ...BOX, boost: { ...BOOST_OFF, available: false, reason: "Boost comes with paid plans." } },
    );
    const result = await startBoost({ apiKey: "k", fetchJson, boxId: 42 });
    expect(result).toMatchObject({ outcome: "refused", message: "Boost comes with paid plans." });
  });

  it("treats an already running boost as started", async () => {
    const { fetchJson } = routes(
      () => {
        throw refusal(409, "BOOST_ACTIVE");
      },
      { ...BOX, boost: { ...BOOST_OFF, state: "active", ends_at: "2026-09-24T12:00:00Z" } },
    );
    const result = await startBoost({ apiKey: "k", fetchJson, boxId: 42 });
    expect(result).toMatchObject({ outcome: "started", boost: { state: "active" } });
  });

  it("ends a boost, and an already ended one is fine", async () => {
    const ending = routes(() => ({ boost: { ...BOOST_OFF, state: "ending" } }));
    expect(await endBoost({ apiKey: "k", fetchJson: ending.fetchJson, boxId: 42 })).toMatchObject({
      outcome: "ended",
      boost: { state: "ending" },
    });
    expect(ending.calls[0]?.method).toBe("DELETE");
    const gone = routes(() => {
      throw refusal(409, "BOOST_NOT_ACTIVE");
    });
    expect(await endBoost({ apiKey: "k", fetchJson: gone.fetchJson, boxId: 42 })).toMatchObject({
      outcome: "ended",
      boost: { state: "off" },
    });
  });

  it("fails with readable words on anything else", async () => {
    const { fetchJson } = routes(() => {
      throw new ControlPlaneHttpError(502, "502: bad gateway");
    });
    await expect(startBoost({ apiKey: "k", fetchJson, boxId: 42 })).rejects.toThrow(
      /Uno isn't answering/,
    );
    await expect(startBoost({ apiKey: "", fetchJson, boxId: 42 })).rejects.toThrow(/Connect/);
  });
});
