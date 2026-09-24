/**
 * Programs the person hid from the home screen ("Hide"). Found programs — a
 * port, a docker container, a service without a manifest — are not Uno
 * Work's to delete, but the person may not want to see them: they stay
 * running and come back with "Show".
 *
 * Kept per machine, in the daemon's state folder (every browser looking at
 * this computer sees the same home screen): `machine-apps-hidden.json`,
 * `{"hidden": ["port:8080", "systemd:user:bot.service"]}`.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_HIDDEN = 500;

export interface HiddenApps {
  readonly has: (appId: string) => boolean;
  readonly set: (appId: string, hidden: boolean) => Promise<void>;
}

export function parseHiddenApps(text: string | null): Set<string> {
  if (!text) return new Set();
  try {
    const raw = JSON.parse(text) as unknown;
    const list =
      typeof raw === "object" && raw !== null && Array.isArray((raw as { hidden?: unknown }).hidden)
        ? ((raw as { hidden: unknown[] }).hidden as unknown[])
        : [];
    return new Set(
      list
        .filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200)
        .slice(0, MAX_HIDDEN),
    );
  } catch {
    return new Set();
  }
}

/** `file` null keeps the list in memory only (tests, a daemon without a state folder). */
export async function openHiddenApps(file: string | null): Promise<HiddenApps> {
  const hidden = file
    ? parseHiddenApps(await readFile(file, "utf8").catch(() => null))
    : new Set<string>();
  let writing: Promise<void> = Promise.resolve();
  const persist = () => {
    if (!file) return Promise.resolve();
    const body = `${JSON.stringify({ hidden: [...hidden].toSorted() }, null, 2)}\n`;
    writing = writing
      .catch(() => undefined)
      .then(async () => {
        await mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        await writeFile(tmp, body, { mode: 0o600 });
        await rename(tmp, file);
      });
    return writing;
  };
  return {
    has: (appId) => hidden.has(appId),
    set: async (appId, value) => {
      if (value === hidden.has(appId)) return;
      if (value) {
        if (hidden.size >= MAX_HIDDEN) return;
        hidden.add(appId);
      } else {
        hidden.delete(appId);
      }
      await persist();
    },
  };
}
