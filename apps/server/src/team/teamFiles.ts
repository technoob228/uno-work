/**
 * The team workers' own records under `<stateDir>/team/` (cursors, what was
 * sent, what was told): small JSON files, written whole and atomically,
 * readable only by this user. Never a colleague's words or a key.
 *
 * @module team/teamFiles
 */
import * as crypto from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

export const teamDir = (stateDir: string) => path.join(stateDir, "team");

export async function readTeamFile<A>(
  stateDir: string,
  name: string,
  parse: (raw: unknown) => A,
): Promise<A> {
  const text = await fsp.readFile(path.join(teamDir(stateDir), name), "utf8").catch(() => null);
  if (text === null) return parse(null);
  try {
    return parse(JSON.parse(text));
  } catch {
    return parse(null);
  }
}

export async function writeTeamFile(stateDir: string, name: string, value: unknown): Promise<void> {
  const dir = teamDir(stateDir);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name);
  const temp = `${file}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await fsp.rename(temp, file);
}

export const asRecord = (raw: unknown): Record<string, unknown> =>
  raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};

export const asNumber = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

export const asStringMap = (value: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(asRecord(value))) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
};
