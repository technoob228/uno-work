import { describe, expect, it } from "vitest";

import { ControlPlaneHttpError } from "./unoCloudParse.ts";
import {
  NOT_LINKED_MESSAGE,
  classifyFailure,
  installComputerApp,
  parseInstalledApps,
  readComputerActivity,
  readComputerApps,
  readComputerMetrics,
  readComputerState,
  readInstallStatus,
  type KnownInstall,
} from "./unoComputer.ts";

type Route = (init?: RequestInit) => unknown;

/** A fake control plane: path (without query) → payload, or a thrown HTTP error. */
function fakeControlPlane(routes: Record<string, Route>) {
  const calls: Array<{ apiKey: string; path: string; method: string }> = [];
  const fetchJson = async (apiKey: string, path: string, init?: RequestInit) => {
    calls.push({ apiKey, path, method: init?.method ?? "GET" });
    const route = routes[path] ?? routes[path.split("?")[0] ?? path];
    if (!route) throw new ControlPlaneHttpError(404, "404: 404 page not found");
    return route(init);
  };
  return { fetchJson, calls };
}

const http = (status: number, body: string) => () => {
  throw new ControlPlaneHttpError(status, `${status}: ${body}`);
};

const BOX = {
  id: 123,
  name: "ci-runner",
  status: "running",
  os: "ubuntu-24.04",
  ram_mb: 2048,
  vcpu: 2,
  disk_gb: 30,
  started_at: "2026-09-18T10:00:00Z",
  network_public_ip: "203.0.113.42",
  ssh_command: "ssh -p 40122 uno@203.0.113.42",
};

const TEMPLATES = {
  templates: [
    {
      id: "uptime-kuma",
      name: "Uptime Kuma",
      icon: "📈",
      category: "мониторинг",
      description_ru: "Следит за сайтами",
      description_en: "Keeps an eye on your sites.",
      repo_url: "https://github.com/louislam/uptime-kuma",
      min_ram_mb: 512,
      min_disk_gb: 1,
    },
    {
      id: "n8n",
      name: "n8n",
      icon: "🔁",
      category: "автоматизация",
      description_ru: "Автоматизации",
      description_en: "",
      repo_url: "https://github.com/n8n-io/n8n",
      min_ram_mb: 1024,
      min_disk_gb: 2,
      env: [{ name: "N8N_ADMIN_PASSWORD", description_ru: "Пароль", secret: true }],
    },
  ],
};

describe("readComputerState", () => {
  it("reads this machine's box with its address and ports", async () => {
    const plane = fakeControlPlane({
      "/api/v1/boxes/123": () => BOX,
      "/api/v1/boxes/123/ports": () => ({
        ports: [
          { internal_port: 80, external_port: 40180, protocol: "tcp" },
          { internal_port: 22, external_port: 40122, protocol: "tcp" },
        ],
      }),
    });
    const state = await readComputerState({
      apiKey: "key",
      fetchJson: plane.fetchJson,
      ownBoxId: 123,
    });
    expect(state.linked).toBe(true);
    expect(state.own).toBe(true);
    expect(state.box).toMatchObject({
      id: 123,
      name: "ci-runner",
      status: "running",
      startedAt: "2026-09-18T10:00:00Z",
      address: "http://203.0.113.42:40180",
      ssh: "ssh -p 40122 uno@203.0.113.42",
    });
    expect(state.box?.ports.map((p) => p.port)).toEqual([22, 80]);
    expect(plane.calls.every((call) => call.apiKey === "key")).toBe(true);
  });

  it("prefers the control plane's hostname as the address", async () => {
    const plane = fakeControlPlane({
      "/api/v1/boxes/123": () => ({ ...BOX, hostname: "ci-runner.u85.uno4.me" }),
    });
    const state = await readComputerState({
      apiKey: "key",
      fetchJson: plane.fetchJson,
      ownBoxId: 123,
    });
    expect(state.box?.address).toBe("https://ci-runner.u85.uno4.me");
    // Ports 404 is not a reason to fail the header.
    expect(state.error).toBeNull();
  });

  it("is not linked, and asks nothing, without an account key", async () => {
    const plane = fakeControlPlane({});
    const state = await readComputerState({ apiKey: " ", fetchJson: plane.fetchJson, ownBoxId: 1 });
    expect(state).toMatchObject({ linked: false, box: null, error: null });
    expect(plane.calls).toHaveLength(0);
  });

  it("offers the account's computers when this machine is not one", async () => {
    const plane = fakeControlPlane({
      "/api/v1/boxes": () => ({ boxes: [BOX, { id: 7, name: "bot", status: "sleeping" }] }),
    });
    const state = await readComputerState({
      apiKey: "key",
      fetchJson: plane.fetchJson,
      ownBoxId: null,
    });
    expect(state.box).toBeNull();
    expect(state.candidates).toEqual([
      { id: 123, name: "ci-runner", status: "running" },
      { id: 7, name: "bot", status: "sleeping" },
    ]);
  });
});

