import { assert, it } from "@effect/vitest";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect, Exit, Layer } from "effect";

import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { UnoBoxIdentity } from "../unoBoxIdentity.ts";
import { ControlPlaneHttpError } from "../workspaceRegistry/unoCloudParse.ts";
import {
  MachineAppsService,
  PUBLISH_NOT_A_COMPUTER,
  appEnvironment,
  makeMachineAppsService,
} from "./MachineAppsService.ts";
import type { MachineProbe } from "./machineAppsScan.ts";

const SS = `LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=1234,fd=21))
LISTEN 0 511 127.0.0.1:8787 0.0.0.0:* users:(("python3",pid=77,fd=5))
LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=612,fd=3))
`;

const probe: Partial<MachineProbe> = {
  platform: "linux",
  run: async (command) => (command === "ss" ? { ok: true, stdout: SS } : { ok: false, stdout: "" }),
  readFile: async () => null,
  probeHttp: async () => ({ http: true, title: null }),
};

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly key: string;
}

function serviceLayer(input: {
  readonly ownBoxId: number | null;
  readonly apiKey?: string;
  readonly boxToken?: string;
  readonly ports?: unknown[];
  readonly calls?: Call[];
  readonly probe?: Partial<MachineProbe>;
  readonly storeApps?: unknown[];
  readonly options?: Partial<Parameters<typeof makeMachineAppsService>[0]>;
}) {
  const ports = [...(input.ports ?? [])] as Array<Record<string, unknown>>;
  const fetchJson = async (key: string, path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    input.calls?.push({ method, path, body, key });
    if (path === "/api/v1/boxes/42" && method === "GET") {
      return { id: 42, hostname: "work.u85.uno4.me" };
    }
    if (path === "/api/v1/boxes/42/ports" && method === "GET") return { ports };
    if (path === "/api/v1/boxes/42/apps" && method === "GET" && input.storeApps) {
      return { apps: input.storeApps };
    }
    if (path === "/api/v1/boxes/42/ports" && method === "POST") {
      const forward = {
        id: 100 + ports.length,
        internal_port: body.port,
        external_port: 43000 + ports.length,
        protocol: body.protocol,
        visibility: "public",
        state: "applied",
      };
      ports.push(forward);
      return forward;
    }
    const del = /^\/api\/v1\/boxes\/42\/ports\/(\d+)$/.exec(path);
    if (del && method === "DELETE") {
      const index = ports.findIndex((p) => p["id"] === Number(del[1]));
      if (index !== -1) ports.splice(index, 1);
      return { status: "deleted" };
    }
    throw new ControlPlaneHttpError(404, "404: not found");
  };
  return Layer.effect(
    MachineAppsService,
    makeMachineAppsService({
      probe: input.probe ?? probe,
      fetchJson,
      home: "/home/unowork",
      manifestDir: "/nonexistent/uno-apps",
      hiddenPath: null,
      background: false,
      ...input.options,
    }),
  ).pipe(
    Layer.provide(Layer.succeed(ServerConfig, { port: 80 } as ServerConfigShape)),
    Layer.provide(
      ServerSettingsService.layerTest({
        uno: {
          apiKey: input.apiKey ?? "unollm_gateway_key",
          ...(input.boxToken !== undefined ? { boxToken: input.boxToken } : {}),
        },
      }),
    ),
    Layer.provide(
      Layer.succeed(UnoBoxIdentity, {
        current: Effect.succeed(input.ownBoxId),
        probe: Effect.void,
      }),
    ),
  );
}

it.effect("lists programs and shows an app's public address once its port is published", () =>
  Effect.gen(function* () {
    const service = yield* MachineAppsService;
    const listed = yield* service.list;
    assert.deepStrictEqual(
      listed.apps.map((a) => a.id),
      ["port:3000", "port:8787"],
    );
    assert.strictEqual(listed.publishBlockedReason, null);
    const app = listed.apps.find((a) => a.id === "port:3000");
    assert.deepStrictEqual(app?.publication, {
      forwardId: 7,
      externalPort: 43007,
      url: "http://work.u85.uno4.me:43007/",
      host: "work.u85.uno4.me",
      state: "applied",
      forwards: [{ forwardId: 7, internalPort: 3000, externalPort: 43007, protocol: "tcp" }],
    });
  }).pipe(
    Effect.provide(
      serviceLayer({
        ownBoxId: 42,
        boxToken: "uno_agt_machine",
        ports: [
          {
            id: 7,
            internal_port: 3000,
            external_port: 43007,
            protocol: "tcp",
            visibility: "public",
            state: "applied",
          },
        ],
      }),
    ),
  ),
);

