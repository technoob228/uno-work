/**
 * "A file in this project was saved": one callback per change, cheap enough
 * to leave on for every project that syncs. macOS and Windows watch the tree
 * natively (one handle); elsewhere (Linux: one inotify watch per folder) the
 * folders are walked — skipping what never syncs (node_modules, builds, .git)
 * and at most MAX_WATCHED_DIRS of them — and walked again when a folder is
 * added.
 *
 * @module projectSync/folderWatch
 */
import { watch, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

/** Folders that never sync: changes inside them don't start a sync. */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".uno-git",
  "node_modules",
  ".pnpm-store",
  "bower_components",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".tox",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".output",
  ".turbo",
  ".parcel-cache",
  ".cache",
  "coverage",
  "target",
  ".gradle",
]);

export const MAX_WATCHED_DIRS = 2_000;

/** A changed path (relative) that can matter for sync. */
export function changeMatters(relative: string | null): boolean {
  if (!relative) return true;
  const parts = relative.split(/[\\/]/);
  if (parts.some((part) => SKIPPED_DIRS.has(part))) return false;
  const base = parts.at(-1) ?? "";
  // Keys (never synced; Uno writes them itself), editors' swap/backup files, the OS's own.
  return !/^(\.env.*|\.DS_Store|.*\.swp|.*~|\.#.*|#.*#)$/.test(base);
}

async function walk(root: string, limit: number): Promise<string[]> {
  const out: string[] = [root];
  for (let index = 0; index < out.length && out.length < limit; index += 1) {
    const dir = out[index]!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIPPED_DIRS.has(entry.name)) continue;
      out.push(path.join(dir, entry.name));
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Watch `root`; returns a stop function. Never throws (a folder that can't be watched just isn't). */
export function watchProjectFolder(
  root: string,
  onChange: (relative: string | null) => void,
  options: { readonly platform?: NodeJS.Platform } = {},
): () => void {
  const platform = options.platform ?? process.platform;
  const watchers = new Map<string, FSWatcher>();
  let stopped = false;
  const fire = (relative: string | null) => {
    if (!stopped && changeMatters(relative)) onChange(relative);
  };
  if (platform === "darwin" || platform === "win32") {
    try {
      const watcher = watch(root, { recursive: true, persistent: false }, (_event, file) =>
        fire(file ? String(file) : null),
      );
      watcher.on("error", () => undefined);
      watchers.set(root, watcher);
    } catch {
      // not watchable: polling and turn ends still sync it
    }
    return () => {
      stopped = true;
      for (const watcher of watchers.values()) watcher.close();
    };
  }
  let rescan: ReturnType<typeof setTimeout> | null = null;
  const sync = async () => {
    const dirs = new Set(await walk(root, MAX_WATCHED_DIRS));
    if (stopped) return;
    for (const [dir, watcher] of watchers) {
      if (!dirs.has(dir)) {
        watcher.close();
        watchers.delete(dir);
      }
    }
    for (const dir of dirs) {
      if (watchers.has(dir)) continue;
      try {
        const watcher = watch(dir, { persistent: false }, (event, file) => {
          const relative = path.relative(root, path.join(dir, file ? String(file) : ""));
          fire(relative || null);
          // A new folder: watch inside it too (debounced).
          if (event === "rename" && !rescan) {
            rescan = setTimeout(() => {
              rescan = null;
              void sync();
            }, 1_000);
          }
        });
        watcher.on("error", () => undefined);
        watchers.set(dir, watcher);
      } catch {
        // gone meanwhile, or out of watches: the rest still works
      }
    }
  };
  void sync();
  return () => {
    stopped = true;
    if (rescan) clearTimeout(rescan);
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  };
}
