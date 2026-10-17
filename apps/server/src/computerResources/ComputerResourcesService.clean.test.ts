import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { MachineAppsService } from "../machineApps/MachineAppsService.ts";
import {
  ComputerResourcesService,
  makeComputerResourcesService,
} from "./ComputerResourcesService.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) {
    chmodSync(path.join(home, ".cache", "go-build", "busy"), 0o755);
    rmSync(home, { recursive: true, force: true });
  }
});

const machineApps = new Proxy({} as Record<string | symbol, unknown>, {
  get: () => Effect.succeed([]),
}) as unknown as MachineAppsService["Service"];

const clean = (home: string, id: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* ComputerResourcesService;
      return yield* Effect.result(service.clean({ id }));
    }).pipe(
      Effect.provide(
        Layer.effect(ComputerResourcesService, makeComputerResourcesService({ home })).pipe(
          Layer.provide(Layer.succeed(MachineAppsService, machineApps)),
        ),
      ),
    ),
  );

describe("clean", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "empties what it can when one entry is busy instead of reporting nothing",
    async () => {
      const home = mkdtempSync(path.join(os.tmpdir(), "uno-clean-"));
      homes.push(home);
      const cache = path.join(home, ".cache", "go-build");
      for (const name of ["00", "01", "02"]) {
        mkdirSync(path.join(cache, name), { recursive: true });
        writeFileSync(path.join(cache, name, "blob"), Buffer.alloc(2 * 1024 * 1024));
      }
      // An entry rm can't empty (like a file a running build holds).
      mkdirSync(path.join(cache, "busy"));
      writeFileSync(path.join(cache, "busy", "held"), "x");
      chmodSync(path.join(cache, "busy"), 0o555);

      const result = await clean(home, "go-cache");
      expect(result._tag).toBe("Success");
      if (result._tag === "Success") expect(result.success.freedBytes).toBeGreaterThan(0);
      expect(existsSync(path.join(cache, "00"))).toBe(false);
      expect(existsSync(path.join(cache, "busy", "held"))).toBe(true);
    },
  );
});