it.effect("publishes with the machine's own token and hides again", () => {
  const calls: Call[] = [];
  return Effect.gen(function* () {
    const service = yield* MachineAppsService;
    const published = yield* service.action({ appId: "port:3000", action: "publish" });
    const post = calls.find((c) => c.method === "POST");
    assert.deepStrictEqual(post?.body, { port: 3000, protocol: "tcp", visibility: "public" });
    assert.strictEqual(post?.key, "uno_agt_machine");
    const app = published.apps.find((a) => a.id === "port:3000");
    assert.strictEqual(app?.publication?.url, "http://work.u85.uno4.me:43000/");

    const hidden = yield* service.action({ appId: "port:3000", action: "unpublish" });
    assert.ok(calls.some((c) => c.method === "DELETE" && c.path === "/api/v1/boxes/42/ports/100"));
    assert.strictEqual(hidden.apps.find((a) => a.id === "port:3000")?.publication, null);
  }).pipe(Effect.provide(serviceLayer({ ownBoxId: 42, boxToken: "uno_agt_machine", calls })));
});

it.effect("shows a VPN container's web panel and its UDP tunnel together, and hides both", () => {
  const calls: Call[] = [];
  const dockerProbe: Partial<MachineProbe> = {
    ...probe,
    run: async (command, args) => {
      if (command === "ss") return { ok: true, stdout: "LISTEN 0 4096 0.0.0.0:51821 0.0.0.0:*\n" };
      if (command === "docker" && args[0] === "ps") {
        return {
          ok: true,
          stdout: JSON.stringify({
            ID: "c1",
            Image: "ghcr.io/wg-easy/wg-easy",
            Names: "wg-easy",
            Ports: "0.0.0.0:51820->51820/udp, 0.0.0.0:51821->51821/tcp",
            State: "running",
          }),
        };
      }
      return { ok: false, stdout: "" };
    },
  };
  return Effect.gen(function* () {
    const service = yield* MachineAppsService;
    const shown = yield* service.action({ appId: "docker:wg-easy", action: "publish" });
    assert.deepStrictEqual(
      calls.filter((c) => c.method === "POST").map((c) => c.body),
      [
        { port: 51821, protocol: "tcp", visibility: "public" },
        { port: 51820, protocol: "udp", visibility: "public" },
      ],
    );
    const vpn = shown.apps.find((a) => a.id === "docker:wg-easy");
    assert.strictEqual(vpn?.publication?.forwards.length, 2);
    yield* service.action({ appId: "docker:wg-easy", action: "unpublish" });
    assert.strictEqual(calls.filter((c) => c.method === "DELETE").length, 2);
  }).pipe(
    Effect.provide(
      serviceLayer({ ownBoxId: 42, boxToken: "uno_agt_machine", calls, probe: dockerProbe }),
    ),
  );
});

it.effect("refuses to publish an app that only listens on 127.0.0.1", () => {
  const calls: Call[] = [];
  return Effect.gen(function* () {
    const service = yield* MachineAppsService;
    const exit = yield* Effect.exit(service.action({ appId: "port:8787", action: "publish" }));
    assert.ok(Exit.isFailure(exit));
    assert.ok(String(JSON.stringify(exit)).includes("127.0.0.1"));
    assert.ok(!calls.some((c) => c.method === "POST"));
  }).pipe(Effect.provide(serviceLayer({ ownBoxId: 42, boxToken: "uno_agt_machine", calls })));
});

it.effect("never acts on an id the scan did not find", () => {
  const calls: Call[] = [];
  return Effect.gen(function* () {
    const service = yield* MachineAppsService;
    for (const appId of ["port:22", "port:80", "docker:../../etc", "systemd:ssh.service"]) {
      const exit = yield* Effect.exit(service.action({ appId, action: "unpublish" }));
      assert.ok(Exit.isFailure(exit), appId);
    }
    assert.ok(!calls.some((c) => c.method === "DELETE" || c.method === "POST"));
  }).pipe(Effect.provide(serviceLayer({ ownBoxId: 42, boxToken: "uno_agt_machine", calls })));
});