describe("readComputerMetrics", () => {
  it("maps the observability contract", async () => {
    const plane = fakeControlPlane({
      "/api/v1/boxes/123/metrics": () => ({
        ok: true,
        live: true,
        sampled_at: "2026-09-21T10:00:00Z",
        uptime_s: 3600,
        cpu: { usage_pct: 12.5, vcpu: 2 },
        mem: { used_mb: 900, limit_mb: 2048 },
        disk: { used_gb: 4.2, total_gb: 30 },
        history: [{ t: "2026-09-21T09:59:00Z", cpu_pct: 10, mem_mb: 880 }],
      }),
    });
    const metrics = await readComputerMetrics({
      apiKey: "key",
      fetchJson: plane.fetchJson,
      boxId: 123,
    });
    expect(metrics).toMatchObject({
      availability: "ok",
      cpuPct: 12.5,
      memUsedMb: 900,
      memLimitMb: 2048,
      diskUsedGb: 4.2,
      diskTotalGb: 30,
      history: [{ t: "2026-09-21T09:59:00Z", cpuPct: 10, memMb: 880 }],
    });
  });

  it("says 'coming soon' when the control plane has no metrics route yet", async () => {
    const plane = fakeControlPlane({});
    const metrics = await readComputerMetrics({
      apiKey: "key",
      fetchJson: plane.fetchJson,
      boxId: 123,
    });
    expect(metrics.availability).toBe("unavailable");
    expect(metrics.message).toBeNull();
  });

  it("is offline, not broken, while the computer sleeps", async () => {
    const plane = fakeControlPlane({
      "/api/v1/boxes/123/metrics": () => ({ ok: true, box_id: 123, live: false }),
    });
    const metrics = await readComputerMetrics({
      apiKey: "key",
      fetchJson: plane.fetchJson,
      boxId: 123,
    });
    expect(metrics.availability).toBe("offline");
  });

  it("explains a node that cannot be reached in plain words", async () => {
    const plane = fakeControlPlane({
      "/api/v1/boxes/123/metrics": http(502, '{"ok":false,"error":"node unreachable"}'),
    });
    const metrics = await readComputerMetrics({
      apiKey: "key",
      fetchJson: plane.fetchJson,
      boxId: 123,
    });
    expect(metrics.availability).toBe("error");
    expect(metrics.message).toMatch(/isn't answering/);
  });

  it("needs an account key", async () => {
    const plane = fakeControlPlane({});
    const metrics = await readComputerMetrics({ apiKey: "", fetchJson: plane.fetchJson, boxId: 1 });
    expect(metrics).toMatchObject({ availability: "error", message: NOT_LINKED_MESSAGE });
    expect(plane.calls).toHaveLength(0);
  });
});

describe("readComputerActivity", () => {
  it("returns the log tail as plain lines", async () => {
    const plane = fakeControlPlane({
      "/api/v1/boxes/123/applogs": () => ({
        ok: true,
        source: "journal",
        lines: [{ line: "a" }, { line: "b" }],
      }),
    });
    const activity = await readComputerActivity({
      apiKey: "key",
      fetchJson: plane.fetchJson,
      boxId: 123,
      tail: 20,
    });
    expect(activity).toEqual({
      availability: "ok",
      message: null,
      source: "journal",
      lines: ["a", "b"],
    });
    expect(plane.calls[0]?.path).toBe("/api/v1/boxes/123/applogs?source=auto&tail=20");
  });

  it("is 'coming soon' behind a 404 and offline when the guest agent is away", async () => {
    const missing = await readComputerActivity({
      apiKey: "key",
      fetchJson: fakeControlPlane({}).fetchJson,
      boxId: 123,
      tail: 20,
    });
    expect(missing.availability).toBe("unavailable");

    const asleep = await readComputerActivity({
      apiKey: "key",
      fetchJson: fakeControlPlane({
        "/api/v1/boxes/123/applogs": () => ({ ok: false, error: "guest agent not running" }),
      }).fetchJson,
      boxId: 123,
      tail: 20,
    });
    expect(asleep.availability).toBe("offline");
  });
});

describe("readComputerApps", () => {
  it("lists the catalog in English and the apps on this computer", async () => {
    const plane = fakeControlPlane({
      "/api/v1/apps/templates": () => TEMPLATES,
      "/api/v1/git/services": () => ({
        services: [
          {
            id: 7,
            repo: "acme/status-page",
            box_id: 123,
            last_status: "success",
            last_deployment_id: 91,
          },
          {
            id: 8,
            repo: "apps/uptime-kuma",
            box_id: 123,
            last_status: "building",
            last_deployment_id: 92,
          },
          { id: 9, repo: "acme/other", box_id: 999, last_status: "success" },
        ],
      }),
    });
    const apps = await readComputerApps({
      apiKey: "key",
      fetchJson: plane.fetchJson,
      boxId: 123,
      known: [],
    });
    expect(apps.catalog.availability).toBe("ok");
    expect(apps.catalog.templates.map((t) => [t.id, t.description])).toEqual([
      ["uptime-kuma", "Keeps an eye on your sites."],
      // No English copy: fall back to the Russian one rather than a blank card.
      ["n8n", "Автоматизации"],
    ]);
    expect(apps.catalog.templates[1]?.settings).toEqual([
      { name: "N8N_ADMIN_PASSWORD", description: "Пароль", secret: true, defaultValue: null },
    ]);
    expect(apps.installed.apps.map((a) => [a.name, a.state, a.icon])).toEqual([
      ["status-page", "running", null],
      ["Uptime Kuma", "installing", "📈"],
    ]);
  });

  it("says 'coming soon' for the catalog when the App Store is not deployed", async () => {
    const plane = fakeControlPlane({ "/api/v1/git/services": () => ({ services: [] }) });
    const apps = await readComputerApps({
      apiKey: "key",
      fetchJson: plane.fetchJson,
      boxId: 123,
      known: [],
    });
    expect(apps.catalog).toEqual({ availability: "unavailable", message: null, templates: [] });
    expect(apps.installed.availability).toBe("ok");
  });

  it("needs an account key", async () => {
    const apps = await readComputerApps({
      apiKey: "",
      fetchJson: fakeControlPlane({}).fetchJson,
      boxId: 123,
      known: [],
    });
    expect(apps.catalog.message).toBe(NOT_LINKED_MESSAGE);
  });
});

describe("parseInstalledApps", () => {
  it("shows an install this daemon started before the service list knows it", () => {
    const known: KnownInstall[] = [
      { deploymentId: 500, boxId: 123, templateId: "uptime-kuma", state: "installing", url: null },
      { deploymentId: 501, boxId: 123, templateId: "n8n", state: "failed", url: null },
    ];
    const apps = parseInstalledApps({ services: [] }, 123, [], known);
    expect(apps).toEqual([
      {
        key: "install:500",
        name: "uptime-kuma",
        templateId: "uptime-kuma",
        icon: null,
        state: "installing",
        url: null,
        deploymentId: 500,
      },
    ]);
  });
});

describe("installComputerApp", () => {
  it("posts the template and settings and returns the deployment", async () => {
    let body: unknown = null;
    const plane = fakeControlPlane({
      "/api/v1/boxes/123/apps": (init) => {
        body = JSON.parse(String(init?.body));
        return { deployment_id: 500, status: "queued" };
      },
    });
    const result = await installComputerApp({
      apiKey: "key",
      fetchJson: plane.fetchJson,
      boxId: 123,
      templateId: "n8n",
      settings: { N8N_ADMIN_PASSWORD: "pw" },
    });
    expect(result).toEqual({ deploymentId: 500 });
    expect(plane.calls[0]?.method).toBe("POST");
    expect(body).toEqual({ template_id: "n8n", env: { N8N_ADMIN_PASSWORD: "pw" } });
  });

  it("turns a missing route into 'coming soon' and a missing template into its own message", async () => {
    await expect(
      installComputerApp({
        apiKey: "key",
        fetchJson: fakeControlPlane({}).fetchJson,
        boxId: 123,
        templateId: "n8n",
        settings: undefined,
      }),
    ).rejects.toThrow(/coming soon/);
    await expect(
      installComputerApp({
        apiKey: "key",
        fetchJson: fakeControlPlane({
          "/api/v1/boxes/123/apps": http(404, '{"error":"TEMPLATE_NOT_FOUND"}'),
        }).fetchJson,
        boxId: 123,
        templateId: "gone",
        settings: undefined,
      }),
    ).rejects.toThrow(/isn't in the catalog/);
  });

  it("refuses without an account key", async () => {
    await expect(
      installComputerApp({
        apiKey: "",
        fetchJson: fakeControlPlane({}).fetchJson,
        boxId: 123,
        templateId: "n8n",
        settings: undefined,
      }),
    ).rejects.toThrow(NOT_LINKED_MESSAGE);
  });
});

describe("readInstallStatus", () => {
  it("returns new lines and keeps installing until the deployment is done", async () => {
    const plane = fakeControlPlane({
      "/api/v1/deployments/500/logs": () => ({
        status: "building",
        done: false,
        logs: [
          { seq: 1, line: "cloning" },
          { seq: 2, line: "building" },
        ],
      }),
    });
    const status = await readInstallStatus({
      apiKey: "key",
      fetchJson: plane.fetchJson,
      deploymentId: 500,
      afterSeq: 1,
      boxId: 123,
    });
    expect(status).toEqual({
      deploymentId: 500,
      state: "installing",
      status: "building",
      lines: [{ seq: 2, text: "building" }],
      nextSeq: 2,
      url: null,
    });
    expect(plane.calls[0]?.path).toBe("/api/v1/deployments/500/logs?after_seq=1");
  });

  it("finds the app's address once it runs", async () => {
    const plane = fakeControlPlane({
      "/api/v1/deployments/500/logs": () => ({ status: "success", done: true, logs: [] }),
      "/api/v1/git/services": () => ({
        services: [{ id: 100, last_deployment_id: 500, url: "https://kuma.example" }],
      }),
    });
    const status = await readInstallStatus({
      apiKey: "key",
      fetchJson: plane.fetchJson,
      deploymentId: 500,
      afterSeq: 0,
      boxId: 123,
    });
    expect(status.state).toBe("running");
    expect(status.url).toBe("https://kuma.example");
  });

  it("reports a failed install", async () => {
    const status = await readInstallStatus({
      apiKey: "key",
      fetchJson: fakeControlPlane({
        "/api/v1/deployments/500/logs": () => ({ status: "failed", done: true, logs: [] }),
      }).fetchJson,
      deploymentId: 500,
      afterSeq: 0,
      boxId: 123,
    });
    expect(status.state).toBe("failed");
  });
});

describe("classifyFailure", () => {
  it("treats 404/405/501 as not deployed yet", () => {
    for (const status of [404, 405, 501]) {
      expect(classifyFailure(new ControlPlaneHttpError(status, `${status}`)).availability).toBe(
        "unavailable",
      );
    }
    expect(classifyFailure(new Error("fetch failed")).availability).toBe("error");
  });
});
