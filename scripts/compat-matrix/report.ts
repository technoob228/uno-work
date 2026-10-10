/** The matrix as text: one row per daemon, one column per check, reasons below. */
import { CHECKS, type SmokeResults } from "./smoke.ts";

export interface MatrixColumn {
  /** `current` or the release asked for. */
  readonly name: string;
  /** What the daemon reported as its version. */
  readonly version: string;
  readonly isCurrent: boolean;
  readonly results: SmokeResults;
}

const MARK = { pass: "✅", fail: "❌" } as const;

export function columnLabel(column: MatrixColumn): string {
  return column.isCurrent ? `current (${column.version})` : column.name;
}

export function formatMatrix(input: {
  readonly webVersion: string;
  readonly commit: string;
  readonly columns: ReadonlyArray<MatrixColumn>;
  readonly seconds: number;
}): string {
  const lines: Array<string> = [];
  lines.push(
    `Fresh web ${input.webVersion} (${input.commit}) against each daemon, ${input.seconds} s in total`,
    "",
    `| Daemon | ${CHECKS.map((check) => check.title).join(" | ")} |`,
    `|---|${CHECKS.map(() => "---").join("|")}|`,
  );
  for (const column of input.columns) {
    lines.push(
      `| ${columnLabel(column)} | ${CHECKS.map((check) => MARK[column.results[check.id].status]).join(" | ")} |`,
    );
  }

  const failures = input.columns.flatMap((column) =>
    CHECKS.filter((check) => column.results[check.id].status === "fail").map(
      (check) => `- ${columnLabel(column)} · ${check.title}: ${column.results[check.id].reason}`,
    ),
  );
  lines.push("", failures.length === 0 ? "No ❌." : `❌ ${failures.length}:`, ...failures);

  lines.push("", "What was seen:");
  for (const column of input.columns) {
    lines.push(`- ${columnLabel(column)}`);
    for (const check of CHECKS) {
      const result = column.results[check.id];
      if (result.status === "pass") lines.push(`  - ${check.title}: ${result.reason}`);
      for (const note of result.notes) lines.push(`    - note: ${note}`);
    }
  }
  return lines.join("\n");
}