it.effect("says why publishing can't work on a laptop, without calling the cloud", () => {
  const calls: Call[] = [];
  return Effect.gen(function* () {
    const service = yield* MachineAppsService;
    const listed = yield* service.list;
    assert.strictEqual(listed.publishBlockedReason, PUBLISH_NOT_A_COMPUTER);
    const exit = yield* Effect.exit(service.action({ appId: "port:3000", action: "publish" }));
    assert.ok(Exit.isFailure(exit));
    assert.deepStrictEqual(calls, []);
  }).pipe(Effect.provide(serviceLayer({ ownBoxId: null, calls })));
});

it.effect("does not send the gateway key to the console", () => {
  const calls: Call[] = [];
  return Effect.gen(function* () {
    const service = yield* MachineAppsService;
    const listed = yield* service.list;
    assert.ok(listed.publishBlockedReason !== null);
    assert.deepStrictEqual(calls, []);
  }).pipe(Effect.provide(serviceLayer({ ownBoxId: 42, apiKey: "unollm_x", calls })));
});

it.effect("reads live load of this machine", () =>
  Effect.gen(function* () {
    const service = yield* MachineAppsService;
    const metrics = yield* service.localMetrics;
    assert.ok(metrics.memTotalMb > 0);
    assert.ok(metrics.cpuCount > 0);
    assert.ok(metrics.cpuPct === null || (metrics.cpuPct >= 0 && metrics.cpuPct <= 100));
  }).pipe(Effect.provide(serviceLayer({ ownBoxId: null }))),
);

it("starts apps with a clean environment, not the daemon's", () => {
  process.env["UNO_SECRET_FOR_TEST"] = "leak";
  const env = appEnvironment("/home/unowork", 3000);
  delete process.env["UNO_SECRET_FOR_TEST"];
  assert.strictEqual(env["PORT"], "3000");
  assert.strictEqual(env["HOME"], "/home/unowork");
  assert.strictEqual(env["UNO_SECRET_FOR_TEST"], undefined);
});

function dockerProbeWith(
  containers: Array<{ name: string; port: number; project?: string }>,
  commands: string[][],
): Partial<MachineProbe> {
  const live = [...containers];
  return {
    ...probe,
    run: async (command, args) => {
      commands.push([command, ...args]);
      if (command === "ss") return { ok: true, stdout: "" };
      if (command === "docker" && args[0] === "ps") {
        return {
          ok: true,
          stdout: live
            .map((c) =>
              JSON.stringify({
                ID: c.name,
                Image: "img",
                Names: c.name,
                Ports: `0.0.0.0:${c.port}->${c.port}/tcp`,
                State: "running",
                Labels: c.project ? `com.docker.compose.project=${c.project}` : "",
              }),
            )
            .join("\n"),
        };
      }
      if (command === "docker" && args[0] === "rm") {
        const index = live.findIndex((c) => c.name === args[2]);
        if (index >= 0) live.splice(index, 1);
        return { ok: true, stdout: "" };
      }
      return { ok: false, stdout: "" };
    },
  };
}

it.effect("removes a container the person started, keeping its volumes", () => {
  const commands: string[][] = [];
  return Effect.gen(function* () {
    const service = yield* MachineAppsService;
    const after = yield* service.action({ appId: "docker:my-bot", action: "remove" });
    const rm = commands.find((c) => c[0] === "docker" && c[1] === "rm");
    assert.deepStrictEqual(rm, ["docker", "rm", "-f", "my-bot"]);
    assert.ok(!after.apps.some((a) => a.id === "docker:my-bot"));
  }).pipe(
    Effect.provide(
      serviceLayer({
        ownBoxId: 42,
        boxToken: "uno_agt_machine",
        probe: dockerProbeWith([{ name: "my-bot", port: 7000, project: "bots" }], commands),
        storeApps: [],
      }),
    ),
  );
});

