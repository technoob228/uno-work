/**
 * The assistant's AGENTS.md (its system instructions) is the person's to
 * edit (decision 02.10), and Uno still ships better instructions with new
 * versions. Both at once, the way the spec has it:
 *
 * - next to it Uno keeps the version it last put there, `.uno/AGENTS.base.md`
 *   (the "base");
 * - a file nobody edited (it equals its base) is replaced by the new version
 *   silently;
 * - an edited file is never touched on its own: the page shows "Uno has newer
 *   instructions" with See changes / Update and keep my edits / Keep mine.
 *   "Keep my edits" is a three-way merge base → new on top of the person's
 *   file ({@link mergeInstructions}); a place both changed is a conflict the
 *   person resolves (mine / Uno's / both).
 *
 * The "Who you are" block New assistant writes into AGENTS.md (between the
 * profile markers) is Uno's, not an edit: it is set aside before comparing
 * and put back after any update.
 *
 * Pure; the daemon does the I/O (AssistantService), the page renders.
 *
 * @module assistantInstructions
 */

export const AGENTS_PROFILE_START = "<!-- uno:assistant-profile -->";
export const AGENTS_PROFILE_END = "<!-- /uno:assistant-profile -->";

/** `AGENTS.md` without its profile block, and the block itself. */
export function splitAgentsProfile(text: string): {
  readonly body: string;
  readonly profile: string | null;
} {
  const start = text.indexOf(AGENTS_PROFILE_START);
  const end = text.indexOf(AGENTS_PROFILE_END);
  if (start === -1 || end < start) return { body: text, profile: null };
  const profile = text.slice(start, end + AGENTS_PROFILE_END.length);
  const body = `${text.slice(0, start).replace(/\s+$/, "")}\n${text
    .slice(end + AGENTS_PROFILE_END.length)
    .replace(/^\s+/, "")}`;
  return { body: body.trim().length === 0 ? "" : `${body.replace(/\s+$/, "")}\n`, profile };
}

/** The body with the profile block back at its end. */
export function joinAgentsProfile(body: string, profile: string | null): string {
  if (profile === null) return body;
  const trimmed = body.replace(/\s+$/, "");
  return trimmed.length > 0 ? `${trimmed}\n\n${profile}\n` : `${profile}\n`;
}

/** Lines without trailing whitespace, and none at the end. */
const normalizeInstructions = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\s+$/, "");

/** Compared ignoring trailing whitespace of lines and of the file. */
export function sameInstructions(a: string, b: string): boolean {
  return normalizeInstructions(a) === normalizeInstructions(b);
}

/** `<!-- uno-instructions: v… -->` on the first lines, if any. */
export function instructionsVersion(text: string): string | null {
  return /<!--\s*uno-instructions:\s*([^\s]+)\s*-->/.exec(text.slice(0, 400))?.[1] ?? null;
}

// ── Three-way merge, line by line ────────────────────────────────────

function lcsPairs(a: ReadonlyArray<string>, b: ReadonlyArray<string>): Map<number, number> {
  const n = a.length;
  const m = b.length;
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = table[i]!;
    const below = table[i + 1]!;
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? below[j + 1]! + 1 : Math.max(below[j]!, row[j + 1]!);
    }
  }
  const pairs = new Map<number, number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.set(i, j);
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

export type MergeChunk =
  | { readonly kind: "same"; readonly lines: ReadonlyArray<string> }
  | {
      readonly kind: "conflict";
      readonly base: ReadonlyArray<string>;
      readonly mine: ReadonlyArray<string>;
      readonly theirs: ReadonlyArray<string>;
    };

const sameLines = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((line, index) => line === b[index]);

/**
 * diff3: `mine` and `theirs` both started from `base`. A region only one side
 * changed takes that side; a region both changed the same way is taken once;
 * a region both changed differently is a conflict.
 */
export function merge3(base: string, mine: string, theirs: string): ReadonlyArray<MergeChunk> {
  const b = base.split("\n");
  const m = mine.split("\n");
  const t = theirs.split("\n");
  const toMine = lcsPairs(b, m);
  const toTheirs = lcsPairs(b, t);
  const chunks: MergeChunk[] = [];
  const pushSame = (lines: ReadonlyArray<string>) => {
    if (lines.length === 0) return;
    const last = chunks.at(-1);
    if (last?.kind === "same") {
      chunks[chunks.length - 1] = { kind: "same", lines: [...last.lines, ...lines] };
    } else {
      chunks.push({ kind: "same", lines });
    }
  };
  let ib = 0;
  let im = 0;
  let it = 0;
  for (let i = 0; i <= b.length; i += 1) {
    const end = i === b.length;
    const stable = !end && toMine.has(i) && toTheirs.has(i);
    if (!stable && !end) continue;
    const mEnd = end ? m.length : toMine.get(i)!;
    const tEnd = end ? t.length : toTheirs.get(i)!;
    const hunkBase = b.slice(ib, i);
    const hunkMine = m.slice(im, mEnd);
    const hunkTheirs = t.slice(it, tEnd);
    if (sameLines(hunkMine, hunkBase)) pushSame(hunkTheirs);
    else if (sameLines(hunkTheirs, hunkBase) || sameLines(hunkMine, hunkTheirs)) pushSame(hunkMine);
    else chunks.push({ kind: "conflict", base: hunkBase, mine: hunkMine, theirs: hunkTheirs });
    if (!end) {
      pushSame([b[i]!]);
      ib = i + 1;
      im = mEnd + 1;
      it = tEnd + 1;
    }
  }
  return chunks;
}

