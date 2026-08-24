/**
 * First-project logic for the browser onboarding.
 *
 * The hosted app runs against a remote machine the user has never seen, so the
 * desktop "pick a folder" step is useless there. Instead the browser flow seeds
 * the workspace one of three ways: clone a git remote, upload local files, or
 * generate a small guided tutorial project.
 */

export type FirstProjectMode = "clone" | "upload" | "tutorial";

/** Hosted daemons run on Linux, so paths are always posix here. */
const PATH_SEPARATOR = "/";

export const UPLOAD_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const UPLOAD_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const UPLOAD_MAX_FILE_COUNT = 2000;

/** Directories that are never worth uploading from a browser file picker. */
const UPLOAD_IGNORED_SEGMENTS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
  ".turbo",
  ".venv",
  "__pycache__",
  "dist",
  "build",
  "target",
]);

const UPLOAD_IGNORED_FILE_NAMES = new Set([".DS_Store", "Thumbs.db"]);

export function normalizeProjectName(raw: string): string {
  const trimmed = raw.trim().replace(/[/\\]+/g, "-");
  const sanitized = trimmed.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.slice(0, 64);
}

/**
 * Accepts the shapes a user is likely to paste: https, ssh, scp-like, and
 * bare `owner/repo` GitHub shorthand.
 */
export function isLikelyGitRemoteUrl(raw: string): boolean {
  const value = raw.trim();
  if (value.length === 0) return false;
  if (/^(https?|git|ssh):\/\/\S+$/i.test(value)) return true;
  if (/^[\w.-]+@[\w.-]+:\S+$/.test(value)) return true;
  return /^[\w.-]+\/[\w.-]+$/.test(value);
}

export function expandGitRemoteUrl(raw: string): string {
  const value = raw.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) {
    return `https://github.com/${value}.git`;
  }
  return value;
}