it.effect("never removes an App Store app's container or Uno's own from here", () => {
  const commands: string[][] = [];
  return Effect.gen(function* () {
    const service = yield* MachineAppsService;
    for (const appId of ["docker:notes-web", "docker:uno-memos-memos-1", "port:3000"]) {
      const exit = yield* Effect.exit(service.action({ appId, action: "remove" }));
      assert.ok(Exit.isFailure(exit), appId);
    }
    assert.ok(!commands.some((c) => c[0] === "docker" && c[1] === "rm"));
  }).pipe(
    Effect.provide(
      serviceLayer({
        ownBoxId: 42,
        boxToken: "uno_agt_machine",
        probe: dockerProbeWith(
          [
            // The console says this project is an App Store app's, whatever its name.
            { name: "notes-web", port: 8430, project: "notetaker" },
            { name: "uno-memos-memos-1", port: 5230, project: "uno-memos" },
          ],
          commands,
        ),
        storeApps: [{ deployment_id: 9, template_id: "notetaker", compose_project: "notetaker" }],
      }),
    ),
  );
});

it.effect("the regular refresh asks systemd for its units at most every 30 s", () => {
  const systemctl: string[] = [];
  const counting: Partial<MachineProbe> = {
    ...probe,
    run: async (command, args) => {
      if (command === "systemctl") systemctl.push(args.join(" "));
      return command === "ss" ? { ok: true, stdout: SS } : { ok: false, stdout: "" };
    },
  };
  const realNow = Date.now;
  let now = realNow();
  const listUnitFiles = () => systemctl.filter((a) => a.includes("list-unit-files")).length;
  return Effect.gen(function* () {
    Date.now = () => now;
    const service = yield* MachineAppsService;
    yield* service.list;
    const first = listUnitFiles();
    assert.isAbove(first, 0);
    // The screen refreshes every 5 s: past the 4 s scan cache, inside 30 s.
    for (let i = 0; i < 4; i++) {
      now += 5_000;
      yield* service.list;
    }
    assert.strictEqual(listUnitFiles(), first);
    now += 30_000;
    yield* service.list;
    assert.strictEqual(listUnitFiles(), first * 2);
  }).pipe(
    Effect.ensuring(Effect.sync(() => (Date.now = realNow))),
    Effect.provide(serviceLayer({ ownBoxId: 42, probe: counting })),
  );
});

/* ------------------------------------------------------------------ *
 * Removing an app an AI built here (registered in ~/.uno/apps), Hide
 * ------------------------------------------------------------------ */

async function registeredAppHome(manifest: Record<string, unknown>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "uno-remove-app-"));
  const home = path.join(root, "home");
  const manifestDir = path.join(home, ".uno", "apps");
  const keysDir = path.join(home, ".uno", "app-keys");
  const codeDir = path.join(home, "projects", "notes");
  const unitDir = path.join(home, ".config", "systemd", "user");
  await mkdir(manifestDir, { recursive: true });
  await mkdir(path.join(keysDir, "notes"), { recursive: true });
  await mkdir(codeDir, { recursive: true });
  await mkdir(unitDir, { recursive: true });
  await writeFile(path.join(codeDir, "server.js"), "// notes\n");
  await writeFile(path.join(manifestDir, "notes.json"), JSON.stringify(manifest));
  await writeFile(path.join(manifestDir, "notes.png"), "png");
  await writeFile(path.join(manifestDir, "notes.log"), "started\n");
  await writeFile(path.join(keysDir, "notes", "token"), "uno_app_x\n");
  await writeFile(
    path.join(unitDir, "notes-digest.service"),
    "[Service]\nExecStart=/usr/bin/node digest.js\n",
  );
  await writeFile(path.join(unitDir, "notes-digest.timer"), "[Timer]\nOnCalendar=daily\n");
  await writeFile(
    path.join(unitDir, "other.service"),
    "[Service]\nExecStart=/usr/bin/node other.js\n",
  );
  return { root, home, manifestDir, keysDir, codeDir, unitDir };
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

function registeredProbe(commands: string[][]): Partial<MachineProbe> {
  return {
    ...probe,
    run: async (command, args) => {
      commands.push([command, ...args]);
      return command === "ss" ? { ok: true, stdout: SS } : { ok: false, stdout: "" };
    },
  };
}

const NOTES = {
  name: "Notes",
  icon: "notes.png",
  port: 3000,
  command: "node server.js",
  cwd: "~/projects/notes",
  ai: { chat: true },
  storage: true,
};

