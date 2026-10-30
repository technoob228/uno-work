/**
 * Which mentions of an answer are real files: asked of the computer in
 * batches, kept here so a chat that scrolls or reopens doesn't ask again and
 * the chips don't flicker. Rows of a chat mount together, so their questions
 * meet in one call. A stale answer stays on screen while a fresh one comes.
 */
import {
  FILES_MENTIONS_MAX,
  type EnvironmentId,
  type FilesEntryKind,
  type FilesResolveMentionsInput,
  type FilesResolveMentionsResult,
} from "@t3tools/contracts";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { readEnvironmentApi } from "../../environmentApi";

export type FileMentionState =
  | { readonly status: "found"; readonly path: string; readonly kind: FilesEntryKind }
  | { readonly status: "missing" }
  /** The computer couldn't say (asleep, or a version without the call). */
  | { readonly status: "unknown" };

const FOUND_FOR_MS = 5 * 60_000;
/** Short: the agent may be about to create the file it's talking about. */
const MISSING_FOR_MS = 20_000;
const UNKNOWN_FOR_MS = 60_000;
const MAX_ENTRIES = 5_000;
const GATHER_MS = 30;

type Resolve = (
  environmentId: EnvironmentId,
  input: FilesResolveMentionsInput,
) => Promise<FilesResolveMentionsResult>;

interface Entry {
  state: FileMentionState;
  freshUntil: number;
}

interface Batch {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | undefined;
  readonly mentions: Set<string>;
}

const keyOf = (environmentId: EnvironmentId, cwd: string | undefined, mention: string) =>
  `${environmentId}\u0000${cwd ?? ""}\u0000${mention}`;

export function createFileMentionStore(resolve: Resolve, now: () => number = Date.now) {
  const entries = new Map<string, Entry>();
  const listeners = new Map<string, Set<() => void>>();
  const inFlight = new Set<string>();
  const batches = new Map<string, Batch>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const publish = (key: string, state: FileMentionState, lifetime: number) => {
    const previous = entries.get(key);
    const same =
      previous &&
      previous.state.status === state.status &&
      (state.status !== "found" ||
        (previous.state.status === "found" &&
          previous.state.path === state.path &&
          previous.state.kind === state.kind));
    // Newest last: the oldest entry is the first to go.
    entries.delete(key);
    entries.set(key, { state: same ? previous.state : state, freshUntil: now() + lifetime });
    if (entries.size > MAX_ENTRIES) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
    if (!same) for (const listener of listeners.get(key) ?? []) listener();
  };

  const send = async (batch: Batch, mentions: string[]) => {
    const keys = mentions.map((mention) => keyOf(batch.environmentId, batch.cwd, mention));
    try {
      const { results } = await resolve(batch.environmentId, {
        ...(batch.cwd ? { cwd: batch.cwd } : {}),
        mentions,
      });
      const byMention = new Map(results.map((result) => [result.mention, result]));
      mentions.forEach((mention, index) => {
        const result = byMention.get(mention);
        if (result?.path && result.kind) {
          const state = { status: "found", path: result.path, kind: result.kind } as const;
          publish(keys[index]!, state, FOUND_FOR_MS);
        } else {
          publish(keys[index]!, { status: "missing" }, MISSING_FOR_MS);
        }
      });
    } catch {
      for (const key of keys) publish(key, { status: "unknown" }, UNKNOWN_FOR_MS);
    } finally {
      for (const key of keys) inFlight.delete(key);
    }
  };

  const flush = () => {
    timer = null;
    const pending = [...batches.values()];
    batches.clear();
    for (const batch of pending) {
      const mentions = [...batch.mentions];
      for (let index = 0; index < mentions.length; index += FILES_MENTIONS_MAX) {
        void send(batch, mentions.slice(index, index + FILES_MENTIONS_MAX));
      }
    }
  };

  return {
    get(environmentId: EnvironmentId | undefined, cwd: string | undefined, mention: string) {
      if (!environmentId) return null;
      return entries.get(keyOf(environmentId, cwd, mention))?.state ?? null;
    },

    subscribe(
      environmentId: EnvironmentId | undefined,
      cwd: string | undefined,
      mention: string,
      listener: () => void,
    ) {
      if (!environmentId) return () => undefined;
      const key = keyOf(environmentId, cwd, mention);
      const set = listeners.get(key) ?? new Set();
      set.add(listener);
      listeners.set(key, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(key);
      };
    },

    /** Ask, unless a fresh answer is here or already on its way. */
    request(environmentId: EnvironmentId, cwd: string | undefined, mention: string) {
      const key = keyOf(environmentId, cwd, mention);
      const entry = entries.get(key);
      if ((entry && entry.freshUntil > now()) || inFlight.has(key)) return;
      inFlight.add(key);
      const batchKey = `${environmentId}\u0000${cwd ?? ""}`;
      const batch = batches.get(batchKey) ?? { environmentId, cwd, mentions: new Set<string>() };
      batch.mentions.add(mention);
      batches.set(batchKey, batch);
      timer ??= setTimeout(flush, GATHER_MS);
    },
  };
}

const store = createFileMentionStore(async (environmentId, input) => {
  const api = readEnvironmentApi(environmentId);
  if (!api) throw new Error("This computer isn't connected.");
  return api.files.resolveMentions(input);
});

/**
 * What the computer says about a mention; null until it has. Nothing is asked
 * while `ask` is false (an answer still being written).
 */
export function useFileMention(
  environmentId: EnvironmentId | undefined,
  cwd: string | undefined,
  mention: string,
  ask: boolean,
): FileMentionState | null {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(environmentId, cwd, mention, listener),
    [cwd, environmentId, mention],
  );
  const state = useSyncExternalStore(subscribe, () => store.get(environmentId, cwd, mention));
  useEffect(() => {
    if (ask && environmentId) store.request(environmentId, cwd, mention);
  }, [ask, cwd, environmentId, mention]);
  return state;
}
