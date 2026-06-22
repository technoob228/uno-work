/**
 * CLI version parsing/comparison shared between the server (provider version
 * gating) and the desktop shell (uno-code installer/upgrade decision).
 *
 * Pure TypeScript — no Effect, no Node APIs — so it is safe to import from both
 * `apps/server` and `apps/desktop` via `@t3tools/contracts`.
 */

interface ParsedCliSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: ReadonlyArray<string>;
}

const CLI_VERSION_NUMBER_SEGMENT = /^\d+$/;

/**
 * Minimum uno-code version the Uno provider requires. Single source of truth so
 * the desktop installer (which decides whether to (re)install) and the server
 * provider gate (which marks the provider "too old") never disagree.
 *
 * Bump this in one place when raising the floor.
 */
export const UNO_CODE_MINIMUM_VERSION = "1.14.48";

export function normalizeCliVersion(version: string): string {
  const [main, prerelease] = version.trim().split("-", 2);
  const segments = (main ?? "")
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 2) {
    segments.push("0");
  }

  return prerelease ? `${segments.join(".")}-${prerelease}` : segments.join(".");
}

/**
 * Extract the numeric `X.Y.Z` core from arbitrary `--version` output, ignoring
 * any prerelease/build suffix. Mirrors the regex used by the server's
 * `parseGenericCliVersion` so desktop and server judge "freshness" identically.
 *
 * `"1.14.48-uno.1"` → `"1.14.48"`, `"opencode 1.14.48 (abc)"` → `"1.14.48"`,
 * non-version garbage → `null`.
 */
export function extractNumericCliVersion(raw: string): string | null {
  const match = raw.match(/\b(\d+\.\d+\.\d+)\b/);
  return match?.[1] ?? null;
}

function parseCliSemver(version: string): ParsedCliSemver | null {
  const normalized = normalizeCliVersion(version);
  const [main = "", prerelease] = normalized.split("-", 2);
  const segments = main.split(".");
  if (segments.length !== 3) {
    return null;
  }

  const [majorSegment, minorSegment, patchSegment] = segments;
  if (majorSegment === undefined || minorSegment === undefined || patchSegment === undefined) {
    return null;
  }
  if (
    !CLI_VERSION_NUMBER_SEGMENT.test(majorSegment) ||
    !CLI_VERSION_NUMBER_SEGMENT.test(minorSegment) ||
    !CLI_VERSION_NUMBER_SEGMENT.test(patchSegment)
  ) {
    return null;
  }

  const major = Number.parseInt(majorSegment, 10);
  const minor = Number.parseInt(minorSegment, 10);
  const patch = Number.parseInt(patchSegment, 10);
  if (![major, minor, patch].every(Number.isInteger)) {
    return null;
  }

  return {
    major,
    minor,
    patch,
    prerelease:
      prerelease
        ?.split(".")
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0) ?? [],
  };
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);

  if (leftNumeric && rightNumeric) {
    return Number.parseInt(left, 10) - Number.parseInt(right, 10);
  }
  if (leftNumeric) {
    return -1;
  }
  if (rightNumeric) {
    return 1;
  }
  return left.localeCompare(right);
}

export function compareCliVersions(left: string, right: string): number {
  const parsedLeft = parseCliSemver(left);
  const parsedRight = parseCliSemver(right);
  if (!parsedLeft || !parsedRight) {
    return left.localeCompare(right);
  }

  if (parsedLeft.major !== parsedRight.major) {
    return parsedLeft.major - parsedRight.major;
  }
  if (parsedLeft.minor !== parsedRight.minor) {
    return parsedLeft.minor - parsedRight.minor;
  }
  if (parsedLeft.patch !== parsedRight.patch) {
    return parsedLeft.patch - parsedRight.patch;
  }

  if (parsedLeft.prerelease.length === 0 && parsedRight.prerelease.length === 0) {
    return 0;
  }
  if (parsedLeft.prerelease.length === 0) {
    return 1;
  }
  if (parsedRight.prerelease.length === 0) {
    return -1;
  }

  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index];
    const rightIdentifier = parsedRight.prerelease[index];
    if (leftIdentifier === undefined) {
      return -1;
    }
    if (rightIdentifier === undefined) {
      return 1;
    }
    const comparison = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier);
    if (comparison !== 0) {
      return comparison;
    }
  }

  return 0;
}