it.effect(
  "removes an app an AI built here: stops it, its units and files go, the code stays",
  () => {
    const commands: string[][] = [];
    const stopped: number[] = [];
    const uid = process.getuid?.() ?? 0;
    let dirs: Awaited<ReturnType<typeof registeredAppHome>>;
    return Effect.gen(function* () {
      dirs = yield* Effect.promise(() => registeredAppHome(NOTES));
      const layer = serviceLayer({
        ownBoxId: 42,
        boxToken: "uno_agt_machine",
        probe: registeredProbe(commands),
        storeApps: [],
        options: {
          home: dirs.home,
          manifestDir: dirs.manifestDir,
          keysDir: dirs.keysDir,
          processTable: async () => [
            // The app, listening on its port.
            { pid: 1234, ppid: 1, uid, comm: "node", cwd: dirs.codeDir, appMarker: null },
            // Its worker, started by the daemon (marked).
            { pid: 1300, ppid: 1, uid, comm: "python3", cwd: dirs.home, appMarker: "notes" },
            // A terminal of Uno Work sitting in the app's folder: never.
            {
              pid: 2000,
              ppid: process.pid,
              uid,
              comm: "bash",
              cwd: dirs.codeDir,
              appMarker: null,
            },
            // Something else of the person's: never.
            { pid: 3000, ppid: 1, uid, comm: "node", cwd: dirs.home, appMarker: null },
          ],
          stopProcesses: async (pids) => {
            stopped.push(...pids);
            return [];
          },
        },
      });
      yield* Effect.gen(function* () {
        const service = yield* MachineAppsService;
        const before = yield* service.list;
        const notes = before.apps.find((a) => a.id === "manifest:notes");
        assert.strictEqual(notes?.canRemove, true);
        assert.strictEqual(notes?.codeDir, "~/projects/notes");
        assert.strictEqual(notes?.codeDirKeepReason, null);

        const after = yield* service.action({ appId: "manifest:notes", action: "remove" });
        assert.ok(!after.apps.some((a) => a.id === "manifest:notes"));
      }).pipe(Effect.provide(layer));

      assert.deepStrictEqual(stopped, [1234, 1300]);
      assert.ok(
        commands.some(
          (c) =>
            c.join(" ") ===
            "systemctl --user disable --now notes-digest.service notes-digest.timer",
        ),
      );
      for (const gone of [
        path.join(dirs.manifestDir, "notes.json"),
        path.join(dirs.manifestDir, "notes.png"),
        path.join(dirs.manifestDir, "notes.log"),
        path.join(dirs.keysDir, "notes"),
        path.join(dirs.unitDir, "notes-digest.service"),
        path.join(dirs.unitDir, "notes-digest.timer"),
      ]) {
        assert.isFalse(yield* Effect.promise(() => exists(gone)), gone);
      }
      assert.isTrue(yield* Effect.promise(() => exists(path.join(dirs.unitDir, "other.service"))));
      assert.isTrue(
        yield* Effect.promise(() => exists(path.join(dirs.codeDir, "server.js"))),
        "the code stays unless asked",
      );
    }).pipe(Effect.ensuring(Effect.promise(() => rm(dirs.root, { recursive: true, force: true }))));
  },
);

it.effect("deletes the code folder only when asked", () => {
  let dirs: Awaited<ReturnType<typeof registeredAppHome>>;
  return Effect.gen(function* () {
    dirs = yield* Effect.promise(() => registeredAppHome(NOTES));
    yield* Effect.gen(function* () {
      const service = yield* MachineAppsService;
      yield* service.action({ appId: "manifest:notes", action: "remove", deleteCode: true });
    }).pipe(
      Effect.provide(
        serviceLayer({
          ownBoxId: 42,
          boxToken: "uno_agt_machine",
          probe: registeredProbe([]),
          storeApps: [],
          options: {
            home: dirs.home,
            manifestDir: dirs.manifestDir,
            keysDir: dirs.keysDir,
            processTable: async () => [],
            stopProcesses: async () => [],
          },
        }),
      ),
    );
    assert.isFalse(yield* Effect.promise(() => exists(dirs.codeDir)));
    assert.isTrue(yield* Effect.promise(() => exists(path.join(dirs.home, "projects"))));
  }).pipe(Effect.ensuring(Effect.promise(() => rm(dirs.root, { recursive: true, force: true }))));
});

