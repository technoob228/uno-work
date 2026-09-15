import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Exit, Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { BUN_SCRATCH_DIR_PREFIX, withBunScratchDir } from "./bunScratchDir.ts";

const parents: string[] = [];
function makeParent(): string {
  const dir = mkdtempSync(join(tmpdir(), "bun-scratch-test-"));
  parents.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of parents.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("withBunScratchDir", () => {
  it("points BUN_TMPDIR at a fresh directory and removes it with the scope", async () => {
    const parentDir = makeParent();
    const scope = await Effect.runPromise(Scope.make());
    const env = await Effect.runPromise(
      withBunScratchDir({ PATH: "/usr/bin", TMPDIR: "/keep" }, { parentDir }).pipe(
        Effect.provideService(Scope.Scope, scope),
      ),
    );

    const dir = env.BUN_TMPDIR!;
    expect(dir.startsWith(join(parentDir, BUN_SCRATCH_DIR_PREFIX))).toBe(true);
    expect(env.PATH).toBe("/usr/bin");
    // The agent's own temp dir is not redirected.
    expect(env.TMPDIR).toBe("/keep");
    // What Bun extracts while the harness runs lives there…
    writeFileSync(join(dir, ".3bd7de8fe7fdfff0-00000000.so"), "lib");

    await Effect.runPromise(Scope.close(scope, Exit.void));

    // …and is gone once the process's scope closes.
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(parentDir)).toEqual([]);
  });

  it("leaves an explicit BUN_TMPDIR alone", async () => {
    const env = await Effect.runPromise(
      Effect.scoped(withBunScratchDir({ BUN_TMPDIR: "/custom" }, { parentDir: makeParent() })),
    );
    expect(env.BUN_TMPDIR).toBe("/custom");
  });

  it("still returns the environment when the directory cannot be created", async () => {
    const env = await Effect.runPromise(
      Effect.scoped(withBunScratchDir({ PATH: "/bin" }, { parentDir: "/nonexistent/uno" })),
    );
    expect(env).toEqual({ PATH: "/bin" });
  });
});
