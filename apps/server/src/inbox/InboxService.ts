/**
 * InboxService — keeps the Inbox of this computer and pushes it to windows.
 *
 * - Listens to the orchestration events (`inboxAgentEvents.ts`): a finished
 *   turn, an approval or a question the agent waits on, a failed chat.
 * - Takes posts from apps (App API `POST /v1/notify`) and from built-in parts
 *   of Uno (Office: "Boris commented on report.docx").
 * - Persists the list in the daemon's state dir (`inbox.json`, 0600), so it
 *   survives restarts, and wakes snoozed items when their time comes.
 */
import type {
  InboxItemKind,
  InboxSnapshot,
  InboxSource,
  InboxUpdateInput,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { Context, Duration, Effect, Layer, Option, PubSub, Ref, Schedule, Stream } from "effect";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { lastAssistantAnswer } from "../appSdk/appTasks.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  INITIAL_INBOX_AGENT_STATE,
  agentItemBody,
  inboxGroupKey,
  trackInboxAgentEvent,
  type InboxAgentAction,
  type InboxAgentTrackerState,
} from "./inboxAgentEvents.ts";
import {
  InboxInputError,
  addToInbox,
  applyInboxUpdate,
  parseStoredItems,
  prune,
  toSnapshot,
  wakeSnoozed,
  type InboxPost,
  type StoredInboxItem,
} from "./inboxModel.ts";

const WAKE_CHECK_EVERY = Duration.seconds(20);
const WRITE_DEBOUNCE_MS = 250;
const DONE_DETAIL_MAX = 160;

export class InboxUpdateError extends Error {
  readonly _tag = "InboxUpdateError";
}

export interface InboxServiceShape {
  readonly snapshot: Effect.Effect<InboxSnapshot>;
  /** Every change, as a whole new list. */
  readonly changes: Stream.Stream<InboxSnapshot>;
  readonly update: (input: InboxUpdateInput) => Effect.Effect<InboxSnapshot, InboxUpdateError>;
  /** Apps and built-in parts of Uno tell the person something. */
  readonly post: (post: InboxPost) => Effect.Effect<StoredInboxItem>;
}

export class InboxService extends Context.Service<InboxService, InboxServiceShape>()(
  "t3/inbox/InboxService",
) {}

async function readItems(filePath: string): Promise<StoredInboxItem[]> {
  try {
    return parseStoredItems(JSON.parse(await readFile(filePath, "utf8")));
  } catch {
    return [];
  }
}

async function writeItems(filePath: string, items: ReadonlyArray<StoredInboxItem>) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify({ version: 1, items }), { mode: 0o600 });
  await rename(temp, filePath);
}

