/**
 * A throwaway `BUN_TMPDIR` for one harness process.
 *
 * OpenCode and Uno Code ship as `bun build --compile` binaries with a native
 * library embedded (the Zig-built `libopentui`). Every time such a binary
 * loads it, Bun writes the library out to its temp directory under a fresh
 * name (`.<hash>-00000000.so`, ~4.7 MB) and never deletes it — not on a clean
 * exit, not on SIGTERM. The daemon probes each harness every five minutes by
 * starting `serve`, so a Work box grew roughly 1.4 GB of these a day in
 * `/var/lib/uno-work/tmp` until the disk filled (and every desktop's `$TMPDIR`
 * collects them the same way).
 *
 * Bun honours `BUN_TMPDIR` for that extraction, separately from `TMPDIR`, so
 * pointing it at a directory we own and removing the directory when the
 * process's scope closes keeps the extraction without the leak. Only Bun reads
 * the variable: temp files of the agent's own tools still go to `TMPDIR`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Scope } from "effect";

export const BUN_SCRATCH_DIR_PREFIX = "uno-bun-";

type Environment = NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>;

export interface BunScratchDirOptions {
  /** Parent directory; defaults to the daemon's own temp dir. */
  readonly parentDir?: string;
}

/**
 * Returns `environment` with `BUN_TMPDIR` pointing at a fresh directory that is
 * removed when the surrounding scope closes. An explicit `BUN_TMPDIR` in the
 * environment is left alone. Never fails: without a scratch directory the
 * harness still runs, it just leaks as before.
 */
export const withBunScratchDir = (
  environment: Environment,
  options: BunScratchDirOptions = {},
): Effect.Effect<Record<string, string | undefined>, never, Scope.Scope> => {
  const base: Record<string, string | undefined> = { ...environment };
  if (typeof base.BUN_TMPDIR === "string" && base.BUN_TMPDIR.length > 0) {
    return Effect.succeed(base);
  }
  return Effect.acquireRelease(
    Effect.sync((): string | null => {
      try {
        return mkdtempSync(join(options.parentDir ?? tmpdir(), BUN_SCRATCH_DIR_PREFIX));
      } catch {
        return null;
      }
    }),
    (dir) =>
      Effect.sync(() => {
        if (dir === null) return;
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Best effort: the box-level sweep removes what is left.
        }
      }),
  ).pipe(
    Effect.map((dir) => {
      if (dir !== null) base.BUN_TMPDIR = dir;
      return base;
    }),
  );
};