export function inferProjectNameFromGitUrl(raw: string): string {
  const value = expandGitRemoteUrl(raw).replace(/\/+$/, "");
  const withoutQuery = value.split(/[?#]/)[0] ?? value;
  const lastSegment = withoutQuery.split(/[/:]/).filter(Boolean).pop() ?? "";
  const withoutSuffix = lastSegment.replace(/\.git$/i, "");
  return normalizeProjectName(withoutSuffix) || "project";
}

export function joinWorkspacePath(baseDirectory: string, name: string): string {
  const base = baseDirectory.trim().replace(/\/+$/, "");
  const leaf = name.trim().replace(/^\/+/, "");
  if (base.length === 0) return leaf;
  return `${base}${PATH_SEPARATOR}${leaf}`;
}

/** Strips the leading directory the browser prepends to `webkitRelativePath`. */
export function stripUploadRootSegment(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, PATH_SEPARATOR).replace(/^\/+/, "");
  const separatorIndex = normalized.indexOf(PATH_SEPARATOR);
  return separatorIndex === -1 ? normalized : normalized.slice(separatorIndex + 1);
}

export interface UploadCandidate {
  readonly relativePath: string;
  readonly size: number;
}

export type UploadSkipReason = "ignored" | "too-large" | "unsafe-path" | "over-budget";

export interface UploadPlanEntry {
  readonly relativePath: string;
  readonly size: number;
}

export interface UploadSkippedEntry {
  readonly relativePath: string;
  readonly reason: UploadSkipReason;
}

export interface UploadPlan {
  readonly accepted: ReadonlyArray<UploadPlanEntry>;
  readonly skipped: ReadonlyArray<UploadSkippedEntry>;
  readonly totalBytes: number;
}

function isUnsafeRelativePath(relativePath: string): boolean {
  if (relativePath.length === 0) return true;
  if (relativePath.startsWith(PATH_SEPARATOR)) return true;
  return relativePath.split(PATH_SEPARATOR).some((segment) => segment === ".." || segment === "");
}

function isIgnoredRelativePath(relativePath: string): boolean {
  const segments = relativePath.split(PATH_SEPARATOR);
  const fileName = segments[segments.length - 1] ?? "";
  if (UPLOAD_IGNORED_FILE_NAMES.has(fileName)) return true;
  return segments.slice(0, -1).some((segment) => UPLOAD_IGNORED_SEGMENTS.has(segment));
}

export interface UploadPlanLimits {
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxFileCount: number;
  /**
   * Отсеивать мусорные каталоги (node_modules, .git…). Для перетащенной папки
   * это нужно всегда; для явно выбранных пользователем файлов — нет: раз он их
   * выбрал сам, значит они нужны.
   */
  readonly filterIgnored: boolean;
}

const FIRST_PROJECT_UPLOAD_LIMITS: UploadPlanLimits = {
  maxFileBytes: UPLOAD_MAX_FILE_BYTES,
  maxTotalBytes: UPLOAD_MAX_TOTAL_BYTES,
  maxFileCount: UPLOAD_MAX_FILE_COUNT,
  filterIgnored: true,
};

/**
 * Decides what actually gets written to the remote machine. Uploads go through
 * one RPC call per file, so the caps here are what keeps a stray `node_modules`
 * drop from hanging the onboarding.
 */
export function planUpload(
  candidates: ReadonlyArray<UploadCandidate>,
  limits: UploadPlanLimits = FIRST_PROJECT_UPLOAD_LIMITS,
): UploadPlan {
  const accepted: UploadPlanEntry[] = [];
  const skipped: UploadSkippedEntry[] = [];
  let totalBytes = 0;

  for (const candidate of candidates) {
    const relativePath = candidate.relativePath.replace(/\\/g, PATH_SEPARATOR).replace(/^\/+/, "");

    if (isUnsafeRelativePath(relativePath)) {
      skipped.push({ relativePath: candidate.relativePath, reason: "unsafe-path" });
      continue;
    }
    if (limits.filterIgnored && isIgnoredRelativePath(relativePath)) {
      skipped.push({ relativePath, reason: "ignored" });
      continue;
    }
    if (candidate.size > limits.maxFileBytes) {
      skipped.push({ relativePath, reason: "too-large" });
      continue;
    }
    if (
      accepted.length >= limits.maxFileCount ||
      totalBytes + candidate.size > limits.maxTotalBytes
    ) {
      skipped.push({ relativePath, reason: "over-budget" });
      continue;
    }

    accepted.push({ relativePath, size: candidate.size });
    totalBytes += candidate.size;
  }

  return { accepted, skipped, totalBytes };
}

export function inferProjectNameFromUpload(
  candidates: ReadonlyArray<{ readonly rootRelativePath: string }>,
): string {
  const firstPath = candidates[0]?.rootRelativePath ?? "";
  const normalized = firstPath.replace(/\\/g, PATH_SEPARATOR).replace(/^\/+/, "");
  const separatorIndex = normalized.indexOf(PATH_SEPARATOR);
  if (separatorIndex <= 0) return "uploaded-files";
  return normalizeProjectName(normalized.slice(0, separatorIndex)) || "uploaded-files";
}

export interface FirstProjectProviderCandidate {
  readonly instanceId: string;
  readonly status: string;
  readonly models: ReadonlyArray<{ readonly slug: string }>;
}

export interface FirstProjectModelSelection {
  readonly instanceId: string;
  readonly model: string;
}

/**
 * Picks the model a browser-onboarding project starts with. Hosted machines
 * ship with the Uno gateway already configured, so prefer it; otherwise take
 * any ready provider and fall back to the caller's default.
 */
export function pickFirstProjectModelSelection(
  providers: ReadonlyArray<FirstProjectProviderCandidate>,
  fallback: FirstProjectModelSelection,
): FirstProjectModelSelection {
  const usable = providers.filter(
    (provider) => provider.status === "ready" && provider.models.length > 0,
  );
  const preferred = usable.find((provider) => provider.instanceId === "uno") ?? usable[0];
  const model = preferred?.models[0]?.slug;
  if (!preferred || !model) return fallback;
  return { instanceId: preferred.instanceId, model };
}

export interface TutorialFile {
  readonly relativePath: string;
  readonly contents: string;
}

export const TUTORIAL_PROJECT_NAME = "uno-work-tutorial";

/**
 * A tiny but real project: enough files that the agent has something to read,
 * and a task list that teaches the loop (ask → diff → run) in one sitting.
 */
export const TUTORIAL_FILES: ReadonlyArray<TutorialFile> = [
  {
    relativePath: "README.md",
    contents: `# Uno Work tutorial

This project runs on a real Linux machine. The agent can read and edit these
files, run commands in the terminal, and show you the diff before anything is
kept.

## Try these, in order

1. **Ask a question** — "What does \`sales.csv\` contain?"
2. **Make a change** — "Add a \`total\` column to \`report.py\` and print the top 3 rows."
3. **Run it** — "Run \`python3 report.py\` and show me the output."
4. **Review the diff** — every edit shows up as a diff you approve or discard.

## What is in here

- \`sales.csv\` — 12 rows of sample data
- \`report.py\` — reads the CSV and prints a summary

Delete this project whenever you like; it is just a sandbox.
`,
  },
  {
    relativePath: "sales.csv",
    contents: `date,region,product,units,unit_price
2026-01-04,north,widget,12,9.99
2026-01-07,south,widget,4,9.99
2026-01-11,north,gadget,7,24.50
2026-01-15,east,widget,19,9.99
2026-01-18,south,gadget,3,24.50
2026-02-02,north,widget,22,9.99
2026-02-09,west,gizmo,5,49.00
2026-02-14,east,gadget,11,24.50
2026-02-21,south,gizmo,2,49.00
2026-03-03,north,gizmo,8,49.00
2026-03-12,west,widget,15,9.99
2026-03-19,east,gizmo,6,49.00
`,
  },
  {
    relativePath: "report.py",
    contents: `"""Summarise sales.csv. Ask the agent to extend this."""

import csv
from collections import defaultdict

def load(path="sales.csv"):
    with open(path, newline="") as handle:
        return list(csv.DictReader(handle))

def main():
    rows = load()
    by_region = defaultdict(float)
    for row in rows:
        by_region[row["region"]] += int(row["units"]) * float(row["unit_price"])

    print(f"{len(rows)} rows")
    for region, revenue in sorted(by_region.items(), key=lambda item: -item[1]):
        print(f"{region:>6}  {revenue:8.2f}")

if __name__ == "__main__":
    main()
`,
  },
];
