import { describe, expect, it } from "vitest";

import { ControlPlaneHttpError } from "./unoCloudParse.ts";
import {
  UPGRADE_URL,
  classifyResizeRefusal,
  computeResizeLimits,
  readResizeOptions,
  resizeComputer,
} from "./unoComputerResize.ts";

const BOX = { id: 42, status: "running", ram_mb: 2048, vcpu: 1, disk_gb: 10 };
const SUB = {
  plan: "pro",
  plan_limits: {
    max_box: { ram_mb: 8192, vcpu: 4 },
    peak: { ram_mb: 12288, vcpu: 6 },
    disk_gb: 60,
  },
  usage: { running_ram_mb: 2048 + 6144, running_vcpu: 1 + 3, disk_gb_used: 10 + 30 },
};

describe("computeResizeLimits", () => {
  it("caps a running computer by the plan and by what the peak leaves", () => {
    const limits = computeResizeLimits(BOX, SUB);
    expect(limits).toEqual({
      current: { ramMb: 2048, vcpu: 1, diskGb: 10 },
      // peak 12 GB − 6 GB of other running computers = 6 GB; plan max is 8 GB.
      max: { ramMb: 6144, vcpu: 3, diskGb: 30 },
      planMax: { ramMb: 8192, vcpu: 4, diskGb: 60 },
      planName: "Pro",
    });
  });

  it("uses only the plan's ceiling for a sleeping computer", () => {
    const limits = computeResizeLimits({ ...BOX, status: "sleeping" }, SUB);
    expect(limits?.max).toMatchObject({ ramMb: 8192, vcpu: 4 });
  });

  it("never offers less than the current size, and keeps RAM on the 256 MB grid", () => {
    const limits = computeResizeLimits(
      { ...BOX, ram_mb: 4096 },
      { ...SUB, plan_limits: { ...SUB.plan_limits, max_box: { ram_mb: 3000, vcpu: 1 } } },
    );
    expect(limits?.max.ramMb).toBe(4096);
    const odd = computeResizeLimits(BOX, {
      ...SUB,
      plan_limits: { ...SUB.plan_limits, max_box: { ram_mb: 5000, vcpu: 4 }, peak: null },
    });
    expect(odd?.max.ramMb).toBe(4864);
  });

  it("gives up on a box without a size", () => {
    expect(computeResizeLimits({ id: 1 }, SUB)).toBeNull();
    expect(computeResizeLimits(null, SUB)).toBeNull();
  });
});

describe("classifyResizeRefusal", () => {
  const conflict = (code: string) => new ControlPlaneHttpError(409, `409: {"error":"${code}"}`);

  it("recognises plan limits, the budget guard and a busy computer", () => {
    expect(classifyResizeRefusal(conflict("PEAK_EXCEEDED"))?.outcome).toBe("plan_limit");
    expect(classifyResizeRefusal(conflict("SHAPE_TOO_LARGE"))?.outcome).toBe("plan_limit");
    expect(classifyResizeRefusal(conflict("DISK_QUOTA_EXCEEDED"))?.outcome).toBe("plan_limit");
    expect(classifyResizeRefusal(conflict("POOL_EXHAUSTED"))?.outcome).toBe("plan_limit");
    expect(classifyResizeRefusal(conflict("BUDGET_GUARD"))?.outcome).toBe("guard");
    expect(classifyResizeRefusal(conflict("BOX_BUSY"))?.outcome).toBe("busy");
  });

  it("leaves everything else to the generic error path", () => {
    expect(classifyResizeRefusal(new ControlPlaneHttpError(500, "500: boom"))).toBeNull();
    expect(classifyResizeRefusal(new Error("fetch failed"))).toBeNull();
  });
});

describe("resizeComputer", () => {
  const routes = (resize: () => unknown) => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const fetchJson = async (_key: string, path: string, init?: RequestInit) => {
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (path === "/api/v1/boxes/42/resize") return resize();
      if (path === "/api/v1/boxes/42") return BOX;
      if (path === "/api/v1/box-subscription") return SUB;
      throw new ControlPlaneHttpError(404, "404");
    };
    return { calls, fetchJson };
  };

  it("sends the new size and reports it", async () => {
    const { calls, fetchJson } = routes(() => ({ ...BOX, ram_mb: 4096, vcpu: 2 }));
    const result = await resizeComputer({
      apiKey: "uno_agt_machine",
      fetchJson,
      boxId: 42,
      shape: { ramMb: 4096, vcpu: 2, diskGb: 10 },
    });
    expect(calls[0]).toEqual({
      path: "/api/v1/boxes/42/resize",
      body: { ram_mb: 4096, vcpu: 2, disk_gb: 10 },
    });
    expect(result).toMatchObject({ outcome: "resized", shape: { ramMb: 4096, vcpu: 2 } });
  });

  it("answers a plan limit with the plan's ceiling and the upgrade link", async () => {
    const { fetchJson } = routes(() => {
      throw new ControlPlaneHttpError(409, '409: {"error":"SHAPE_TOO_LARGE"}');
    });
    const result = await resizeComputer({
      apiKey: "k",
      fetchJson,
      boxId: 42,
      shape: { ramMb: 16384, vcpu: 8, diskGb: 10 },
    });
    expect(result).toMatchObject({
      outcome: "plan_limit",
      limit: { ramMb: 8192, vcpu: 4, diskGb: 60 },
      planName: "Pro",
      upgradeUrl: UPGRADE_URL,
    });
  });

  it("explains a machine key from before the resize scope", async () => {
    const { fetchJson } = routes(() => {
      throw new ControlPlaneHttpError(403, '403: {"error":"WORK_MACHINE_TOKEN_RESTRICTED"}');
    });
    await expect(
      resizeComputer({
        apiKey: "k",
        fetchJson,
        boxId: 42,
        shape: { ramMb: 4096, vcpu: 1, diskGb: 10 },
      }),
    ).rejects.toThrow(/Open this computer once from the Uno console/);
  });

  it("offers nothing without a key or a computer", async () => {
    expect((await readResizeOptions({ apiKey: "", boxId: 42 })).canResize).toBe(false);
    expect((await readResizeOptions({ apiKey: "k", boxId: null })).availability).toBe("error");
  });
});
