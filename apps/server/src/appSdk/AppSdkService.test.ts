import { Effect, Layer } from "effect";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { UnoGatewayKeyTest } from "../unoGatewayKey.ts";
import { makeAppSdkService } from "./AppSdkService.ts";

let root: string;
let home: string;
let appsDir: string;
let keysDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "app-sdk-"));
  home = path.join(root, "home");
  appsDir = path.join(home, ".uno", "apps");
  keysDir = path.join(home, ".uno", "app-keys");
  await mkdir(appsDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const writeManifest = (id: string, body: unknown) =>
  writeFile(path.join(appsDir, `${id}.json`), JSON.stringify(body));

const run = <A>(
  body: (service: Effect.Success<ReturnType<typeof makeAppSdkService>>) => Promise<A>,
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
        });
        return yield* Effect.promise(() => body(service));
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ServerConfig, {
              port: 80,
              stateDir: path.join(root, "state"),
            } as ServerConfigShape),
            ServerSettingsService.layerTest({}),
            UnoGatewayKeyTest("unollm_machine"),
            Layer.mock(OrchestrationEngineService)({}),
            Layer.mock(ProjectionSnapshotQuery)({}),
            Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
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
});