function doneDetail(text: string | null): string | null {
  if (!text) return null;
  const line = text
    .replace(/[`*_#>]+/g, "")
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return null;
  return line.length > DONE_DETAIL_MAX ? `${line.slice(0, DONE_DETAIL_MAX - 1)}…` : line;
}

const agentSource = (threadId: ThreadId, title: string): InboxSource => ({
  kind: "agent",
  id: threadId,
  name: title,
  icon: null,
});

export const makeInboxService = (options: { readonly filePath?: string } = {}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const engine = yield* OrchestrationEngineService;
    const projections = yield* ProjectionSnapshotQuery;
    const filePath = options.filePath ?? path.join(config.stateDir, "inbox.json");

    const initial = prune(yield* Effect.promise(() => readItems(filePath)), Date.now());
    const itemsRef = yield* Ref.make<ReadonlyArray<StoredInboxItem>>(initial);
    const changes = yield* PubSub.unbounded<InboxSnapshot>();

    // Writes are coalesced: a burst of events is one write.
    let writeTimer: ReturnType<typeof setTimeout> | null = null;
    let writing: Promise<void> = Promise.resolve();
    const scheduleWrite = () => {
      if (writeTimer !== null) return;
      writeTimer = setTimeout(() => {
        writeTimer = null;
        const items = Effect.runSync(Ref.get(itemsRef));
        writing = writing.then(() => writeItems(filePath, items)).catch(() => undefined);
      }, WRITE_DEBOUNCE_MS);
    };
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        if (writeTimer !== null) {
          clearTimeout(writeTimer);
          writeTimer = null;
          await writeItems(filePath, Effect.runSync(Ref.get(itemsRef))).catch(() => undefined);
        }
        await writing;
      }),
    );

    const snapshot = Ref.get(itemsRef).pipe(Effect.map((items) => toSnapshot(items, Date.now())));

    const commit = (next: ReadonlyArray<StoredInboxItem>) =>
      Effect.gen(function* () {
        yield* Ref.set(itemsRef, next);
        scheduleWrite();
        const current = toSnapshot(next, Date.now());
        yield* PubSub.publish(changes, current);
        return current;
      });

    const post: InboxServiceShape["post"] = (input) =>
      Effect.gen(function* () {
        const items = yield* Ref.get(itemsRef);
        const added = addToInbox(items, input, new Date());
        yield* commit(added.items);
        return added.item;
      });

    const update: InboxServiceShape["update"] = (input) =>
      Effect.gen(function* () {
        const items = yield* Ref.get(itemsRef);
        const next = yield* Effect.try({
          try: () => applyInboxUpdate(items, input, new Date()),
          catch: (cause) =>
            new InboxUpdateError(
              cause instanceof InboxInputError ? cause.message : "Couldn't change the Inbox.",
            ),
        });
        return yield* commit(next);
      });

    // ── Agents ────────────────────────────────────────────────────────────
    const trackerRef = yield* Ref.make<InboxAgentTrackerState>(INITIAL_INBOX_AGENT_STATE);

    const threadShell = (threadId: ThreadId) =>
      projections.getThreadShellById(threadId).pipe(
        Effect.orElseSucceed(() => Option.none<OrchestrationThreadShell>()),
        Effect.map(Option.getOrNull),
      );

    const handleAction = (action: InboxAgentAction) =>
      Effect.gen(function* () {
        if (action.type === "resolve") {
          const items = yield* Ref.get(itemsRef);
          const kinds = new Set<InboxItemKind>(action.kinds);
          const at = new Date().toISOString();
          let changed = false;
          const next = items.map((item) => {
            if (
              item.readAt === null &&
              kinds.has(item.kind) &&
              item.open?.kind === "thread" &&
              item.open.threadId === action.threadId
            ) {
              changed = true;
              return { ...item, readAt: at };
            }
            return item;
          });
          if (changed) yield* commit(next);
          return;
        }
        const shell = yield* threadShell(action.threadId);
        // Archived or deleted chats don't come back through the Inbox.
        if (shell === null || shell.archivedAt !== null) return;
        let detail = action.detail;
        if (action.kind === "agent.done") {
          const thread = yield* projections
            .getThreadDetailById(action.threadId)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          detail = Option.isSome(thread) ? doneDetail(lastAssistantAnswer(thread.value)) : null;
        }
        yield* post({
          kind: action.kind,
          source: agentSource(action.threadId, shell.title),
          title: shell.title,
          body: agentItemBody(action.kind, detail),
          open: { kind: "thread", threadId: action.threadId },
          groupKey: inboxGroupKey(action.threadId, action.kind),
        });
      });

    yield* Effect.forkScoped(
      engine.streamDomainEvents.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            const actions = yield* Ref.modify(trackerRef, (state) => {
              const next = trackInboxAgentEvent(state, event);
              return [next.actions, next.state] as const;
            });
            for (const action of actions) yield* handleAction(action);
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("inbox: failed on an orchestration event", {
                eventType: event.type,
                cause,
              }),
            ),
          ),
        ),
      ),
    );

    // ── Snoozes ───────────────────────────────────────────────────────────
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        const items = yield* Ref.get(itemsRef);
        const woke = wakeSnoozed(items, Date.now());
        if (woke.woke.length > 0) yield* commit(woke.items);
      }).pipe(Effect.repeat(Schedule.spaced(WAKE_CHECK_EVERY))),
    );

    return {
      snapshot,
      get changes() {
        return Stream.fromPubSub(changes);
      },
      update,
      post,
    } satisfies InboxServiceShape;
  });

export const InboxServiceLive = Layer.effect(InboxService, makeInboxService());
