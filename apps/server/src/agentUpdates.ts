/**
 * Which agents on this computer are behind, for "Update everything". The target
 * is npm's latest for Claude Code and Codex and our pin for OpenCode
 * (`UPDATABLE_AGENTS`). The update itself is the install job the Update button
 * in Settings runs (provider/setup), so nothing here changes anything.
 *
 * An agent installed some other way (Claude Code's native installer, Homebrew)
 * reads as not `managed`: `npm install -g` would put a second copy beside it and
 * the version on the screen wouldn't move.
 */
import { realpathSync } from "node:fs";
import nodePath from "node:path";

import {
  compareCliVersions,
  extractNumericCliVersion,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  UNO_OPENCODE_VERSION,
  UPDATABLE_AGENTS,
  type AgentUpdateStatus,
} from "@t3tools/shared/agentVersions";

const LATEST_TTL_MS = 30 * 60_000;
const LATEST_RETRY_MS = 5 * 60_000;
const LATEST_FETCH_TIMEOUT_MS = 10_000;
const LATEST_MAX_BYTES = 1024 * 1024;
const REGISTRY = "https://registry.npmjs.org";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const latestCache = new Map<string, { readonly version: string | null; readonly until: number }>();

export function resetAgentUpdatesCacheForTest(): void {
  latestCache.clear();
}

/** npm's `latest` of a package; null when the registry didn't answer. Never throws. */
export async function latestNpmVersion(
  npmPackage: string,
  options: { readonly fetch?: FetchLike; readonly now?: () => number } = {},
): Promise<string | null> {
  const now = options.now ?? Date.now;
  const cached = latestCache.get(npmPackage);
  if (cached && cached.until > now()) return cached.version;
  let version: string | null = null;
  try {
    const response = await (options.fetch ?? fetch)(
      `${REGISTRY}/${npmPackage.replace("/", "%2F")}/latest`,
      { signal: AbortSignal.timeout(LATEST_FETCH_TIMEOUT_MS) },
    );
    if (response.ok) {
      const text = await response.text();
      const parsed: unknown = text.length <= LATEST_MAX_BYTES ? JSON.parse(text) : null;
      const candidate = (parsed as { version?: unknown } | null)?.version;
      version = typeof candidate === "string" ? candidate : null;
    }
  } catch {
    version = null;
  }
  latestCache.set(npmPackage, {
    version,
    until: now() + (version === null ? LATEST_RETRY_MS : LATEST_TTL_MS),
  });
  return version;
}

/** The binary npm put on PATH, followed to where it really lives. */
export function findInstalledBin(bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = (env.PATH ?? "").split(nodePath.delimiter).filter(Boolean);
  if (env.HOME) dirs.push(nodePath.join(env.HOME, ".local", "bin"));
  for (const dir of dirs) {
    try {
      return realpathSync(nodePath.join(dir, bin));
    } catch {
      // Not in this directory.
    }
  }
  return null;
}

export function isNpmManagedPath(realPath: string | null): boolean {
  return realPath !== null && /[/\\]node_modules[/\\]/u.test(realPath);
}

export interface AgentUpdateDeps {
  readonly latest: (npmPackage: string) => Promise<string | null>;
  readonly binPath: (bin: string) => string | null;
}

const isBehind = (version: string | null, target: string | null): boolean => {
  if (version === null || target === null) return false;
  const installed = extractNumericCliVersion(version);
  return installed !== null && compareCliVersions(installed, target) < 0;
};

export async function agentUpdateStatuses(
  providers: ReadonlyArray<ServerProvider>,
  deps: AgentUpdateDeps,
): Promise<ReadonlyArray<AgentUpdateStatus>> {
  const installed = UPDATABLE_AGENTS.flatMap((agent) => {
    // The default instance: extra instances share its binary.
    const provider = providers.find(
      (entry) => entry.driver === agent.driver && entry.instanceId === agent.driver,
    );
    return provider?.installed ? [{ agent, provider }] : [];
  });
  return Promise.all(
    installed.map(async ({ agent, provider }) => {
      const target =
        agent.driver === "opencode" ? UNO_OPENCODE_VERSION : await deps.latest(agent.npmPackage);
      const managed = isNpmManagedPath(deps.binPath(agent.bin));
      const version = provider.version ? extractNumericCliVersion(provider.version) : null;
      return {
        driver: agent.driver,
        name: agent.name,
        version,
        target,
        managed,
        behind: managed && isBehind(version, target),
      };
    }),
  );
}
