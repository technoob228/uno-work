/**
 * File openers — the extension point of the Files app.
 *
 * An opener says which files it can show (`match` returns a score; highest
 * wins, 0 = no), renders them (`View`) and optionally edits them in the
 * browser (`Editor`). Built-in openers cover images, PDF, web pages,
 * markdown/text/code, CSV/Excel, Word and PowerPoint (see `openers/`).
 *
 * A full office engine (Univer, OnlyOffice, Collabora, …) plugs in by
 * registering an opener with a higher score for its formats:
 *
 * ```ts
 * registerFileOpener({
 *   id: "onlyoffice",
 *   label: "Office",
 *   match: (file) => (["document", "spreadsheet", "presentation"].includes(file.kind) ? 100 : 0),
 *   View: OfficeView,
 *   Editor: OfficeEditor,
 * });
 * ```
 *
 * Openers never talk to the daemon directly: they get a `FileSource` that
 * reads bytes and saves atomically on the right machine.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import type { ComponentType } from "react";

import type { FileKind } from "./fileTypes";

export interface FileDescriptor {
  readonly name: string;
  readonly path: string;
  readonly kind: FileKind;
  readonly size: number;
  readonly modifiedAt: string;
}

export interface FileSource extends FileDescriptor {
  readonly environmentId: EnvironmentId;
  /** The whole file. Cached per path + modification time. */
  readonly readBytes: () => Promise<ArrayBuffer>;
  readonly readText: () => Promise<string>;
  /**
   * A URL the browser can load directly (img/iframe/video): streamed from the
   * daemon when possible, otherwise an object URL over `readBytes`.
   */
  readonly getUrl: (mimeType: string) => Promise<{ url: string; release: () => void }>;
  /** Replace the file's contents atomically. */
  readonly save: (contents: string | Uint8Array | ArrayBuffer) => Promise<void>;
}

export interface FileViewProps {
  readonly source: FileSource;
}

export interface FileEditorProps {
  readonly source: FileSource;
  /** Leave edit mode; `saved` tells the shell to refresh the file. */
  readonly onClose: (saved: boolean) => void;
  /** Lets the shell warn before throwing away unsaved changes. */
  readonly onDirtyChange: (dirty: boolean) => void;
}

export interface FileOpener {
  readonly id: string;
  /** Shown as "Opened with …" in the viewer footer. */
  readonly label: string;
  readonly match: (file: FileDescriptor) => number;
  readonly View: ComponentType<FileViewProps>;
  readonly Editor?: ComponentType<FileEditorProps>;
  /** Label of the edit button, e.g. "Edit" or "Edit cells". */
  readonly editLabel?: string;
  /**
   * For formats the browser shows but doesn't edit: how to change them
   * (download → edit in its app → upload a new version).
   */
  readonly editOutsideHint?: string;
  /** Files bigger than this aren't opened in the browser (download only). */
  readonly maxBytes?: number;
}

const openers = new Map<string, FileOpener>();
const listeners = new Set<() => void>();
let version = 0;

/** Add (or replace, by id) an opener. Returns a function that removes it. */
export function registerFileOpener(opener: FileOpener): () => void {
  openers.set(opener.id, opener);
  version += 1;
  for (const listener of listeners) listener();
  return () => {
    if (openers.get(opener.id) !== opener) return;
    openers.delete(opener.id);
    version += 1;
    for (const listener of listeners) listener();
  };
}

/** The best opener for a file, or null when nothing can show it. */
export function resolveFileOpener(file: FileDescriptor): FileOpener | null {
  let best: FileOpener | null = null;
  let bestScore = 0;
  for (const opener of openers.values()) {
    const score = opener.match(file);
    if (score > bestScore) {
      best = opener;
      bestScore = score;
    }
  }
  if (best?.maxBytes !== undefined && file.size > best.maxBytes) return null;
  return best;
}

export function listFileOpeners(): ReadonlyArray<FileOpener> {
  return [...openers.values()];
}

/** For `useSyncExternalStore`: re-render when openers change at runtime. */
export function subscribeFileOpeners(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function fileOpenersVersion(): number {
  return version;
}
