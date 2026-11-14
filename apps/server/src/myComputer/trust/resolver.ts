/**
 * Asks the person's computer what paths really are, before a call is judged:
 * ONE quiet command (no journal line of its own) with a fixed script, the
 * paths as its arguments. For each path it follows symlinks (also dangling
 * ones), takes `..` physically (`cd -P`) and keeps the part that doesn't
 * exist yet as written; for each folder a command runs in, it says whether
 * that folder is a monorepo root (turbo, pnpm / npm workspaces, nx, lerna,
 * a Cargo workspace, go.work).
 *
 * Output: a marker line (the login shell may print its own lines first), the
 * home folder, then one line per argument. Anything unexpected reads as
 * "couldn't resolve", which the judge treats as outside the folders.
 *
 * @module myComputer/trust/resolver
 */
import { shQuote } from "../workspaceTools.ts";
import { normalizePosix } from "./pathPolicy.ts";

/** More paths than this in one command: the rest stay unresolved (asks). */
export const MAX_RESOLVE_PATHS = 200;

const MARKER = "__uno_trust_v1__";

const SCRIPT = String.raw`exec 2>/dev/null
res() {
  p=$1; rest=; n=0
  while :; do
    n=$((n+1)); [ $n -gt 300 ] && { echo '?'; return; }
    if [ -L "$p" ]; then
      t=$(readlink -- "$p") || { echo '?'; return; }
      case $t in /*) p=$t;; *) d0=\${p%/*}; p="\${d0:-/}/$t";; esac
      continue
    fi
    [ -e "$p" ] && break
    case $p in /|'') echo '?'; return;; esac
    rest="/\${p##*/}$rest"; p=\${p%/*}; [ -z "$p" ] && p=/
  done
  if [ -d "$p" ]; then
    d=$(cd -P -- "$p" 2>/dev/null && pwd -P) || { echo '?'; return; }
    printf 'R:%s%s\n' "$d" "$rest"
  else
    dir=\${p%/*}; [ -z "$dir" ] && dir=/
    d=$(cd -P -- "$dir" 2>/dev/null && pwd -P) || { echo '?'; return; }
    printf 'R:%s/%s%s\n' "\${d%/}" "\${p##*/}" "$rest"
  fi
}
mono() {
  p=$1
  if [ ! -d "$p" ]; then echo 'M?'; return; fi
  if [ -f "$p/turbo.json" ] || [ -f "$p/pnpm-workspace.yaml" ] || [ -f "$p/nx.json" ] || [ -f "$p/lerna.json" ] || [ -f "$p/go.work" ] || grep -qs '"workspaces"' "$p/package.json" || grep -qs '^\[workspace\]' "$p/Cargo.toml"; then echo M1; else echo M0; fi
}
printf '%s\nH:%s\n' "$0" "$HOME"
for a in "$@"; do
  k=\${a%%:*}; p=\${a#*:}
  case $p in '~') p=$HOME;; '~/'*) p="$HOME/\${p#??}";; esac
  if [ "$k" = M ]; then mono "$p"; else res "$p"; fi
done`.replace(/\\\$/g, "$");

export interface ResolveRequest {
  /** Absolute paths (or `~/…`), as the call gave them. */
  readonly paths: ReadonlyArray<string>;
  /** Folders a command runs in: monorepo roots or not. */
  readonly probes: ReadonlyArray<string>;
}

export interface ResolvedFacts {
  readonly home: string;
  readonly real: ReadonlyMap<string, string | null>;
  readonly monorepo: ReadonlyMap<string, boolean | null>;
}

const usable = (value: string) => value.length > 0 && !/[\u0000-\u001f]/.test(value);

/** What went to the computer, in order. */
function argumentsOf(request: ResolveRequest): Array<{ kind: "P" | "M"; path: string }> {
  const seenPaths = new Set<string>();
  const seenProbes = new Set<string>();
  const out: Array<{ kind: "P" | "M"; path: string }> = [];
  for (const path of request.paths) {
    if (!usable(path) || seenPaths.has(path) || seenPaths.size >= MAX_RESOLVE_PATHS) continue;
    seenPaths.add(path);
    out.push({ kind: "P", path });
  }
  for (const path of request.probes) {
    if (!usable(path) || seenProbes.has(path) || seenProbes.size >= 16) continue;
    seenProbes.add(path);
    out.push({ kind: "M", path });
  }
  return out;
}

/** The command for the computer's login shell: `/bin/sh -c <script> <marker> P:… M:…`. */
export function resolverCommand(request: ResolveRequest): string {
  const args = argumentsOf(request).map(({ kind, path }) => shQuote(`${kind}:${path}`));
  return ["/bin/sh", "-c", shQuote(SCRIPT), MARKER, ...args].join(" ");
}

/** Its output read back; null: it didn't answer as it should. */
export function parseResolverOutput(text: string, request: ResolveRequest): ResolvedFacts | null {
  const lines = text.split("\n");
  const start = lines.lastIndexOf(MARKER);
  if (start < 0) return null;
  const homeLine = lines[start + 1] ?? "";
  if (!homeLine.startsWith("H:") || !homeLine.slice(2).startsWith("/")) return null;
  const home = normalizePosix(homeLine.slice(2));
  const real = new Map<string, string | null>();
  const monorepo = new Map<string, boolean | null>();
  const args = argumentsOf(request);
  args.forEach(({ kind, path }, index) => {
    const line = lines[start + 2 + index] ?? "";
    if (kind === "P") {
      real.set(path, line.startsWith("R:/") ? normalizePosix(line.slice(2)) : null);
    } else {
      monorepo.set(path, line === "M1" ? true : line === "M0" ? false : null);
    }
  });
  return { home, real, monorepo };
}
