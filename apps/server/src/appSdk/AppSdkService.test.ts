import { Effect, Layer } from "effect";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { InboxService } from "../inbox/InboxService.ts";
import type { InboxPost, StoredInboxItem } from "../inbox/inboxModel.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { UnoGatewayKey, type UnoGatewayKeyShape, UnoGatewayKeyTest } from "../unoGatewayKey.ts";
import { makeAppApiHandler } from "./appApiHttp.ts";
import { cloudFoldersToDelete, makeAppSdkService } from "./AppSdkService.ts";

let root: string;
let home: string;
let appsDir: string;
let keysDir: string;
let posts: InboxPost[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "app-sdk-"));
  home = path.join(root, "home");
  appsDir = path.join(home, ".uno", "apps");
  keysDir = path.join(home, ".uno", "app-keys");
  await mkdir(appsDir, { recursive: true });
  posts = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const writeManifest = (id: string, body: unknown) =>
  writeFile(path.join(appsDir, `${id}.json`), JSON.stringify(body));

const run = <A>(
  body: (
    service: Effect.Success<ReturnType<typeof makeAppSdkService>>,
    gatewayKey: UnoGatewayKeyShape,
  ) => Promise<A>,
  {
    settings = {},
    ...extra
  }: {
    readonly fetch?: typeof fetch;
    readonly settings?: Parameters<typeof ServerSettingsService.layerTest>[0];
  } = {},
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* makeAppSdkService({
          home,
          manifestDir: appsDir,
          keysDir,
          storePath: path.join(root, "state", "app-ai.json"),
          port: null,
          background: false,
          ...extra,
        });
        const gatewayKey = yield* UnoGatewayKey;
        return yield* Effect.promise(() => body(service, gatewayKey));
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ServerConfig, {
              port: 80,
              stateDir: path.join(root, "state"),
            } as ServerConfigShape),
            ServerSettingsService.layerTest(settings),
            UnoGatewayKeyTest("unollm_machine"),
            Layer.mock(OrchestrationEngineService)({}),
            Layer.mock(ProjectionSnapshotQuery)({}),
            Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(InboxService)({
              post: (post) =>
                Effect.sync(() => {
                  posts.push(post);
                  return { id: `inb_${posts.length}` } as StoredInboxItem;
                }),
            }),
          ),
        ),
      ),
    ),
  );

const tokenOf = (id: string) =>
  readFile(path.join(keysDir, id, "token"), "utf8").then((t) => t.trim());

