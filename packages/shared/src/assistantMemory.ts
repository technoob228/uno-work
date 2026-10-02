/**
 * The assistant's memory files as the person sees them on the assistant page
 * ("Memory & models", assistants MVP 0.0.106): NOTES.md as a list of dated
 * lines and ROUTING.md as a table "kind of task → harness, model, thinking".
 *
 * The files stay plain markdown the assistant reads and writes itself; these
 * helpers parse them leniently and change only the lines they own, so a file
 * the assistant reshaped never breaks the page. Edits from the page and from
 * the assistant can cross: {@link rebaseEdit} replays the page's edit onto
 * what is on disk now instead of overwriting it (the last writer must not
 * erase someone else's lines).
 *
 * @module assistantMemory
 */

// ── NOTES.md ─────────────────────────────────────────────────────────

/** Marks a note the person gave (from the page or "remember that…"). */
export const NOTE_FROM_PERSON_MARK = "(you)";

export interface AssistantNote {
  /** Index of the line in the file. */
  readonly line: number;
  /** The text without the date, bullet and `(you)` mark. */
  readonly text: string;
  /** `YYYY-MM-DD` when the line starts with a date. */
  readonly date: string | null;
  /** The person added it (`(you)` at the end), not the assistant. */
  readonly fromPerson: boolean;
}

const BULLET_RE = /^\s*[-*]\s+(.+?)\s*$/;
const DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})(?:[ T]\d{1,2}:\d{2})?\s*(?:[—–:-]\s*)?(.*)$/;
const PERSON_MARK_RE = /\s*\(you\)\s*$/i;

/** The bullet lines of NOTES.md (or USER.md) — what the assistant remembers. */
export function parseNotes(content: string): ReadonlyArray<AssistantNote> {
  const notes: AssistantNote[] = [];
  content.split("\n").forEach((raw, line) => {
    const bullet = BULLET_RE.exec(raw)?.[1];
    if (!bullet) return;
    const dated = DATE_PREFIX_RE.exec(bullet);
    const body = dated ? (dated[2] ?? "") : bullet;
    const fromPerson = PERSON_MARK_RE.test(body);
    const text = body.replace(PERSON_MARK_RE, "").trim();
    if (text.length === 0) return;
    notes.push({ line, text, date: dated?.[1] ?? null, fromPerson });
  });
  return notes;
}

function cleanNoteText(text: string): string {
  // One line, no bullet of its own, no forged mark.
  return text
    .replace(/\s*\n+\s*/g, " ")
    .replace(/^\s*[-*]\s+/, "")
    .replace(PERSON_MARK_RE, "")
    .trim();
}

function noteLine(date: string, text: string): string {
  return `- ${date} ${text} ${NOTE_FROM_PERSON_MARK}`;
}

/** Appends a note from the person: `- YYYY-MM-DD text (you)`. */
export function addNote(content: string, text: string, date: string): string {
  const clean = cleanNoteText(text);
  if (clean.length === 0) return content;
  const base = content.length === 0 ? "# Assistant notes\n" : content;
  const withNewline = base.endsWith("\n") ? base : `${base}\n`;
  return `${withNewline}${noteLine(date, clean)}\n`;
}

/**
 * Rewrites one note's text. The person edited it, so it becomes theirs:
 * the date stays, the `(you)` mark is added. Empty text removes the line.
 */
export function editNote(content: string, line: number, text: string, today: string): string {
  const lines = content.split("\n");
  const current = lines[line];
  if (current === undefined || !BULLET_RE.test(current)) return content;
  const clean = cleanNoteText(text);
  if (clean.length === 0) return removeLine(content, line);
  const bullet = BULLET_RE.exec(current)?.[1] ?? "";
  const date = DATE_PREFIX_RE.exec(bullet)?.[1] ?? today;
  lines[line] = noteLine(date, clean);
  return lines.join("\n");
}

export function removeLine(content: string, line: number): string {
  const lines = content.split("\n");
  if (line < 0 || line >= lines.length) return content;
  lines.splice(line, 1);
  return lines.join("\n");
}

// ── Merging an edit with what is on disk ─────────────────────────────

function lineCounts(lines: ReadonlyArray<string>): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
  return map;
}

/**
 * Replays the change `base → mine` onto `theirs` (the file as it is now),
 * line by line:
 *
 * - lines `mine` removed from `base` are removed from `theirs` (if still there);
 * - lines `mine` added go right after the line they followed in `mine`
 *   (at the end if that line is gone, at the top if there was none);
 * - every line someone else added to `theirs` stays.
 *
 * Not a full three-way merge: a line both sides changed ends up twice
 * (theirs and mine) rather than lost — duplication is visible and fixable,
 * a silently erased line is not.
 */
