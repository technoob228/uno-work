import type { PreviewFile } from "./PreviewPaneContext";

export function computeRelativePath(absolutePath: string, projectCwd: string): string | null {
  const normalizedCwd = projectCwd.replace(/[\\/]+$/, "");
  if (!absolutePath.startsWith(normalizedCwd)) return null;
  return absolutePath.slice(normalizedCwd.length).replace(/^[\\/]+/, "");
}

export function resolveWriteTarget(
  file: PreviewFile,
): { cwd: string; relativePath: string } | null {
  if (!file.path) return null;
  if (file.projectCwd) {
    const rel = computeRelativePath(file.path, file.projectCwd);
    if (rel !== null) return { cwd: file.projectCwd, relativePath: rel };
  }
  const match = file.path.match(/^(.*)[\\/]([^\\/]+)$/);
  if (!match) return null;
  const [, parentDir, basename] = match;
  if (!parentDir || !basename) return null;
  return { cwd: parentDir, relativePath: basename };
}

export function parseDelimitedRows(input: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      current.push(field);
      field = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i += 1;
      current.push(field);
      rows.push(current);
      current = [];
      field = "";
      continue;
    }
    field += ch;
  }
  if (field.length > 0 || current.length > 0) {
    current.push(field);
    rows.push(current);
  }
  return rows.filter((row) => row.length > 1 || (row[0] ?? "").length > 0);
}

export function serializeDelimitedRows(
  rows: ReadonlyArray<ReadonlyArray<string>>,
  delimiter: string,
): string {
  const lines = rows.map((row) =>
    row
      .map((cell) => {
        if (cell.includes('"') || cell.includes(delimiter) || /[\r\n]/.test(cell)) {
          return `"${cell.replaceAll('"', '""')}"`;
        }
        return cell;
      })
      .join(delimiter),
  );
  return lines.join("\n") + "\n";
}

export function spreadsheetColumnLabel(index: number): string {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

export function delimiterForFileName(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return ext === "tsv" ? "\t" : ",";
}