describe("AppSdkService", () => {
  it("gives a token only to apps whose manifest asks for AI, in a private folder", async () => {
    await writeManifest("notes", { name: "Notes", port: 3000, ai: { chat: true, limitUsd: 500 } });
    await writeManifest("plain", { name: "Plain", port: 3001 });
    await run(async (service) => {
      await service.sync();
      const token = await tokenOf("notes");
      expect(token.startsWith("uno_app_")).toBe(true);
      expect((await stat(path.join(keysDir, "notes"))).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(keysDir, "notes", "token"))).mode & 0o777).toBe(0o600);
      await expect(stat(path.join(keysDir, "plain"))).rejects.toThrow();
      const caller = await service.core.authenticate(token);
      expect(caller).toMatchObject({ appId: "notes", chat: true, tasks: false, limitUsd: 10 });
      const env = await readFile(path.join(keysDir, "notes", "env"), "utf8");
      expect(env).toContain(`UNO_APP_TOKEN=${token}`);
    });
  });

  it("the token dies with the manifest, and spending survives re-adding it", async () => {
    await writeManifest("notes", { name: "Notes", port: 3000, ai: { chat: true } });
    await run(async (service) => {
      await service.sync();
      const token = await tokenOf("notes");
      await service.core.charge("notes", 2.5);
      await rm(path.join(appsDir, "notes.json"));
      await service.sync();
      expect(await service.core.authenticate(token)).toBeNull();
      await expect(stat(path.join(keysDir, "notes", "token"))).rejects.toThrow();
      await writeManifest("notes", { name: "Notes", port: 3000, ai: { chat: true } });
      await service.sync();
      const fresh = await tokenOf("notes");
      expect(fresh).not.toBe(token);
      expect((await service.core.authenticate(fresh))?.spentUsd).toBe(2.5);
    });
  });

  it("revoke turns the app's AI off until the person allows it again", async () => {
    await writeManifest("notes", { name: "Notes", port: 3000, ai: { chat: true } });
    await run(async (service) => {
      await service.sync();
      const token = await tokenOf("notes");
      await Effect.runPromise(service.update({ appId: "notes", revoked: true }));
      await service.sync();
      expect(await service.core.authenticate(token)).toBeNull();
      await expect(stat(path.join(keysDir, "notes", "token"))).rejects.toThrow();
      // The folder stays, so a container's bind mount keeps working after "Turn AI back on".
      expect((await stat(path.join(keysDir, "notes"))).isDirectory()).toBe(true);
      const overview = await Effect.runPromise(service.overview);
      expect(overview.apps.find((a) => a.id === "notes")?.status).toBe("revoked");
      await Effect.runPromise(service.update({ appId: "notes", revoked: false }));
      await service.sync();
      expect(await service.core.authenticate(await tokenOf("notes"))).not.toBeNull();
    });
  });

  it("only the person can raise the limit above what a manifest may ask", async () => {
    await writeManifest("notes", { name: "Notes", port: 3000, ai: { chat: true, limitUsd: 2 } });
    await run(async (service) => {
      await service.sync();
      await service.core.charge("notes", 2);
      let overview = await Effect.runPromise(service.overview);
      expect(overview.apps[0]).toMatchObject({
        limitUsd: 2,
        status: "over-limit",
        limitSetByPerson: false,
      });
      overview = await Effect.runPromise(service.update({ appId: "notes", limitUsd: 25 }));
      expect(overview.apps[0]).toMatchObject({
        limitUsd: 25,
        status: "active",
        limitSetByPerson: true,
      });
      await expect(
        Effect.runPromise(service.update({ appId: "notes", limitUsd: -1 })),
      ).rejects.toThrow();
      await expect(
        Effect.runPromise(service.update({ appId: "ghost", limitUsd: 1 })),
      ).rejects.toThrow();
    });
  });

  it("an app that asks only for cloud storage gets a token, no AI, and a storage limit", async () => {
    await writeManifest("album", { name: "Album", port: 3002, storage: { limitGb: 500 } });
    await run(async (service) => {
      await service.sync();
      const caller = await service.core.authenticate(await tokenOf("album"));
      // A manifest may ask for at most 20 GB; no AI without an "ai" block.
      expect(caller).toMatchObject({
        appId: "album",
        chat: false,
        tasks: false,
        storage: { limitBytes: 20 * 1024 ** 3 },
      });
      let overview = await Effect.runPromise(service.overview);
      expect(overview.apps[0]).toMatchObject({
        id: "album",
        status: "active",
        storage: { limitBytes: 20 * 1024 ** 3, limitSetByPerson: false, prefix: "album/" },
      });
      overview = await Effect.runPromise(service.update({ appId: "album", storageLimitGb: 100 }));
      expect(overview.apps[0]?.storage).toMatchObject({
        limitBytes: 100 * 1024 ** 3,
        limitSetByPerson: true,
      });
      await expect(
        Effect.runPromise(service.update({ appId: "album", storageLimitGb: 0 })),
      ).rejects.toThrow();
      // Dropping "storage" from the manifest takes the token away.
      await writeManifest("album", { name: "Album", port: 3002 });
      await service.sync();
      await expect(stat(path.join(keysDir, "album", "token"))).rejects.toThrow();
    });
  });

  it("keeps an app's files in this computer's own cloud folder when the person says so", async () => {
    await writeManifest("album", { name: "Album", port: 3002, storage: true });
    await run(
      async (service) => {
        await service.sync();
        const token = await tokenOf("album");
        expect((await service.core.authenticate(token))?.storage?.folder).toBe("album/");
        let overview = await Effect.runPromise(service.overview);
        expect(overview.apps[0]?.storage).toMatchObject({ scope: "account", prefix: "album/" });

        overview = await Effect.runPromise(
          service.update({ appId: "album", storageScope: "computer" }),
        );
        expect(overview.apps[0]?.storage).toMatchObject({
          scope: "computer",
          prefix: "album@computer-1920/",
        });
        // Same token, other folder: the app itself knows nothing about it.
        expect((await service.core.authenticate(token))?.storage?.folder).toBe(
          "album@computer-1920/",
        );
      },
      { settings: { uno: { boxId: 1920 } } },
    );
    // Remembered across restarts; off an Uno computer the folder gets a stable local name.
    await run(async (service) => {
      const first = await Effect.runPromise(service.overview);
      const prefix = first.apps[0]?.storage?.prefix ?? "";
      expect(prefix).toMatch(/^album@local-[0-9a-f]{12}\/$/);
      expect((await Effect.runPromise(service.overview)).apps[0]?.storage?.prefix).toBe(prefix);
    });
  });

  it("deleting an app's cloud files still works once its manifest is gone", async () => {
    await writeManifest("album", { name: "Album", port: 3002, storage: true });
    await run(async (service) => {
      await service.sync();
      await rm(path.join(appsDir, "album.json"));
      await service.sync();
      // Other changes need the app; deleting its files doesn't. With no Uno
      // account on this test computer, it reaches the cloud step and says why.
      await expect(
        Effect.runPromise(service.update({ appId: "album", storageScope: "computer" })),
      ).rejects.toThrow(/isn't on this computer/);
      await expect(
        Effect.runPromise(service.update({ appId: "album", deleteCloudFiles: true })),
      ).rejects.toThrow(/Couldn't delete the app's files in the cloud/);
      await expect(
        Effect.runPromise(service.update({ appId: "ghost", deleteCloudFiles: true })),
      ).rejects.toThrow(/isn't on this computer/);
    });
  });

  it("a token file tampered on disk is replaced, the old one stops working", async () => {
    await writeManifest("notes", { name: "Notes", port: 3000, ai: { chat: true } });
    await run(async (service) => {
      await service.sync();
      await writeFile(path.join(keysDir, "notes", "token"), "uno_app_guess\n");
      await service.sync();
      expect(await service.core.authenticate("uno_app_guess")).toBeNull();
      expect(await service.core.authenticate(await tokenOf("notes"))).not.toBeNull();
    });
  });
  it("what an app's tasks spend on the gateway counts against its limit; then new tasks are refused", async () => {
    await writeManifest("digest", {
      name: "Digest",
      port: 3000,
      ai: { chat: true, tasks: true, limitUsd: 1 },
    });
    let gatewayTotal = 0.4;
    const asked: string[] = [];
    const fakeGateway = (async (url: string) => {
      asked.push(String(url));
      return Response.json({ object: "list", data: [{ app: "digest", cost_usd: gatewayTotal }] });
    }) as typeof fetch;
    await mkdir(path.join(root, "state"), { recursive: true });
    // The app already gave a job (as if before a restart): its thread keeps the label.
    await writeFile(
      path.join(root, "state", "app-ai.json"),
      JSON.stringify({
        version: 1,
        apps: {
          digest: {
            tasksStarted: 1,
            spentUsd: 0.25,
            tasks: [
              {
                id: "task_1",
                threadId: "thread-1",
                createdAt: "2026-09-23T00:00:00.000Z",
                tools: "edit",
                harness: "uno",
                turnCountAtStart: 0,
              },
            ],
          },
        },
      }),
    );
    await run(
      async (service, gatewayKey) => {
        expect(gatewayKey.appOfThread("thread-1")).toBe("digest");
        await service.sync();
        const token = await tokenOf("digest");
        const caller = await service.core.authenticate(token);
        expect(asked[0]).toMatch(/\/usage\/apps$/);
        expect(caller).toMatchObject({ spentUsd: 0.65, tasksSpentUsd: 0.4 });
        let overview = await Effect.runPromise(service.overview);
        expect(overview.taskSpend).toBe("metered");
        expect(overview.apps[0]).toMatchObject({
          spentUsd: 0.65,
          chatSpentUsd: 0.25,
          tasksSpentUsd: 0.4,
          status: "active",
        });

        // The task keeps working and the gateway total grows past the limit.
        gatewayTotal = 0.9;
        await service.taskMeter.refresh(0);
        overview = await Effect.runPromise(service.overview);
        expect(overview.apps[0]).toMatchObject({ tasksSpentUsd: 0.9, status: "over-limit" });

        const handler = makeAppApiHandler(service.core);
        const reply = await callHandler(handler, token, "POST", "/v1/tasks", { prompt: "again" });
        expect(reply.status).toBe(402);
        expect(JSON.parse(reply.body).error.code).toBe("app_limit_reached");

        // Reset zeroes the ledger; only new gateway growth counts from here.
        await Effect.runPromise(service.update({ appId: "digest", resetSpent: true }));
        gatewayTotal = 1.0;
        await service.taskMeter.refresh(0);
        overview = await Effect.runPromise(service.overview);
        expect(overview.apps[0]?.tasksSpentUsd).toBeCloseTo(0.1);
        expect(overview.apps[0]?.status).toBe("active");
      },
      { fetch: fakeGateway },
    );
  });

  it("an older gateway without per-app totals: tasks aren't counted, and Settings says so", async () => {
    await writeManifest("digest", { name: "Digest", port: 3000, ai: { tasks: true } });
    await mkdir(path.join(root, "state"), { recursive: true });
    await writeFile(
      path.join(root, "state", "app-ai.json"),
      JSON.stringify({ version: 1, apps: { digest: { tasksStarted: 1 } } }),
    );
    await run(
      async (service) => {
        await service.sync();
        const overview = await Effect.runPromise(service.overview);
        expect(overview.taskSpend).toBe("unavailable");
        expect(overview.apps[0]?.tasksSpentUsd).toBe(0);
      },
      {
        fetch: (async () =>
          new Response("404 page not found", { status: 404 })) as unknown as typeof fetch,
      },
    );
  });

  it("an app with notify in its manifest puts notifications into the Inbox; others get 403", async () => {
    await writeManifest("office-bot", {
      name: "Office bot",
      icon: "📝",
      port: 3002,
      notify: true,
    });
    await writeManifest("quiet", { name: "Quiet", port: 3003, ai: { chat: true } });
    await run(async (service) => {
      await service.sync();
      const handler = makeAppApiHandler(service.core);
      const token = await tokenOf("office-bot");
      const ok = await callHandler(handler, token, "POST", "/v1/notify", {
        title: "Boris commented on report.docx",
        body: "Can we add October numbers?",
        open: { file: "~/Documents/report.docx" },
        group: "report",
      });
      expect(ok.status).toBe(201);
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({
        kind: "app",
        source: { kind: "app", id: "office-bot", name: "Office bot", icon: "📝" },
        title: "Boris commented on report.docx",
        open: { kind: "file", path: path.join(home, "Documents", "report.docx") },
        groupKey: "app:office-bot:report",
      });

      const outside = await callHandler(handler, token, "POST", "/v1/notify", {
        title: "x",
        open: { file: "/etc/passwd" },
      });
      expect(outside.status).toBe(400);

      const quiet = await callHandler(handler, await tokenOf("quiet"), "POST", "/v1/notify", {
        title: "hi",
      });
      expect(quiet.status).toBe(403);
      expect(JSON.parse(quiet.body).error.code).toBe("notify_not_allowed");

      // A burst is capped: after 10, the app is told to wait.
      let last = 0;
      for (let index = 0; index < 12; index += 1) {
        last = (await callHandler(handler, token, "POST", "/v1/notify", { title: `n${index}` }))
          .status;
      }
      expect(last).toBe(429);
    });
  });
});

/** One request through the App API handler, without a socket. */
async function callHandler(
  handler: ReturnType<typeof makeAppApiHandler>,
  token: string,
  method: string,
  url: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  const { PassThrough } = await import("node:stream");
  const req = Object.assign(new PassThrough(), {
    method,
    url,
    headers: { authorization: `Bearer ${token}`, host: "127.0.0.1" },
  });
  let status = 0;
  let out = "";
  const done = new Promise<void>((resolve) => {
    const res = {
      headersSent: false,
      writeHead: (code: number) => {
        status = code;
        return res;
      },
      setHeader: () => res,
      end: (chunk?: string) => {
        out += chunk ?? "";
        resolve();
      },
    };
    void handler(req as never, res as never);
  });
  req.end(JSON.stringify(body));
  await done;
  return { status, body: out };
}

describe("cloudFoldersToDelete", () => {
  it("empties the folder in use and this computer's own, never another computer's", () => {
    expect(cloudFoldersToDelete("album", "account", "computer-7")).toEqual([
      "album/",
      "album@computer-7/",
    ]);
    // "Only this computer": the shared folder may be other computers' — it stays.
    expect(cloudFoldersToDelete("album", "computer", "computer-7")).toEqual(["album@computer-7/"]);
  });
});