export function rebaseEdit(base: string, mine: string, theirs: string): string {
  if (theirs === base) return mine;
  if (mine === base) return theirs;
  const baseLines = base.split("\n");
  const mineLines = mine.split("\n");
  const result = theirs.split("\n");

  const baseCounts = lineCounts(baseLines);
  const mineCounts = lineCounts(mineLines);

  // Removed by me: present in base more often than in mine.
  for (const [line, n] of baseCounts) {
    let removed = n - (mineCounts.get(line) ?? 0);
    while (removed > 0) {
      const at = result.indexOf(line);
      if (at === -1) break;
      result.splice(at, 1);
      removed -= 1;
    }
  }

  // Added by me: occurrences in mine beyond those in base. Each goes right
  // after the line it followed in mine (its anchor), wherever that line is
  // now; an anchor that is gone puts it at the end, no anchor at the top.
  const seenInMine = new Map<string, number>();
  let anchor: string | null = null;
  for (const line of mineLines) {
    const occurrence = (seenInMine.get(line) ?? 0) + 1;
    seenInMine.set(line, occurrence);
    if (occurrence > (baseCounts.get(line) ?? 0)) {
      let at: number;
      if (anchor === null) {
        at = 0;
      } else {
        const anchorAt = result.lastIndexOf(anchor);
        at = anchorAt === -1 ? result.length : anchorAt + 1;
      }
      // Keep the file's trailing newline last.
      if (at === result.length && result.length > 0 && result[result.length - 1] === "") {
        at = result.length - 1;
      }
      result.splice(at, 0, line);
    }
    anchor = line;
  }
  return result.join("\n");
}

// ── ROUTING.md ───────────────────────────────────────────────────────

/** Who set a routing rule. `you` rows the assistant never changes. */
export type RoutingSource = "you" | "learned" | "default";

/** How hard the model thinks, in words the page shows. */
export const ROUTING_THINKING = ["low", "medium", "high", "max"] as const;
export type RoutingThinking = (typeof ROUTING_THINKING)[number];

/** `self`: the assistant answers itself, no chat is started. */
export const ROUTING_SELF_HARNESS = "self";

export interface RoutingRule {
  readonly taskType: string;
  /** Harness instance id (`claudeAgent`, `codex`, `uno`, …) or `self`. */
  readonly harness: string;
  readonly model: string;
  /** Free text from the file; {@link thinkingOf} reads it as a level. */
  readonly effort: string;
  readonly source: RoutingSource;
  readonly note: string;
}

export interface RoutingOutcome {
  readonly text: string;
  readonly ok: boolean | null;
}

export interface ParsedRouting {
  readonly rules: ReadonlyArray<RoutingRule>;
  readonly outcomes: ReadonlyArray<RoutingOutcome>;
  /** The file has a table the page can edit. */
  readonly hasTable: boolean;
}

/** The one sentence the dispatcher must follow about `you` rows. */
export const ROUTING_PERSON_RULE =
  "Rows with Source `you` are the person's rules: follow them, never change or remove them. Rows with `default` or `learned` you may tune from the Outcomes log (mark them `learned`).";

const ROUTING_HEADER = "| Task type | Harness | Model | Effort | Source | Why |";
const ROUTING_DIVIDER = "|---|---|---|---|---|---|";

function splitRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const inner = trimmed.replace(/^\|/, "").replace(/\|\s*$/, "");
  return inner.split("|").map((cell) => cell.trim());
}

function isDivider(cells: ReadonlyArray<string>): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

type Column = "task" | "harness" | "model" | "effort" | "source" | "note";

function columnOf(header: string): Column | null {
  const h = header.toLowerCase();
  if (h.startsWith("task") || h.startsWith("kind")) return "task";
  if (h.startsWith("harness")) return "harness";
  if (h.startsWith("model")) return "model";
  if (h.startsWith("effort") || h.startsWith("thinking")) return "effort";
  if (h.startsWith("source") || h.startsWith("set by")) return "source";
  if (h.startsWith("why") || h.startsWith("note")) return "note";
  return null;
}

function normalizeSource(raw: string): RoutingSource {
  const value = raw.trim().toLowerCase();
  if (value.startsWith("you")) return "you";
  if (value.startsWith("learn")) return "learned";
  return "default";
}

function cleanCell(value: string): string {
  return value
    .replace(/\|/g, "/")
    .replace(/\s*\n+\s*/g, " ")
    .trim();
}

interface TableSpan {
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
  readonly columns: ReadonlyArray<Column | null>;
}

/** The first markdown table whose header names a task and a model column. */
function findRoutingTable(lines: ReadonlyArray<string>): TableSpan | null {
  for (let i = 0; i + 1 < lines.length; i += 1) {
    const header = splitRow(lines[i] ?? "");
    const divider = splitRow(lines[i + 1] ?? "");
    if (!header || !divider || !isDivider(divider)) continue;
    const columns = header.map(columnOf);
    if (!columns.includes("task") || !columns.includes("model")) continue;
    let end = i + 2;
    while (end < lines.length && splitRow(lines[end] ?? "") !== null) end += 1;
    return { start: i, end, columns };
  }
  return null;
}

