/**
 * The tier of one call on one of the person's computers: the classifier
 * (`tiers.ts`, `pathPolicy.ts`) fed with what the computer says about its
 * paths (`resolver.ts`).
 *
 * A command is judged twice: first with every path taken as written, only to
 * learn which paths and folders it touches; then, after ONE resolver call
 * that also resolves the allowed folders, with the real ones. A path the
 * second pass meets that the first didn't is unresolved (asks).
 *
 * The computer's home folder is asked once and kept. A Windows computer gets
 * nothing free yet: its paths aren't resolved (the resolver is POSIX sh), so
 * every call asks, and what is blocked stays blocked.
 *
 * @module myComputer/trust/judge
 */
import { commandTier, higher, type TierResult } from "./tiers.ts";
import {
  absoluteRaw,
  expandHome,
  judgePath,
  normalizePosix,
  sensitiveUnder,
  type PathJudgeContext,
  type PathOp,
} from "./pathPolicy.ts";
import { parseResolverOutput, resolverCommand, type ResolvedFacts } from "./resolver.ts";

export type TrustOperation =
  | { readonly kind: "run"; readonly command: string; readonly cwd?: string | undefined }
  | {
      readonly kind: PathOp;
      readonly path: string;
      /** A search reads everything under the path. */
      readonly recursive?: boolean | undefined;
    };

export interface JudgeInput {
  readonly computerId: string;
  /** As the console reports it: `darwin`, `linux`, `windows`. */
  readonly os: string;
  readonly allowedFolders: ReadonlyArray<string>;
  readonly allowedCommands: ReadonlyArray<string>;
  /** Folders allowed for this call only: the chat's project there. */
  readonly extraAllowed?: ReadonlyArray<string> | undefined;
  readonly operation: TrustOperation;
}

export interface TrustJudge {
  readonly judge: (input: JudgeInput, signal?: AbortSignal) => Promise<TierResult>;
  /** A computer was disconnected or paired again: ask its home anew. */
  readonly forget: (computerId: string) => void;
}

/** Runs the resolver there, quietly; its output, or null when it couldn't. */
export type ResolverRunner = (
  computerId: string,
  command: string,
  signal?: AbortSignal,
) => Promise<string | null>;

const UNCHECKED: TierResult = { tier: "ask", reason: "couldn't check the paths on the computer" };

export function makeTrustJudge(run: ResolverRunner): TrustJudge {
  const homes = new Map<string, string>();

  const resolve = async (
    computerId: string,
    paths: ReadonlyArray<string>,
    probes: ReadonlyArray<string>,
    signal?: AbortSignal,
  ): Promise<ResolvedFacts | null> => {
    const request = { paths, probes };
    const output = await run(computerId, resolverCommand(request), signal).catch(() => null);
    if (output === null) return null;
    const facts = parseResolverOutput(output, request);
    if (facts !== null) homes.set(computerId, facts.home);
    return facts;
  };

  const homeOf = async (computerId: string, signal?: AbortSignal) =>
    homes.get(computerId) ?? (await resolve(computerId, [], [], signal))?.home ?? null;

  return {
    forget: (computerId) => {
      homes.delete(computerId);
    },
    judge: async (input, signal) => {
      const { operation } = input;
      if (input.os === "windows") return windowsTier(input);
      const home = await homeOf(input.computerId, signal);
      if (home === null) return UNCHECKED;
      const allowedRaw = [...input.allowedFolders, ...(input.extraAllowed ?? [])]
        .map((folder) => expandHome(folder.trim(), home))
        .filter((folder): folder is string => folder !== null && folder.startsWith("/"));
      const caseInsensitive = input.os !== "linux";
      const base: PathJudgeContext = { home, allowed: allowedRaw, caseInsensitive };

      if (operation.kind !== "run") {
        const raw = absoluteRaw(operation.path.trim(), home, home);
        if (raw === null) return judgePath(null, operation.kind, base);
        const facts = await resolve(input.computerId, [...allowedRaw, raw], [], signal);
        if (facts === null) return judgePath(null, operation.kind, base);
        const real = facts.real.get(raw) ?? null;
        const ctx = { ...base, allowed: realAllowed(allowedRaw, facts) };
        const inside = operation.recursive && real !== null ? sensitiveUnder(real, ctx) : null;
        if (inside !== null) return { tier: "always", reason: `reading what is in ${inside}` };
        return judgePath(real, operation.kind, ctx);
      }

      const cwd = absoluteRaw((operation.cwd ?? "~").trim() || "~", home, home);
      if (cwd === null) return { tier: "ask", reason: "a folder that can't be told" };
      const paths = new Set<string>();
      const probes = new Set<string>();
      commandTier(operation.command, {
        ...base,
        cwd,
        allowedCommands: input.allowedCommands,
        facts: {
          real: (raw) => {
            paths.add(raw);
            return normalizePosix(raw);
          },
          monorepo: (raw) => {
            probes.add(raw);
            return false;
          },
        },
      });
      const facts = await resolve(
        input.computerId,
        [...allowedRaw, cwd, ...paths],
        [...probes],
        signal,
      );
      if (facts === null) return higher(UNCHECKED, blockedOnly(operation.command, base, cwd));
      return commandTier(operation.command, {
        ...base,
        allowed: realAllowed(allowedRaw, facts),
        cwd,
        allowedCommands: input.allowedCommands,
        facts: {
          real: (raw) => facts.real.get(raw) ?? null,
          monorepo: (raw) => facts.monorepo.get(raw) ?? null,
        },
      });
    },
  };
}

const realAllowed = (allowedRaw: ReadonlyArray<string>, facts: ResolvedFacts) =>
  allowedRaw
    .map((folder) => facts.real.get(folder) ?? null)
    .filter((folder): folder is string => folder !== null);

/** What the command is with nothing known about its paths: blocked stays blocked. */
function blockedOnly(command: string, base: PathJudgeContext, cwd: string): TierResult {
  return commandTier(command, {
    ...base,
    allowed: [],
    cwd,
    allowedCommands: [],
    facts: { real: () => null, monorepo: () => null },
  });
}

function windowsTier(input: JudgeInput): TierResult {
  const ask: TierResult = { tier: "ask", reason: "a Windows computer: every step asks" };
  if (input.operation.kind !== "run") return ask;
  return higher(
    ask,
    blockedOnly(input.operation.command, { home: "/", allowed: [], caseInsensitive: true }, "/"),
  );
}
