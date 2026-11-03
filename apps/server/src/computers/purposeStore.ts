/**
 * What each of the person's own computers is for (computers lifecycle,
 * contracts computers.ts): a small JSON file in the state folder, written
 * atomically. A computer missing from it is a tool for agents.
 *
 * Read by the UI (`computers.state`) and by the tool routing of chats on a
 * full computer (backend stream, CONTRACT.md §2).
 *
 * @module computers/purposeStore
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ComputerPurpose, ComputerPurposeEntry } from "@t3tools/contracts";

export const PURPOSES_FILE = "computers-lifecycle.json";

interface StoredFile {
  readonly v: 1;
  readonly purposes: Readonly<Record<string, ComputerPurpose>>;
}

export interface PurposeStore {
  readonly list: () => ReadonlyArray<ComputerPurposeEntry>;
  readonly purposeOf: (computerId: string) => ComputerPurpose;
  readonly set: (computerId: string, purpose: ComputerPurpose) => void;
  readonly forget: (computerId: string) => void;
}

function readPurposes(file: string): Record<string, ComputerPurpose> {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredFile> | null;
    const out: Record<string, ComputerPurpose> = {};
    for (const [id, value] of Object.entries(parsed?.purposes ?? {})) {
      if (value === "tool" || value === "full") out[id] = value;
    }
    return out;
  } catch {
    // No file yet, or a damaged one: every computer is a tool.
    return {};
  }
}

export function makePurposeStore(stateDir: string): PurposeStore {
  const file = path.join(stateDir, PURPOSES_FILE);
  let purposes = readPurposes(file);
  const save = () => {
    mkdirSync(stateDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const body: StoredFile = { v: 1, purposes };
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  };
  return {
    list: () =>
      Object.entries(purposes)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([computerId, purpose]) => ({ computerId, purpose })),
    purposeOf: (computerId) => purposes[computerId] ?? "tool",
    set: (computerId, purpose) => {
      if (purposes[computerId] === purpose) return;
      purposes = { ...purposes, [computerId]: purpose };
      save();
    },
    forget: (computerId) => {
      if (!(computerId in purposes)) return;
      const next = { ...purposes };
      delete next[computerId];
      purposes = next;
      save();
    },
  };
}

/** `UNO_WORK_COMPUTERS_LIFECYCLE=on|off` beats the console's answer; anything else: no say. */
export function lifecycleOverride(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "on" || normalized === "1" || normalized === "true") return true;
  if (normalized === "off" || normalized === "0" || normalized === "false") return false;
  return null;
}
