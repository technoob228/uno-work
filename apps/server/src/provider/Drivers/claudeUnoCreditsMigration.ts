/**
 * One-time upgrade for "Sign in / Use Uno credits" (28.10, Misha: "им
 * согласие заранее"): a machine where Claude Code already ran on the Uno
 * gateway before the question existed keeps working as it did — Uno credits
 * are allowed for it once, at the first start of this version. Every other
 * machine is asked.
 *
 * The evidence is local, on the machine itself: Claude Code's own session
 * transcripts (`<CLAUDE_CONFIG_DIR or ~/.claude>/projects/**\/*.jsonl`).
 * Work never recorded which way a turn went, but Claude Code records every
 * answer it got, and the two ways look different there:
 *
 *   - Anthropic (subscription / API key; Bedrock and Vertex too): message
 *     ids `msg_…`, request ids `req_…`;
 *   - the Uno gateway (fishcode `llm/anthropic.go`): the upstream id
 *     (OpenRouter `gen-…`) or `msg_uno…`, and no request id.
 *
 * Checked on a real machine (Mac, 28.09: `gen-179…` with no request id on
 * Work's `sdk-ts` sessions while Claude ran on Uno AI). Local error entries
 * (`model: "<synthetic>"`) carry neither and are skipped.
 *
 * Runs once per harness (`harnessUnoCreditsMigrated`); a choice already made
 * (`harnessUnoCredits[driver]` set either way) is never changed, so turning
 * it off in Settings stays off after any restart.
 *
 * @module provider/Drivers/claudeUnoCreditsMigration
 */
import * as NodeFs from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ServerSettings, ServerSettingsError, ServerSettingsPatch } from "@t3tools/contracts";
import { Effect } from "effect";

/** Newest transcripts first; a machine that used it recently is found at once. */
export const UNO_HISTORY_MAX_FILES = 1_000;
/**
 * The first answers of a session are enough (the way it ran shows on every
 * answer); at most ~64 MB read once, at the first start, in the background.
 */
export const UNO_HISTORY_MAX_BYTES_PER_FILE = 64 * 1024;

/** One parsed line of a Claude Code transcript: an answer that came over the Uno gateway. */
export function isUnoGatewayTranscriptRecord(record: unknown): boolean {
  if (typeof record !== "object" || record === null) return false;
  const entry = record as {
    readonly type?: unknown;
    readonly requestId?: unknown;
    readonly message?: { readonly id?: unknown; readonly model?: unknown } | null;
  };
  if (entry.type !== "assistant") return false;
  const id = typeof entry.message?.id === "string" ? entry.message.id : "";
  const model = typeof entry.message?.model === "string" ? entry.message.model : "";
  if (id.length === 0 || model === "<synthetic>") return false;
  if (id.startsWith("msg_uno")) return true;
  const requestId = typeof entry.requestId === "string" ? entry.requestId : "";
  return !id.startsWith("msg_") && !requestId.startsWith("req_");
}

/** Whether a transcript's text has an answer that came over the Uno gateway. */
export function transcriptShowsUnoGateway(text: string): boolean {
  for (const line of text.split("\n")) {
    if (!line.includes('"assistant"')) continue;
    try {
      if (isUnoGatewayTranscriptRecord(JSON.parse(line))) return true;
    } catch {
      // A line cut by the byte limit, or not JSON: not evidence either way.
    }
  }
  return false;
}

/** Claude Code's config dir for this instance: `CLAUDE_CONFIG_DIR`, else `<HOME>/.claude`. */
export function claudeConfigDir(input: {
  readonly homePath: string;
  readonly environment: NodeJS.ProcessEnv;
}): string {
  const configured = input.environment.CLAUDE_CONFIG_DIR?.trim();
  if (configured) return NodePath.resolve(configured);
  const home = input.homePath.trim().length > 0 ? input.homePath.trim() : NodeOS.homedir();
  return NodePath.join(NodePath.resolve(home.replace(/^~(?=$|\/)/, NodeOS.homedir())), ".claude");
}

async function listTranscripts(root: string): Promise<string[]> {
  const found: { path: string; mtimeMs: number }[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await NodeFs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = NodePath.join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const stat = await NodeFs.stat(full).catch(() => null);
        if (stat) found.push({ path: full, mtimeMs: stat.mtimeMs });
      }
    }
  };
  await walk(root, 0);
  return found.toSorted((a, b) => b.mtimeMs - a.mtimeMs).map((file) => file.path);
}

async function readHead(file: string, maxBytes: number): Promise<string> {
  const handle = await NodeFs.open(file, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Did Claude Code on this machine ever answer over the Uno gateway? */
export async function claudeRanOnUnoGateway(input: {
  readonly configDir: string;
  readonly maxFiles?: number;
  readonly maxBytesPerFile?: number;
}): Promise<boolean> {
  const files = await listTranscripts(NodePath.join(input.configDir, "projects"));
  for (const file of files.slice(0, input.maxFiles ?? UNO_HISTORY_MAX_FILES)) {
    const text = await readHead(
      file,
      input.maxBytesPerFile ?? UNO_HISTORY_MAX_BYTES_PER_FILE,
    ).catch(() => "");
    if (transcriptShowsUnoGateway(text)) return true;
  }
  return false;
}

export type UnoCreditsMigrationResult =
  /** Checked before (or a choice already made): nothing changed. */
  | "skipped"
  /** History found: Uno credits allowed. */
  | "allowed"
  /** No history: the chat will ask. */
  | "ask";

/** What the one-time upgrade writes, given the settings and the history check. */
export function unoCreditsMigrationPatch(input: {
  readonly settings: Pick<ServerSettings, "harnessUnoCredits" | "harnessUnoCreditsMigrated">;
  readonly driver: string;
  readonly ranOnUno: boolean;
}): ServerSettingsPatch {
  const decided = input.settings.harnessUnoCredits?.[input.driver] !== undefined;
  return {
    harnessUnoCreditsMigrated: { [input.driver]: true },
    ...(input.ranOnUno && !decided ? { harnessUnoCredits: { [input.driver]: true } } : {}),
  };
}

/**
 * The upgrade itself. `ranOnUno` is only asked when the answer matters (not
 * checked yet and no choice made), so later starts read no files at all.
 */
export const migrateUnoCreditsConsent = (input: {
  readonly driver: string;
  readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;
  readonly updateSettings: (
    patch: ServerSettingsPatch,
  ) => Effect.Effect<unknown, ServerSettingsError>;
  readonly ranOnUno: () => Promise<boolean>;
}): Effect.Effect<UnoCreditsMigrationResult, ServerSettingsError> =>
  Effect.gen(function* () {
    const settings = yield* input.getSettings;
    if (settings.harnessUnoCreditsMigrated?.[input.driver] === true) return "skipped" as const;
    const decided = settings.harnessUnoCredits?.[input.driver] !== undefined;
    const ranOnUno = decided
      ? false
      : yield* Effect.promise(() => input.ranOnUno().catch(() => false));
    yield* input.updateSettings(
      unoCreditsMigrationPatch({ settings, driver: input.driver, ranOnUno }),
    );
    if (decided) return "skipped" as const;
    return ranOnUno ? ("allowed" as const) : ("ask" as const);
  });
