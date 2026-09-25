import { describe, expect, it } from "vitest";

import { ControlPlaneHttpError } from "./unoCloudParse.ts";
import {
  NOT_LINKED_MESSAGE,
  classifyFailure,
  installComputerApp,
  catalogIconUrl,
  parseAppCategories,
  parseAppTemplates,
  parseTemplateAi,
  parseTemplateMobile,
  parseInstalledApps,
  readComputerActivity,
  readComputerApps,
  readComputerMetrics,
  readComputerState,
  humanizeControlPlaneError,
  readInstallStatus,
  parseAppCards,
  removeComputerApp,
  setComputerAppAiLimit,
  openComputerApp,
  computerAppAccess,
  REMOVE_NEEDS_CONSOLE_UPDATE,
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
      {
        name: "N8N_ADMIN_PASSWORD",
        description: "Password",
        secret: true,
        defaultValue: null,
        required: false,
        options: [],
        showIf: null,
      },
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
    expect(apps.catalog).toEqual({
      availability: "unavailable",
      message: null,
      templates: [],
      categories: [],
    });
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
        iconUrl: null,
        state: "installing",
        url: null,
        deploymentId: 500,
        notes: null,
        credentials: [],
        removable: true,
        webPort: null,
        composeProject: "uno-uptime-kuma",
        aiKey: null,
        sso: null,
        sharedWith: null,
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
    expect(result).toEqual({ deploymentId: 500, confirm: null });
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

describe("App Store 0.0.71", () => {
  it("reads choices, show_if and required from the catalog", () => {
    const [t] = parseAppTemplates({
      templates: [
        {
          id: "nextcloud",
          name: "Nextcloud",
          description_en: "Files",
          notes_en: "Your login is on the app card.",
          env: [
            {
              name: "STORAGE",
              description_en: "Where to keep files",
              default: "disk",
              options: [
                { value: "disk", label_en: "On this computer's disk", label_ru: "На диске" },
                { value: "s3", label_en: "In S3", label_ru: "В S3" },
              ],
            },
            { name: "S3_HOST", description_en: "S3 host", required: true, show_if: "STORAGE=s3" },
          ],
        },
      ],
    });
    expect(t?.notes).toBe("Your login is on the app card.");
    expect(t?.settings[0]?.options).toEqual([
      { value: "disk", label: "On this computer's disk" },
      { value: "s3", label: "In S3" },
    ]);
    expect(t?.settings[1]).toMatchObject({
      required: true,
      showIf: { name: "STORAGE", value: "s3" },
    });
  });

  it("puts sign-in details from /boxes/{id}/apps on the installed app", async () => {
    const plane = fakeControlPlane({
      "/api/v1/apps/templates": () => ({ templates: [{ id: "memos", name: "Memos", env: [] }] }),
      "/api/v1/git/services": () => ({
        services: [
          {
            id: -77,
            box_id: 123,
            repo_full_name: "memos",
            last_deployment_id: 77,
            last_status: "success",
            url: "https://memos-x.app.uno4.dev",
          },
        ],
      }),
      "/api/v1/boxes/123/apps": () => ({
        apps: [
          {
            deployment_id: 77,
            notes_en: "Your account is ready.",
            credentials: [
              { label_en: "Login", value: "owner" },
              { label_en: "Password", value: "s3cret", secret: true },
              {
                label_en: "Invite link",
                value: "https://memos-x.app.uno4.dev/uno-invite/k",
                link: true,
                secret: true,
              },
            ],
          },
        ],
      }),
    });
    const apps = await readComputerApps({
      apiKey: "key",
      fetchJson: plane.fetchJson,
      boxId: 123,
      known: [],
    });
    expect(apps.installed.apps[0]).toMatchObject({
      name: "Memos",
      state: "running",
      notes: "Your account is ready.",
      credentials: [
        { label: "Login", value: "owner", secret: false, link: false },
        { label: "Password", value: "s3cret", secret: true, link: false },
        {
          label: "Invite link",
          value: "https://memos-x.app.uno4.dev/uno-invite/k",
          secret: true,
          link: true,
        },
      ],
    });
  });

  it("an older console without /boxes/{id}/apps still lists the apps", async () => {
    const plane = fakeControlPlane({
      "/api/v1/apps/templates": () => ({ templates: [] }),
      "/api/v1/git/services": () => ({
        services: [
          {
            id: -5,
            box_id: 123,
            repo_full_name: "memos",
            last_deployment_id: 5,
            last_status: "success",
          },
        ],
      }),
    });
    const apps = await readComputerApps({
      apiKey: "key",
      fetchJson: plane.fetchJson,
      boxId: 123,
      known: [],
    });
    expect(apps.installed.availability).toBe("ok");
    expect(apps.installed.apps[0]?.credentials).toEqual([]);
  });

  it("asks to confirm when the computer has less memory, then sends allow_low_memory", async () => {
    let body: unknown = null;
    const refuse = fakeControlPlane({
      "/api/v1/boxes/123/apps": http(
        501,
        '{"error":"APP_NEEDS_MORE_MEMORY","detail":"Immich needs 4 GB"}',
      ),
    });
    const first = await installComputerApp({
      apiKey: "key",
      fetchJson: refuse.fetchJson,
      boxId: 123,
      templateId: "immich",
      settings: undefined,
    });
    expect(first.deploymentId).toBeNull();
    expect(first.confirm?.kind).toBe("low_memory");
    const ok = fakeControlPlane({
      "/api/v1/boxes/123/apps": (init) => {
        body = JSON.parse(String(init?.body));
        return { deployment_id: 9 };
      },
    });
    const second = await installComputerApp({
      apiKey: "key",
      fetchJson: ok.fetchJson,
      boxId: 123,
      templateId: "immich",
      settings: undefined,
      allowLowMemory: true,
    });
    expect(second.deploymentId).toBe(9);
    expect(body).toEqual({ template_id: "immich", env: {}, allow_low_memory: true });
  });

  it("says plainly when the computer has no docker (not 'coming soon')", async () => {
    await expect(
      installComputerApp({
        apiKey: "key",
        fetchJson: fakeControlPlane({
          "/api/v1/boxes/123/apps": http(501, '{"error":"APP_NEEDS_DOCKER","detail":"x"}'),
        }).fetchJson,
        boxId: 123,
        templateId: "memos",
        settings: undefined,
      }),
    ).rejects.toThrow(/needs docker/);
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

describe("humanizeControlPlaneError", () => {
  it("never shows a raw HTML error page", () => {
    const html = new Error("502: <!DOCTYPE html><html><head><title>Bad gateway</title>");
    expect(humanizeControlPlaneError(html)).toBe(
      "Uno isn't answering right now. It usually comes back in a minute.",
    );
    expect(humanizeControlPlaneError(new Error("<html>oops</html>"))).toBe(
      "Uno answered with an error.",
    );
  });
  it("names refused keys and network trouble in plain words", () => {
    expect(humanizeControlPlaneError(new Error("401: INVALID_TOKEN"))).toBe(
      "Uno refused this machine's key.",
    );
    expect(humanizeControlPlaneError(new TypeError("fetch failed"))).toBe(
      "Can't reach Uno right now. It will try again by itself.",
    );
  });
});

it("a 502 from the control plane reads as a pause, not as 'not an Uno computer'", async () => {
  const state = await readComputerState({
    apiKey: "uno_agt_box",
    ownBoxId: 1806,
    fetchJson: async () => {
      throw new Error("502: <!DOCTYPE html><html>cloudflare</html>");
    },
  });
  expect(state.box).toBe(null);
  expect(state.candidates).toEqual([]);
  expect(state.error).toBe("Uno isn't answering right now. It usually comes back in a minute.");
});

const services072 = () => ({
  services: [
    {
      id: -77,
      box_id: 123,
      repo_full_name: "memos",
      last_deployment_id: 77,
      last_status: "success",
    },
    {
      id: 5,
      box_id: 123,
      repo_full_name: "me/my-site",
      last_deployment_id: 5,
      last_status: "success",
    },
  ],
});
const templates072 = () => ({
  templates: [{ id: "memos", name: "Memos", env: [] }],
});

describe("App Store 0.0.72: remove, dedupe fields, AI key", () => {
  it("reads removable, web port, compose project and the AI key", () => {
    const cards = parseAppCards({
      apps: [
        {
          deployment_id: 77,
          template_id: "open-webui",
          removable: true,
          web_port: 8080,
          compose_project: "uno-open-webui",
          ai_key: { limit_usd: 10, spent_usd: 0.12 },
        },
        { deployment_id: 78, template_id: "memos", ai_key: { limit_usd: null, spent_usd: 3 } },
        { deployment_id: 79 },
      ],
    });
    expect(cards.get(77)).toMatchObject({
      templateId: "open-webui",
      removable: true,
      webPort: 8080,
      composeProject: "uno-open-webui",
      aiKey: { limitUsd: 10, spentUsd: 0.12 },
    });
    expect(cards.get(78)?.aiKey).toEqual({ limitUsd: null, spentUsd: 3 });
    // An older console: none of the new fields, all read as "don't know".
    expect(cards.get(79)).toMatchObject({
      removable: null,
      webPort: null,
      composeProject: null,
      aiKey: null,
    });
  });

  it("puts them on the installed app; a git deploy is not an App Store app", async () => {
    const plane = fakeControlPlane({
      "/api/v1/apps/templates": templates072,
      "/api/v1/git/services": services072,
      "/api/v1/boxes/123/apps": () => ({
        apps: [
          {
            deployment_id: 77,
            template_id: "memos",
            removable: true,
            web_port: 5230,
            compose_project: "uno-memos",
            ai_key: null,
          },
        ],
      }),
    });
    const apps = await readComputerApps({
      apiKey: "key",
      fetchJson: plane.fetchJson,
      boxId: 123,
      known: [],
    });
    expect(apps.installed.apps[0]).toMatchObject({
      name: "Memos",
      removable: true,
      webPort: 5230,
      composeProject: "uno-memos",
      aiKey: null,
    });
    expect(apps.installed.apps[1]).toMatchObject({ name: "my-site", removable: false });
  });

  it("with an older console, offers Remove for App Store apps and guesses the compose project", async () => {
    const plane = fakeControlPlane({
      "/api/v1/apps/templates": templates072,
      "/api/v1/git/services": services072,
    });
    const apps = await readComputerApps({
      apiKey: "key",
      fetchJson: plane.fetchJson,
      boxId: 123,
      known: [],
    });
    expect(apps.installed.apps[0]).toMatchObject({
      removable: true,
      webPort: null,
      composeProject: "uno-memos",
    });
    expect(apps.installed.apps[1]?.removable).toBe(false);
  });

  it("removes, keeping the data unless asked", async () => {
    const plane = fakeControlPlane({
      "/api/v1/boxes/123/apps/77": () => ({
        removed: true,
        template_id: "memos",
        data_deleted: false,
      }),
    });
    const result = await removeComputerApp({
      apiKey: "key",
      fetchJson: plane.fetchJson,
      boxId: 123,
      deploymentId: 77,
      deleteData: false,
    });
    expect(result).toEqual({ removed: true, templateId: "memos", dataDeleted: false });
    expect(plane.calls[0]).toMatchObject({
      method: "DELETE",
      path: "/api/v1/boxes/123/apps/77?delete_data=false",
    });
    await removeComputerApp({
      apiKey: "key",
      fetchJson: plane.fetchJson,
      boxId: 123,
      deploymentId: 77,
      deleteData: true,
    });
    expect(plane.calls[1]?.path).toBe("/api/v1/boxes/123/apps/77?delete_data=true");
  });

  it("says what went wrong in plain words", async () => {
    const attempt = (route: Route) =>
      removeComputerApp({
        apiKey: "key",
        fetchJson: fakeControlPlane({ "/api/v1/boxes/123/apps/77": route }).fetchJson,
        boxId: 123,
        deploymentId: 77,
        deleteData: false,
      });
    await expect(attempt(http(409, '{"error":"APP_BUSY"}'))).rejects.toThrow(
      "still being installed or updated",
    );
    await expect(
      attempt(http(502, '{"error":"APP_REMOVE_FAILED","detail":"docker compose down timed out"}')),
    ).rejects.toThrow("nothing was changed. docker compose down timed out.");
    await expect(attempt(http(404, '{"error":"NOT_FOUND"}'))).rejects.toThrow(
      "isn't on this computer anymore",
    );
    // An older console: its router's own 404, or 405 for DELETE.
    await expect(attempt(http(404, "404 page not found"))).rejects.toThrow(
      REMOVE_NEEDS_CONSOLE_UPDATE,
    );
    await expect(attempt(http(405, "Method Not Allowed"))).rejects.toThrow(
      REMOVE_NEEDS_CONSOLE_UPDATE,
    );
  });

  it("sets and clears the AI spending limit", async () => {
    const bodies: unknown[] = [];
    const plane = fakeControlPlane({
      "/api/v1/boxes/123/apps/77": (init) => {
        const body = JSON.parse(String(init?.body)) as { ai_limit_usd: number | null };
        bodies.push(body);
        return { ai_key: { limit_usd: body.ai_limit_usd, spent_usd: 0.12 } };
      },
    });
    const set = await setComputerAppAiLimit({
      apiKey: "key",
      fetchJson: plane.fetchJson,
      boxId: 123,
      deploymentId: 77,
      limitUsd: 25,
    });
    expect(set.aiKey).toEqual({ limitUsd: 25, spentUsd: 0.12 });
    const cleared = await setComputerAppAiLimit({
      apiKey: "key",
      fetchJson: plane.fetchJson,
      boxId: 123,
      deploymentId: 77,
      limitUsd: null,
    });
    expect(cleared.aiKey.limitUsd).toBeNull();
    expect(bodies).toEqual([{ ai_limit_usd: 25 }, { ai_limit_usd: null }]);
    expect(plane.calls[0]?.method).toBe("PATCH");
    await expect(
      setComputerAppAiLimit({
        apiKey: "key",
        fetchJson: fakeControlPlane({
          "/api/v1/boxes/123/apps/77": http(409, '{"error":"APP_NO_AI_KEY"}'),
        }).fetchJson,
        boxId: 123,
        deploymentId: 77,
        limitUsd: 5,
      }),
    ).rejects.toThrow("doesn't have an AI key");
  });
});

describe("Sign in with Uno", () => {
  it("reads sso and sharing from the app cards", () => {
    const cards = parseAppCards({
      apps: [
        {
          deployment_id: 1,
          template_id: "nextcloud",
          sso: "oidc",
          shared_with: 2,
          credentials: [],
        },
        { deployment_id: 2, template_id: "uptime-kuma", sso: "edge", credentials: [] },
        { deployment_id: 3, template_id: "ghost", sso: null, credentials: [] },
        { deployment_id: 4, template_id: "x", sso: "something-new", credentials: [] },
      ],
    });
    expect(cards.get(1)).toMatchObject({ sso: "oidc", sharedWith: 2 });
    expect(cards.get(2)).toMatchObject({ sso: "edge", sharedWith: null });
    expect(cards.get(3)?.sso).toBeNull();
    expect(cards.get(4)?.sso).toBeNull();
  });

  it("asks the console for a one-time link at the click", async () => {
    const plane = fakeControlPlane({
      "/api/v1/boxes/123/apps/77/open": () => ({
        url: "https://console.uno4.dev/api/v1/oidc/ticket?t=abc",
        signed_in: true,
      }),
    });
    const result = await openComputerApp({
      apiKey: "key",
      fetchJson: plane.fetchJson,
      boxId: 123,
      deploymentId: 77,
      fallbackUrl: "https://memos-box.app.uno4.dev",
    });
    expect(result).toEqual({
      url: "https://console.uno4.dev/api/v1/oidc/ticket?t=abc",
      signedIn: true,
    });
    expect(plane.calls[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/boxes/123/apps/77/open",
    });
  });

  it("falls back to the plain address on an older console", async () => {
    const plane = fakeControlPlane({});
    const result = await openComputerApp({
      apiKey: "key",
      fetchJson: plane.fetchJson,
      boxId: 123,
      deploymentId: 77,
      fallbackUrl: "https://memos-box.app.uno4.dev",
    });
    expect(result).toEqual({ url: "https://memos-box.app.uno4.dev", signedIn: false });
  });

  it("never follows a non-http link", async () => {
    const plane = fakeControlPlane({
      "/api/v1/boxes/123/apps/77/open": () => ({ url: "javascript:alert(1)", signed_in: true }),
    });
    const result = await openComputerApp({
      apiKey: "key",
      fetchJson: plane.fetchJson,
      boxId: 123,
      deploymentId: 77,
      fallbackUrl: "https://memos-box.app.uno4.dev",
    });
    expect(result).toEqual({ url: "https://memos-box.app.uno4.dev", signedIn: false });
  });

  it("shares, lists and unshares", async () => {
    const list = {
      people: [{ user_id: 5, username: "anna", email: "anna@example.com" }],
      sso: "oidc",
      sso_ready: true,
    };
    const plane = fakeControlPlane({
      "/api/v1/boxes/123/apps/77/access": () => list,
      "/api/v1/boxes/123/apps/77/access/5": () => ({ people: [], sso: "oidc", sso_ready: true }),
    });
    const base = { apiKey: "key", fetchJson: plane.fetchJson, boxId: 123, deploymentId: 77 };
    await expect(
      computerAppAccess({ ...base, action: { kind: "share", login: " anna@example.com " } }),
    ).resolves.toEqual({
      people: [{ userId: 5, name: "anna", email: "anna@example.com" }],
      ready: true,
    });
    expect(plane.calls[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/boxes/123/apps/77/access",
    });
    await expect(
      computerAppAccess({ ...base, action: { kind: "unshare", userId: 5 } }),
    ).resolves.toEqual({
      people: [],
      ready: true,
    });
    expect(plane.calls[1]).toMatchObject({
      method: "DELETE",
      path: "/api/v1/boxes/123/apps/77/access/5",
    });
  });

  it("says why sharing didn't work", async () => {
    const attempt = (route: Route) =>
      computerAppAccess({
        apiKey: "key",
        fetchJson: fakeControlPlane({ "/api/v1/boxes/123/apps/77/access": route }).fetchJson,
        boxId: 123,
        deploymentId: 77,
        action: { kind: "share", login: "nobody@example.com" },
      });
    await expect(attempt(http(404, '{"error":"USER_NOT_FOUND"}'))).rejects.toThrow(
      /no Uno account/,
    );
    await expect(attempt(http(409, '{"error":"APP_NO_SSO"}'))).rejects.toThrow(
      /doesn't sign in with Uno/,
    );
    await expect(attempt(http(404, "404 page not found"))).rejects.toThrow(/console update/);
  });
});

describe("App Store storefront fields", () => {
  it("reads rank, the line, keywords, Uno sign-in and the logo", () => {
    const [t] = parseAppTemplates({
      templates: [
        {
          id: "nextcloud",
          name: "Nextcloud",
          description_en: "Files",
          category: "files",
          icon: "☁️",
          min_ram_mb: 2048,
          min_disk_gb: 5,
          rank: 10,
          featured: true,
          tagline_en: "Your files on every device",
          tagline_ru: "Файлы",
          keywords: ["google drive", 3],
          icon_url: "/api/v1/apps/icons/nextcloud.svg",
          sso: { mode: "oidc" },
        },
      ],
    });
    expect(t).toMatchObject({
      rank: 10,
      featured: true,
      madeByUno: false,
      tagline: "Your files on every device",
      keywords: ["google drive"],
      sso: "oidc",
    });
    expect(t?.iconUrl).toMatch(/^https?:\/\/.+\/api\/v1\/apps\/icons\/nextcloud\.svg$/);
  });

  it("only takes logos from the console's own icon path", () => {
    expect(catalogIconUrl("/api/v1/apps/icons/memos.png", "https://c")).toBe(
      "https://c/api/v1/apps/icons/memos.png",
    );
    for (const bad of ["https://evil.example/x.svg", "/api/v1/apps/icons/../x.svg", "", 5]) {
      expect(catalogIconUrl(bad, "https://c")).toBeNull();
    }
  });

  it("reads sections in tab order", () => {
    expect(
      parseAppCategories({
        categories: [
          { id: "files", name_en: "Files & documents", name_ru: "Файлы" },
          { id: "developer", name_en: "For developers", technical: true },
          { name_en: "no id" },
        ],
      }),
    ).toEqual([
      { id: "files", name: "Files & documents", technical: false },
      { id: "developer", name: "For developers", technical: true },
    ]);
    expect(parseAppCategories({ templates: [] })).toEqual([]);
  });
});

describe("parseTemplateAi", () => {
  it("reads the catalog's ai: true, an object in either spelling, nothing otherwise", () => {
    expect(parseTemplateAi(true)).toEqual({ chat: true, tasks: false, limitUsd: null });
    expect(parseTemplateAi({ chat: true, tasks: true, limit_usd: 5 })).toEqual({
      chat: true,
      tasks: true,
      limitUsd: 5,
    });
    expect(parseTemplateAi({ tasks: true, limitUsd: -1 })).toEqual({
      chat: false,
      tasks: true,
      limitUsd: null,
    });
    expect(parseTemplateAi({ chat: false })).toBeNull();
    expect(parseTemplateAi(undefined)).toBeNull();
    const [t] = parseAppTemplates({ templates: [{ id: "notetaker", ai: { chat: true } }] });
    expect(t?.ai).toEqual({ chat: true, tasks: false, limitUsd: null });
  });
});

describe("App Store v3: publisher and phone apps", () => {
  it("reads publisher; made_by_uno and publisher uno both mean Made by Uno", () => {
    const [a, b, c, d] = parseAppTemplates({
      templates: [
        { id: "notetaker", made_by_uno: true, publisher: "uno" },
        { id: "future", publisher: "uno" },
        { id: "nextcloud", publisher: "community" },
        { id: "old" },
      ],
    });
    expect([a?.madeByUno, a?.publisher]).toEqual([true, "uno"]);
    expect([b?.madeByUno, b?.publisher]).toEqual([true, "uno"]);
    expect([c?.madeByUno, c?.publisher]).toEqual([false, "community"]);
    expect([d?.madeByUno, d?.publisher]).toEqual([false, null]);
  });

  it("keeps only App Store / Google Play links", () => {
    const [t] = parseAppTemplates({
      templates: [
        {
          id: "vaultwarden",
          mobile: {
            app_name: "Bitwarden",
            ios: "https://apps.apple.com/app/bitwarden-password-manager/id1137397744",
            android: "https://play.google.com/store/apps/details?id=com.x8bit.bitwarden",
            note_en: "Choose Self-hosted and enter your address.",
            note_ru: "Выберите Self-hosted.",
          },
        },
      ],
    });
    expect(t?.mobile).toEqual({
      ios: "https://apps.apple.com/app/bitwarden-password-manager/id1137397744",
      android: "https://play.google.com/store/apps/details?id=com.x8bit.bitwarden",
      appName: "Bitwarden",
      note: "Choose Self-hosted and enter your address.",
    });
    expect(
      parseTemplateMobile({
        ios: "https://evil.example/id1",
        android: "https://play.google.com/store/apps/details?id=a.b",
      }),
    ).toEqual({
      ios: null,
      android: "https://play.google.com/store/apps/details?id=a.b",
      appName: null,
      note: null,
    });
    expect(parseTemplateMobile({ ios: "javascript:alert(1)" })).toBeNull();
    expect(parseTemplateMobile(null)).toBeNull();
    const [none] = parseAppTemplates({ templates: [{ id: "memos" }] });
    expect(none?.mobile).toBeNull();
  });
});
