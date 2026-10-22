import * as nodePath from "node:path";

import type { RepositoryIdentity } from "@t3tools/contracts";
import { Cache, Duration, Effect, Exit, Layer } from "effect";
import {
  detectSourceControlProviderFromGitRemoteUrl,
  normalizeGitRemoteUrl,
} from "@t3tools/shared/git";

import { runProcess } from "../../processRunner.ts";
import {
  RepositoryIdentityResolver,
  type RepositoryIdentityResolverShape,
} from "../Services/RepositoryIdentityResolver.ts";

function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (direction !== "fetch" || remoteName.length === 0 || remoteUrl.length === 0) {
      continue;
    }
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

/** `uno::notes` → `notes`: a project in the person's own Uno cloud (git-remote-uno). */
function unoProjectNameOf(remoteUrl: string): string | null {
  const match = /^uno::([a-z0-9][a-z0-9._-]{0,63})\/?$/i.exec(remoteUrl.trim());
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * The remote that names the project the same way on every computer.
 *
 * Uno cloud first: a project synced through Uno has its `uno::<name>` remote
 * on every copy (`uno project sync` adds it, `uno project get` clones from it),
 * while its GitHub `origin` may exist on only one of them. Then `origin` before
 * `upstream`: a fork cloned on a second computer usually has only `origin`, so
 * naming it by `upstream` split one project in two.
 */
function pickPrimaryRemote(
  remotes: ReadonlyMap<string, string>,
): { readonly remoteName: string; readonly remoteUrl: string } | null {
  const sorted = [...remotes.entries()].toSorted(([left], [right]) => left.localeCompare(right));
  const uno =
    sorted.find(([remoteName, remoteUrl]) => remoteName === "uno" && unoProjectNameOf(remoteUrl)) ??
    sorted.find(([, remoteUrl]) => unoProjectNameOf(remoteUrl));
  if (uno) {
    return { remoteName: uno[0], remoteUrl: uno[1] };
  }

  for (const preferredRemoteName of ["origin", "upstream"] as const) {
    const remoteUrl = remotes.get(preferredRemoteName);
    if (remoteUrl) {
      return { remoteName: preferredRemoteName, remoteUrl };
    }
  }

  const [remoteName, remoteUrl] = sorted[0] ?? [];
  return remoteName && remoteUrl ? { remoteName, remoteUrl } : null;
}

function buildRepositoryIdentity(input: {
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly rootPath: string;
}): RepositoryIdentity {
  const unoName = unoProjectNameOf(input.remoteUrl);
  if (unoName) {
    return {
      canonicalKey: `uno::${unoName}`,
      locator: {
        source: "git-remote",
        remoteName: input.remoteName,
        remoteUrl: input.remoteUrl,
      },
      rootPath: input.rootPath,
      displayName: unoName,
      provider: "uno",
      name: unoName,
    };
  }

  const canonicalKey = normalizeGitRemoteUrl(input.remoteUrl);
  const sourceControlProvider = detectSourceControlProviderFromGitRemoteUrl(input.remoteUrl);
  const repositoryPath = canonicalKey.split("/").slice(1).join("/");
  const repositoryPathSegments = repositoryPath.split("/").filter((segment) => segment.length > 0);
  const [owner] = repositoryPathSegments;
  const repositoryName = repositoryPathSegments.at(-1);

  return {
    canonicalKey,
    locator: {
      source: "git-remote",
      remoteName: input.remoteName,
      remoteUrl: input.remoteUrl,
    },
    rootPath: input.rootPath,
    ...(repositoryPath ? { displayName: repositoryPath } : {}),
    ...(sourceControlProvider ? { provider: sourceControlProvider.kind } : {}),
    ...(owner ? { owner } : {}),
    ...(repositoryName ? { name: repositoryName } : {}),
  };
}

const DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY = 512;
const DEFAULT_POSITIVE_CACHE_TTL = Duration.minutes(1);
const DEFAULT_NEGATIVE_CACHE_TTL = Duration.minutes(1);

interface RepositoryIdentityResolverOptions {
  readonly cacheCapacity?: number;
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
}

async function resolveRepositoryIdentityCacheKey(cwd: string): Promise<string> {
  let cacheKey = cwd;

  try {
    const topLevelResult = await runProcess("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      allowNonZeroExit: true,
    });
    if (topLevelResult.code !== 0) {
      return cacheKey;
    }

    const candidate = topLevelResult.stdout.trim();
    if (candidate.length > 0) {
      cacheKey = candidate;
    }
  } catch {
    return cacheKey;
  }

  return cacheKey;
}

/**
 * The hidden history Uno keeps for a synced folder that has no git of its own
 * (`<folder>/.uno-git`, a bare repository whose `uno` remote is the project in
 * the person's cloud). The person's own `.git` always wins over it.
 */
export const UNO_SNAPSHOT_GIT_DIR = ".uno-git";

async function readRemotes(cacheKey: string): ReturnType<typeof runProcess> {
  const own = await runProcess("git", ["-C", cacheKey, "remote", "-v"], {
    allowNonZeroExit: true,
  });
  if (own.code === 0) {
    return own;
  }
  return runProcess(
    "git",
    ["--git-dir", nodePath.join(cacheKey, UNO_SNAPSHOT_GIT_DIR), "remote", "-v"],
    { allowNonZeroExit: true },
  );
}

async function resolveRepositoryIdentityFromCacheKey(
  cacheKey: string,
): Promise<RepositoryIdentity | null> {
  try {
    const remoteResult = await readRemotes(cacheKey);
    if (remoteResult.code !== 0) {
      return null;
    }

    const remote = pickPrimaryRemote(parseRemoteFetchUrls(remoteResult.stdout));
    return remote ? buildRepositoryIdentity({ ...remote, rootPath: cacheKey }) : null;
  } catch {
    return null;
  }
}

export const makeRepositoryIdentityResolver = Effect.fn("makeRepositoryIdentityResolver")(
  function* (options: RepositoryIdentityResolverOptions = {}) {
    const repositoryIdentityCache = yield* Cache.makeWith<string, RepositoryIdentity | null>(
      (cacheKey) => Effect.promise(() => resolveRepositoryIdentityFromCacheKey(cacheKey)),
      {
        capacity: options.cacheCapacity ?? DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY,
        timeToLive: Exit.match({
          onSuccess: (value) =>
            value === null
              ? (options.negativeCacheTtl ?? DEFAULT_NEGATIVE_CACHE_TTL)
              : (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL),
          onFailure: () => Duration.zero,
        }),
      },
    );

    const resolve: RepositoryIdentityResolverShape["resolve"] = Effect.fn(
      "RepositoryIdentityResolver.resolve",
    )(function* (cwd) {
      const cacheKey = yield* Effect.promise(() => resolveRepositoryIdentityCacheKey(cwd));
      return yield* Cache.get(repositoryIdentityCache, cacheKey);
    });

    return {
      resolve,
    } satisfies RepositoryIdentityResolverShape;
  },
);

export const RepositoryIdentityResolverLive = Layer.effect(
  RepositoryIdentityResolver,
  makeRepositoryIdentityResolver(),
);
