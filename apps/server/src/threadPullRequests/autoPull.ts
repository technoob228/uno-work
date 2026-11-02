/**
 * "Automatically pull" (Dev mode): keeps a project's default-branch checkout
 * current. As upstream: only a fast-forward, only a clean checkout on its default
 * branch with an upstream and no local commits. Anything else waits for the
 * person, untouched.
 *
 * @module threadPullRequests/autoPull
 */
import { Effect } from "effect";

import type { VcsProcessShape } from "../vcs/VcsProcess.ts";

export const AUTO_PULL_INTERVAL_MS = 10 * 60_000;
const GIT_TIMEOUT_MS = 30_000;

export interface AutoPullState {
  readonly branch: string;
  readonly defaultBranch: string | null;
  readonly hasUpstream: boolean;
  readonly dirty: boolean;
  readonly aheadOfUpstream: number;
}

export function shouldAutoPull(state: AutoPullState): boolean {
  return (
    state.branch.length > 0 &&
    state.branch === state.defaultBranch &&
    state.hasUpstream &&
    !state.dirty &&
    state.aheadOfUpstream === 0
  );
}

/** Reads the checkout and pulls when that's safe. Never fails: the next pass looks again. */
export const autoPullCheckout = (process: VcsProcessShape, cwd: string) => {
  const git = (operation: string, args: ReadonlyArray<string>) =>
    process
      .run({
        operation: `AutoPull.${operation}`,
        command: "git",
        args,
        cwd,
        allowNonZeroExit: true,
        timeoutMs: GIT_TIMEOUT_MS,
      })
      .pipe(
        Effect.map((result) => ({ ok: result.exitCode === 0, text: result.stdout.trim() })),
        Effect.orElseSucceed(() => ({ ok: false, text: "" })),
      );
  return Effect.gen(function* () {
    const branch = yield* git("branch", ["symbolic-ref", "--short", "-q", "HEAD"]);
    const origin = yield* git("defaultBranch", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    const status = yield* git("status", ["status", "--porcelain"]);
    const ahead = yield* git("ahead", ["rev-list", "--count", "@{upstream}..HEAD"]);
    const state: AutoPullState = {
      branch: branch.text,
      defaultBranch: origin.ok ? origin.text.replace(/^origin\//u, "") : null,
      hasUpstream: ahead.ok,
      dirty: !status.ok || status.text.length > 0,
      aheadOfUpstream: Number(ahead.text) || 0,
    };
    if (!shouldAutoPull(state)) return false;
    const fetched = yield* git("fetch", ["fetch", "--quiet", "--no-tags"]);
    if (!fetched.ok) return false;
    const merged = yield* git("merge", ["merge", "--ff-only", "--quiet", "@{upstream}"]);
    return merged.ok;
  });
};