const OUTCOMES_HEADING_RE = /^#{1,6}\s+outcomes/i;

export function parseRouting(content: string): ParsedRouting {
  const lines = content.split("\n");
  const table = findRoutingTable(lines);
  const rules: RoutingRule[] = [];
  if (table) {
    for (let i = table.start + 2; i < table.end; i += 1) {
      const cells = splitRow(lines[i] ?? "") ?? [];
      const get = (column: Column) => {
        const at = table.columns.indexOf(column);
        return at === -1 ? "" : (cells[at] ?? "");
      };
      const taskType = get("task");
      if (taskType.length === 0) continue;
      rules.push({
        taskType,
        harness: get("harness"),
        model: get("model"),
        effort: get("effort"),
        source: normalizeSource(get("source")),
        note: get("note"),
      });
    }
  }

  const outcomes: RoutingOutcome[] = [];
  const outcomesAt = lines.findIndex((line) => OUTCOMES_HEADING_RE.test(line.trim()));
  if (outcomesAt !== -1) {
    for (const raw of lines.slice(outcomesAt + 1)) {
      const line = raw.trim();
      if (/^#{1,6}\s/.test(line)) break;
      if (line.length === 0 || line.startsWith("<!--")) continue;
      const unbulleted = line.replace(/^[-*]\s+/, "");
      const cells = unbulleted.includes("|")
        ? unbulleted
            .replace(/^\|/, "")
            .replace(/\|\s*$/, "")
            .split("|")
            .map((cell) => cell.trim())
        : null;
      if (cells && isDivider(cells)) continue;
      const text = (
        cells ? cells.filter((cell) => cell.length > 0).join(" · ") : unbulleted
      ).trim();
      if (text.length === 0 || /^date\b/i.test(text)) continue;
      const verdict = text.toLowerCase();
      const ok = /\bfail|\bescalat/.test(verdict) ? false : /\bok\b/.test(verdict) ? true : null;
      outcomes.push({ text, ok });
    }
  }
  return { rules, outcomes, hasTable: table !== null };
}

function ruleRow(rule: RoutingRule): string {
  return `| ${[rule.taskType, rule.harness, rule.model, rule.effort, rule.source, rule.note]
    .map(cleanCell)
    .join(" | ")} |`;
}

/**
 * The file with its routing table replaced by `rules` (in the six-column
 * format). Everything else — notes, the Outcomes log — stays as it is. A
 * file without a table gets one after its first heading. The person rule
 * ({@link ROUTING_PERSON_RULE}) is added once, so an assistant created
 * before it learns it on the first save from the page.
 */
export function writeRouting(content: string, rules: ReadonlyArray<RoutingRule>): string {
  const lines = content.split("\n");
  const table = findRoutingTable(lines);
  const block = [ROUTING_HEADER, ROUTING_DIVIDER, ...rules.map(ruleRow)];
  let next: string[];
  if (table) {
    next = [...lines.slice(0, table.start), ...block, ...lines.slice(table.end)];
  } else {
    const headingAt = lines.findIndex((line) => /^#\s/.test(line));
    const at = headingAt === -1 ? 0 : headingAt + 1;
    next = [...lines.slice(0, at), "", ...block, "", ...lines.slice(at)];
    if (headingAt === -1) next.unshift("# Routing table — which harness/model for which task");
  }
  let out = next.join("\n");
  if (!out.includes("Source `you`")) {
    const tableAt = out.indexOf(ROUTING_HEADER);
    out = `${out.slice(0, tableAt)}${ROUTING_PERSON_RULE}\n\n${out.slice(tableAt)}`;
  }
  return out;
}

/** The thinking level an Effort cell names, or null (default / unknown). */
export function thinkingOf(effort: string): RoutingThinking | null {
  const value = effort.toLowerCase();
  if (/\bmax\b|xhigh|extra/.test(value)) return "max";
  if (/\bhigh\b/.test(value)) return "high";
  if (/\bmedium\b|\bmed\b/.test(value)) return "medium";
  if (/\blow\b|minimal/.test(value)) return "low";
  return null;
}

/**
 * The harness option that carries the thinking level: Claude → `effort`
 * (low…max), Codex → `reasoningEffort` (no `max`: `xhigh`). Others have none.
 */
export function thinkingOption(
  harnessDriver: string,
  thinking: RoutingThinking,
): { readonly id: string; readonly value: string } | null {
  if (harnessDriver === "claudeAgent") return { id: "effort", value: thinking };
  if (harnessDriver === "codex") {
    return { id: "reasoningEffort", value: thinking === "max" ? "xhigh" : thinking };
  }
  return null;
}
