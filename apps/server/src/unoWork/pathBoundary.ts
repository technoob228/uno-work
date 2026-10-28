/**
 * The folder boundary of a sandboxed assistant, as the daemon-side uno-work
 * tools check it (see `UnoWorkCaller.boundary` in tools.ts). Its own module
 * so mailTools.ts can use it without importing tools.ts (which imports
 * mailTools.ts).
 */
import path from "node:path";

export interface PathBoundary {
  readonly roots: ReadonlyArray<string>;
  readonly name: string;
}

/** Spell a path for a person: `~/projects/notes`. */
function displayPath(absolute: string, home: string): string {
  if (absolute === home) return "~";
  return absolute.startsWith(`${home}${path.sep}`)
    ? `~/${absolute.slice(home.length + 1)}`
    : absolute;
}

/** `candidate` is `root` or inside it. */
export function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The path is outside every folder the caller's boundary allows (null = allowed). */
export function boundaryDenial(
  absolute: string,
  boundary: PathBoundary | null | undefined,
  home: string,
): string | null {
  if (!boundary) return null;
  const resolved = path.resolve(absolute);
  if (boundary.roots.some((root) => isWithinRoot(resolved, path.resolve(root)))) return null;
  return `${boundary.name} works only in its projects: ${displayPath(resolved, home)} is outside them. The person can widen its projects on the assistant's page.`;
}
