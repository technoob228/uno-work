/**
 * "Move my projects here" (13.11): the pure part of the developer way through
 * the setup — what it keeps in `settings.setup.answers` (plain strings, so an
 * older daemon round-trips them, like goals.ts) and what the first-chat step
 * shows for each project while it is copied over.
 */
import type { ComputerWorkBring, ProjectId, UnoSetupProgress } from "@t3tools/contracts";

import { withAnswer } from "./goals";

/** The agent picked on the sign-in step: an instance id ("claudeAgent", "codex") or "uno". */
export const DEV_AGENT_KEY = "dev_agent";
/** The person's computer the projects come from (a `MyComputer` id). */
export const DEV_COMPUTER_KEY = "dev_computer";
/** The projects picked on the import step, in the order shown (JSON). */
export const DEV_PROJECTS_KEY = "dev_projects";

/**
 * The setup's project came from the person's computer (the Project step's
 * "Import from my computer"): its id. Its own AGENTS.md is kept when the
 * instructions are written (`appendAgentsMd`).
 */
export const IMPORTED_PROJECT_KEY = "project_imported";

/** `UnoSetupProgress.answers` values are at most 2000 characters (contract). */
const ANSWER_MAX = 2000;

export interface PickedProject {
  /** Absolute, on the person's computer. */
  readonly path: string;
  readonly name: string;
}

/** The picks as one answer: as many as fit, in order (the rest still come over). */
export function encodePicks(picks: ReadonlyArray<PickedProject>): string {
  const kept: Array<PickedProject> = [];
  for (const pick of picks) {
    const next = JSON.stringify([...kept, { path: pick.path, name: pick.name }]);
    if (next.length > ANSWER_MAX) break;
    kept.push({ path: pick.path, name: pick.name });
  }
  return JSON.stringify(kept);
}

export function decodePicks(value: string | undefined): ReadonlyArray<PickedProject> {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry: unknown) => {
      const record = entry as { readonly path?: unknown; readonly name?: unknown } | null;
      return typeof record?.path === "string" &&
        record.path.length > 0 &&
        typeof record.name === "string"
        ? [{ path: record.path, name: record.name }]
        : [];
    });
  } catch {
    return [];
  }
}

/** The import step's answer: which computer, which projects. */
export function withPicks(
  progress: UnoSetupProgress,
  computerId: string,
  picks: ReadonlyArray<PickedProject>,
): UnoSetupProgress {
  return withAnswer(
    withAnswer(progress, DEV_COMPUTER_KEY, computerId),
    DEV_PROJECTS_KEY,
    encodePicks(picks),
  );
}

export type BroughtState =
  | { readonly kind: "copying" }
  | {
      readonly kind: "ready";
      readonly projectId: ProjectId;
      readonly folder: string;
      /** Copied, with something to say (a key not saved, sync didn't turn on). */
      readonly note: string | null;
    }
  | { readonly kind: "failed"; readonly message: string };

export interface BroughtRow extends PickedProject {
  readonly state: BroughtState;
}

/** A project of this computer, for daemons that don't name the brought project. */
export interface KnownProject {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

const NOT_COPIED = "It didn’t come over. Bring it again.";

/** An older daemon's result has no project: the project named after the folder in ~/projects. */
function projectByName(
  name: string,
  known: ReadonlyArray<KnownProject>,
): { readonly id: ProjectId; readonly folder: string } | null {
  const match = known.find(
    (project) =>
      project.title === name &&
      /\/projects\/[^/]+$/.test(project.workspaceRoot.replace(/\/+$/, "")),
  );
  return match ? { id: match.id, folder: match.workspaceRoot } : null;
}

/**
 * Each picked project with how its copy goes: copying until its result is in,
 * then ready (its project here) or failed with the reason. Results the picks
 * don't name (another device made them) are listed after the picks.
 */
export function broughtRows(input: {
  readonly picks: ReadonlyArray<PickedProject>;
  readonly bring: ComputerWorkBring | undefined;
  readonly known: ReadonlyArray<KnownProject>;
}): ReadonlyArray<BroughtRow> {
  const results = new Map((input.bring?.results ?? []).map((result) => [result.path, result]));
  const running = input.bring?.state === "running";
  const rowOf = (pick: PickedProject): BroughtRow => {
    const result = results.get(pick.path);
    if (result) {
      const project =
        result.projectId && result.folder
          ? { id: result.projectId, folder: result.folder }
          : result.ok
            ? projectByName(result.name, input.known)
            : null;
      if (project) {
        return {
          ...pick,
          state: {
            kind: "ready",
            projectId: project.id,
            folder: project.folder,
            note: result.message,
          },
        };
      }
      return { ...pick, state: { kind: "failed", message: result.message ?? NOT_COPIED } };
    }
    if (running) return { ...pick, state: { kind: "copying" } };
    // Nothing about it: the copy is over (or this computer restarted since).
    const known = projectByName(pick.name, input.known);
    if (known) {
      return {
        ...pick,
        state: { kind: "ready", projectId: known.id, folder: known.folder, note: null },
      };
    }
    if (input.bring === undefined) return { ...pick, state: { kind: "copying" } };
    return {
      ...pick,
      state: {
        kind: "failed",
        message:
          input.bring.state === "failed" && input.bring.message ? input.bring.message : NOT_COPIED,
      },
    };
  };
  const rows = input.picks.map(rowOf);
  const picked = new Set(input.picks.map((pick) => pick.path));
  for (const result of input.bring?.results ?? []) {
    if (!picked.has(result.path)) rows.push(rowOf({ path: result.path, name: result.name }));
  }
  return rows;
}

/**
 * The selected row: the one the person picked, else the first in the list
 * that hasn't failed (it may still be copying: the button waits for it).
 */
export function selectedRow(
  rows: ReadonlyArray<BroughtRow>,
  picked: string | null,
): BroughtRow | null {
  return (
    rows.find((row) => row.path === picked) ??
    rows.find((row) => row.state.kind !== "failed") ??
    rows[0] ??
    null
  );
}
