/** The Files tab's tree and search; pure, so both are tested without a diff on screen. */
import type { PullRequestDiffFile } from "@t3tools/contracts";

export type PullRequestFileTreeNode =
  | {
      readonly kind: "directory";
      readonly name: string;
      readonly path: string;
      readonly children: ReadonlyArray<PullRequestFileTreeNode>;
    }
  | {
      readonly kind: "file";
      readonly name: string;
      readonly path: string;
      readonly file: PullRequestDiffFile;
    };

interface Draft {
  readonly directories: Map<string, Draft>;
  readonly files: Array<{ readonly name: string; readonly file: PullRequestDiffFile }>;
}

const emptyDraft = (): Draft => ({ directories: new Map(), files: [] });

function toNodes(draft: Draft, prefix: string): ReadonlyArray<PullRequestFileTreeNode> {
  const directories = [...draft.directories.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, child]): PullRequestFileTreeNode => {
      // A chain of single folders reads as one line, as on the hosts' own sites.
      let label = name;
      let current = child;
      while (current.files.length === 0 && current.directories.size === 1) {
        const [nextName, next] = [...current.directories.entries()][0]!;
        label = `${label}/${nextName}`;
        current = next;
      }
      const path = `${prefix}${label}`;
      return { kind: "directory", name: label, path, children: toNodes(current, `${path}/`) };
    });
  const files = draft.files
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .map(
      ({ name, file }): PullRequestFileTreeNode => ({
        kind: "file",
        name,
        path: file.path,
        file,
      }),
    );
  return [...directories, ...files];
}

export function fileTree(
  files: ReadonlyArray<PullRequestDiffFile>,
): ReadonlyArray<PullRequestFileTreeNode> {
  const root = emptyDraft();
  for (const file of files) {
    const parts = file.path.split("/");
    const name = parts.pop() ?? file.path;
    let current = root;
    for (const part of parts) {
      let next = current.directories.get(part);
      if (next === undefined) {
        next = emptyDraft();
        current.directories.set(part, next);
      }
      current = next;
    }
    current.files.push({ name, file });
  }
  return toNodes(root, "");
}

/** A unified diff, cut per file: path → its changed lines, lowercased for search. */
export function patchTextByFile(patch: string): ReadonlyMap<string, string> {
  const texts = new Map<string, string>();
  let path: string | null = null;
  let lines: string[] = [];
  const flush = () => {
    if (path !== null) texts.set(path, lines.join("\n").toLowerCase());
    lines = [];
  };
  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/.* b\/(.*)$/u.exec(line);
    if (header) {
      flush();
      path = header[1] ?? null;
    } else if (/^[+-](?![+-]{2} )/u.test(line)) {
      lines.push(line.slice(1));
    }
  }
  flush();
  return texts;
}

export function filesMatchingSearch(
  files: ReadonlyArray<PullRequestDiffFile>,
  texts: ReadonlyMap<string, string>,
  search: string,
): ReadonlyArray<PullRequestDiffFile> {
  const needle = search.trim().toLowerCase();
  if (needle.length === 0) return files;
  return files.filter(
    (file) => file.path.toLowerCase().includes(needle) || texts.get(file.path)?.includes(needle),
  );
}