it.effect(
  "an app running from home: home is never deleted, and nothing is stopped for being in it",
  () => {
    const stopped: number[] = [];
    const uid = process.getuid?.() ?? 0;
    let dirs: Awaited<ReturnType<typeof registeredAppHome>>;
    return Effect.gen(function* () {
      dirs = yield* Effect.promise(() => registeredAppHome({ ...NOTES, cwd: "~" }));
      const layer = serviceLayer({
        ownBoxId: 42,
        boxToken: "uno_agt_machine",
        probe: registeredProbe([]),
        storeApps: [],
        options: {
          home: dirs.home,
          manifestDir: dirs.manifestDir,
          keysDir: dirs.keysDir,
          processTable: async () => [
            { pid: 1234, ppid: 1, uid, comm: "node", cwd: dirs.home, appMarker: null },
            { pid: 3000, ppid: 1, uid, comm: "node", cwd: dirs.home, appMarker: null },
          ],
          stopProcesses: async (pids) => {
            stopped.push(...pids);
            return [];
          },
        },
      });
      yield* Effect.gen(function* () {
        const service = yield* MachineAppsService;
        const listed = yield* service.list;
        const notes = listed.apps.find((a) => a.id === "manifest:notes");
        assert.strictEqual(notes?.codeDir, "~");
        assert.match(notes?.codeDirKeepReason ?? "", /home folder/);
        const refused = yield* Effect.exit(
          service.action({ appId: "manifest:notes", action: "remove", deleteCode: true }),
        );
        assert.ok(Exit.isFailure(refused));
        assert.deepStrictEqual(stopped, []);
        yield* service.action({ appId: "manifest:notes", action: "remove" });
      }).pipe(Effect.provide(layer));
      // Only the listener on its port.
      assert.deepStrictEqual(stopped, [1234]);
      assert.isTrue(yield* Effect.promise(() => exists(path.join(dirs.codeDir, "server.js"))));
    }).pipe(Effect.ensuring(Effect.promise(() => rm(dirs.root, { recursive: true, force: true }))));
  },
);

it.effect("an App Store app's own manifest is removed from its card, not from here", () => {
  let dirs: Awaited<ReturnType<typeof registeredAppHome>>;
  return Effect.gen(function* () {
    dirs = yield* Effect.promise(() => registeredAppHome(NOTES));
    yield* Effect.gen(function* () {
      const service = yield* MachineAppsService;
      const exit = yield* Effect.exit(
        service.action({ appId: "manifest:notes", action: "remove" }),
      );
      assert.ok(Exit.isFailure(exit));
    }).pipe(
      Effect.provide(
        serviceLayer({
          ownBoxId: 42,
          boxToken: "uno_agt_machine",
          probe: registeredProbe([]),
          storeApps: [{ deployment_id: 9, template_id: "notes" }],
          options: {
            home: dirs.home,
            manifestDir: dirs.manifestDir,
            keysDir: dirs.keysDir,
            processTable: async () => [],
            stopProcesses: async () => [],
          },
        }),
      ),
    );
    assert.isTrue(yield* Effect.promise(() => exists(path.join(dirs.manifestDir, "notes.json"))));
  }).pipe(Effect.ensuring(Effect.promise(() => rm(dirs.root, { recursive: true, force: true }))));
});

it.effect("Hide takes a found program off Home and remembers it; Show brings it back", () => {
  let root = "";
  return Effect.gen(function* () {
    root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "uno-hidden-")));
    const hiddenPath = path.join(root, "machine-apps-hidden.json");
    const layer = () =>
      serviceLayer({ ownBoxId: 42, boxToken: "uno_agt_machine", options: { hiddenPath } });
    yield* Effect.gen(function* () {
      const service = yield* MachineAppsService;
      const after = yield* service.action({ appId: "port:3000", action: "hide" });
      assert.strictEqual(after.apps.find((a) => a.id === "port:3000")?.hidden, true);
      assert.strictEqual(after.apps.find((a) => a.id === "port:8787")?.hidden, false);
      const gone = yield* Effect.exit(service.action({ appId: "port:9999", action: "hide" }));
      assert.ok(Exit.isFailure(gone));
    }).pipe(Effect.provide(layer()));
    // A restarted daemon still knows.
    yield* Effect.gen(function* () {
      const service = yield* MachineAppsService;
      const listed = yield* service.list;
      assert.strictEqual(listed.apps.find((a) => a.id === "port:3000")?.hidden, true);
      const shown = yield* service.action({ appId: "port:3000", action: "unhide" });
      assert.strictEqual(shown.apps.find((a) => a.id === "port:3000")?.hidden, false);
    }).pipe(Effect.provide(layer()));
  }).pipe(Effect.ensuring(Effect.promise(() => rm(root, { recursive: true, force: true }))));
});