/** How a conflict is resolved: the person's text, Uno's, or both (mine first). */
export type ConflictChoice = "mine" | "theirs" | "both";

export function renderMerge(
  chunks: ReadonlyArray<MergeChunk>,
  choices: ReadonlyArray<ConflictChoice> = [],
): string {
  const out: string[] = [];
  let conflict = 0;
  for (const chunk of chunks) {
    if (chunk.kind === "same") {
      out.push(...chunk.lines);
      continue;
    }
    const choice = choices[conflict] ?? "both";
    conflict += 1;
    if (choice === "mine" || choice === "both") out.push(...chunk.mine);
    if (choice === "theirs" || choice === "both") out.push(...chunk.theirs);
  }
  return out.join("\n");
}

export const countConflicts = (chunks: ReadonlyArray<MergeChunk>): number =>
  chunks.filter((chunk) => chunk.kind === "conflict").length;

// ── What to do with the file now ─────────────────────────────────────

/**
 * - `current` — the file is Uno's latest (edited or not);
 * - `edited` — the person changed it, and Uno has nothing newer;
 * - `update-available` — the person changed it and Uno has a newer version:
 *   the page asks.
 */
export type InstructionsState = "current" | "edited" | "update-available";

export interface InstructionsPlan {
  readonly state: InstructionsState;
  /** Write this as AGENTS.md now (a silent update), else leave the file. */
  readonly write: string | null;
  /** Write this as the base now. */
  readonly base: string | null;
}

/**
 * Decide on start-up / on the page's request.
 *
 * @param current AGENTS.md as it is (null: missing).
 * @param base `.uno/AGENTS.base.md` (null: an assistant from before bases —
 *   it is matched against `known`, the versions Uno shipped earlier).
 * @param next The version this Uno Work ships.
 */
export function planInstructions(input: {
  readonly current: string | null;
  readonly base: string | null;
  readonly next: string;
  readonly known: ReadonlyArray<string>;
}): InstructionsPlan {
  const { next } = input;
  if (input.current === null) return { state: "current", write: next, base: next };
  const { body, profile } = splitAgentsProfile(input.current);
  if (sameInstructions(body, next)) {
    return {
      state: "current",
      write: null,
      base: input.base !== null && sameInstructions(input.base, next) ? null : next,
    };
  }
  // Before bases: an untouched file equals one of the versions Uno shipped.
  let base = input.base;
  let newBase: string | null = null;
  if (base === null) {
    const untouched = input.known.find((old) => sameInstructions(old, body));
    if (untouched !== undefined) {
      return { state: "current", write: joinAgentsProfile(next, profile), base: next };
    }
    // Edited: the closest old version is the best base for "keep my edits".
    base = closestVersion(body, input.known) ?? next;
    newBase = base;
  }
  if (sameInstructions(body, base)) {
    return { state: "current", write: joinAgentsProfile(next, profile), base: next };
  }
  return {
    state: sameInstructions(base, next) ? "edited" : "update-available",
    write: null,
    base: newBase,
  };
}

function closestVersion(text: string, known: ReadonlyArray<string>): string | null {
  const lines = text.split("\n");
  let best: string | null = null;
  let bestScore = -1;
  for (const candidate of known) {
    const score = lcsPairs(lines, candidate.split("\n")).size;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/**
 * "Update and keep my edits": Uno's changes since `base` replayed on the
 * person's file; conflicts resolved by `choices` (default: both, mine first).
 */
export function mergeInstructions(input: {
  readonly current: string;
  readonly base: string;
  readonly next: string;
  readonly choices?: ReadonlyArray<ConflictChoice>;
}): { readonly content: string; readonly conflicts: number } {
  const { body, profile } = splitAgentsProfile(input.current);
  const chunks = merge3(input.base, body, input.next);
  return {
    content: joinAgentsProfile(renderMerge(chunks, input.choices), profile),
    conflicts: countConflicts(chunks),
  };
}
