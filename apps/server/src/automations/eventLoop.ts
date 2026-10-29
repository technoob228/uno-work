/**
 * The automations queue of this computer, pulled by the daemon itself — the
 * same principle as the Telegram relay: the console keeps the events (and
 * wakes a sleeping computer), the daemon long-polls them with its own
 * machine token. Nothing reaches into the machine from outside, so the
 * person's security journal stays clean.
 *
 * For each event: already done here (a local journal of the last 500 ids,
 * `stateDir/automations-processed.json` — delivery is at-least-once)? skip.
 * Else `claim` it, wake the assistant with the event
 * (`AssistantScheduledTurns.runEvent`, its "Automations" thread; Uno's main
 * conversation) and report `result` (done / failed, a summary, the thread).
 * One event at a time per assistant: two pushes in a row never race in one
 * thread; different assistants run side by side.
 *
 * Runs only on a cloud computer with a machine token; elsewhere (a laptop)
 * it looks again every 10 minutes (a computer may be linked later). A
 * console without automations (404 `AUTOMATIONS_DISABLED`) is asked again
 * every 10 minutes; network trouble backs off from 2 s to 5 minutes.
 *
 * @module automations/eventLoop
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { AUTOMATION_THREAD_TITLE, ProjectId } from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";
import * as Semaphore from "effect/Semaphore";

import {
  AssistantScheduledTurns,
  type AssistantEventTurnInput,
  type AssistantEventTurnResult,
  type AssistantTurnError,
  type ChatTurnInput,
  type ChatTurnResult,
} from "../assistants/scheduledTurn.ts";
import { ServerConfig } from "../config.ts";
import { readWorkMachineIdentity } from "../manager/workConsole.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { AutomationsService } from "./AutomationsService.ts";
import type {
  AutomationClientError,
  AutomationEvent,
  AutomationResultBody,
  AutomationsClient,
} from "./consoleClient.ts";
import {
  automationChatPrompt,
  automationEventPrompt,
  automationHeader,
  automationSummary,
  oneLine,
} from "./prompt.ts";

export const AUTOMATION_SOURCE = "automation";
export const PROCESSED_FILE = "automations-processed.json";
export const PROCESSED_KEEP = 500;
/** How long the console holds the long-poll (its maximum). */
export const POLL_WAIT_SEC = 25;
/** Not a cloud computer, or automations off for the account: look again then. */
export const IDLE_RECHECK_MS = 10 * 60_000;
const BACKOFF_START_MS = 2_000;
const BACKOFF_MAX_MS = 5 * 60_000;
/** A console that answers an empty long-poll at once (no wait) is not spun on. */
const FAST_EMPTY_MS = 1_000;
const FAST_EMPTY_PAUSE_MS = 5_000;
/** One automation turn at most; the console fails a run after 45 minutes. */
const TURN_TIMEOUT_SEC = 30 * 60;
const RESULT_ATTEMPTS = 3;

// ── Journal of processed events ────────────────────────────────────────

export interface ProcessedJournal {
  readonly has: (id: number) => boolean;
  readonly add: (id: number) => Effect.Effect<void>;
}

/** Ids from the journal file (the last `keep`), or none. */
export function parseProcessed(raw: unknown, keep = PROCESSED_KEEP): ReadonlyArray<number> {
  const ids =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["ids"] : null;
  if (!Array.isArray(ids)) return [];
  return ids
    .filter((id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0)
    .slice(-keep);
}

export const makeFileJournal = (file: string, keep = PROCESSED_KEEP) =>
  Effect.gen(function* () {
    const loaded = yield* Effect.promise(async () => {
      try {
        return parseProcessed(JSON.parse(await fs.readFile(file, "utf8")), keep);
      } catch {
        return [];
      }
    });
    const ids: number[] = [...loaded];
    const set = new Set(ids);
    const lock = yield* Semaphore.make(1);
    const journal: ProcessedJournal = {
      has: (id) => set.has(id),
      add: (id) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            if (set.has(id)) return;
            ids.push(id);
            set.add(id);
            while (ids.length > keep) set.delete(ids.shift()!);
            const snapshot = JSON.stringify({ ids });
            yield* Effect.promise(async () => {
              await fs.mkdir(path.dirname(file), { recursive: true });
              const tmp = `${file}.${process.pid}.tmp`;
              await fs.writeFile(tmp, snapshot, { mode: 0o600 });
              await fs.rename(tmp, file);
            }).pipe(Effect.ignoreCause({ log: true }));
          }),
        ),
    };
    return journal;
  });

export const makeMemoryJournal = (keep = PROCESSED_KEEP): ProcessedJournal => {
  const ids: number[] = [];
  const set = new Set<number>();
  return {
    has: (id) => set.has(id),
    add: (id) =>
      Effect.sync(() => {
        if (set.has(id)) return;
        ids.push(id);
        set.add(id);
        while (ids.length > keep) set.delete(ids.shift()!);
      }),
  };
};

// ── The loop ───────────────────────────────────────────────────────────

export interface AutomationEventLoopDeps {
  readonly client: Pick<AutomationsClient, "events" | "claim" | "result">;
  readonly journal: ProcessedJournal;
  /** This computer is a cloud computer with a machine token. */
  readonly linked: Effect.Effect<boolean>;
  /** The assistant's name here, or null when it isn't on this computer. */
  readonly assistantName: (assistant: string) => Effect.Effect<string | null>;
  readonly runTurn: (
    input: AssistantEventTurnInput,
  ) => Effect.Effect<AssistantEventTurnResult, AssistantTurnError>;
  /** A run in a chat (executor "chat" / "new_chat"); absent — such runs fail with a note. */
  readonly runChatTurn?: (input: ChatTurnInput) => Effect.Effect<ChatTurnResult, AssistantTurnError>;
  readonly now?: () => number;
}

/** "<name> · Oct 29" — the title of a new chat an automation opens. */
export function newChatTitle(name: string, nowMs: number): string {
  const day = new Date(nowMs).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${oneLine(name, 80) || "Automation"} · ${day}`;
}

/** The console's answer for a finished run in a chat. */
export function resultOfChatTurn(
  turn:
    | { readonly ok: true; readonly result: ChatTurnResult }
    | { readonly ok: false; readonly message: string },
): AutomationResultBody {
  if (!turn.ok) return { state: "failed", reason: turn.message };
  const { result } = turn;
  return result.status === "timeout"
    ? {
        state: "failed",
        reason: automationSummary({ kind: "timeout", minutes: TURN_TIMEOUT_SEC / 60 }),
        threadId: result.threadId,
      }
    : {
        state: "done",
        summary: automationSummary({ kind: "answered", text: result.reply ?? "" }),
        threadId: result.threadId,
      };
}

/** 5xx or no answer: worth another try. A 4xx is the console's final word. */
export function isRetryableConsoleError(error: AutomationClientError): boolean {
  return error.code === "CONSOLE_UNREACHABLE" || error.status >= 500;
}

/** What one poll means for the next one. */
export type PollOutcome =
  | { readonly kind: "events"; readonly count: number }
  | { readonly kind: "idle"; readonly reason: "not_linked" | "disabled" }
  | { readonly kind: "error"; readonly error: AutomationClientError };

/** The wait before the next poll; `failures` counts errors in a row. */
export function nextPollDelayMs(outcome: PollOutcome, failures: number, tookMs: number): number {
  switch (outcome.kind) {
    case "idle":
      return IDLE_RECHECK_MS;
    case "error":
      return Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** Math.max(0, failures - 1));
    case "events":
      return outcome.count === 0 && tookMs < FAST_EMPTY_MS ? FAST_EMPTY_PAUSE_MS : 0;
  }
}

/** The console's answer for a finished turn. */
export function resultOfTurn(
  turn:
    | { readonly ok: true; readonly result: AssistantEventTurnResult }
    | { readonly ok: false; readonly message: string },
): AutomationResultBody {
  if (!turn.ok) return { state: "failed", reason: turn.message };
  const { result } = turn;
  switch (result.status) {
    case "timeout":
      return {
        state: "failed",
        reason: automationSummary({ kind: "timeout", minutes: TURN_TIMEOUT_SEC / 60 }),
        threadId: result.threadId,
      };
    case "no_reply":
      return {
        state: "done",
        summary: automationSummary({ kind: "handed_off" }),
        threadId: result.threadId,
      };
    case "delivered":
    case "undelivered":
      return {
        state: "done",
        summary: automationSummary({ kind: "answered", text: result.reply ?? "" }),
        threadId: result.threadId,
      };
  }
}

export const makeAutomationEventLoop = (deps: AutomationEventLoopDeps) =>
  Effect.sync(() => {
    const now = deps.now ?? Date.now;
    let after = 0;
    const inFlight = new Set<number>();
    const lanes = new Map<string, Semaphore.Semaphore>();
    const lane = (assistant: string) =>
      Effect.gen(function* () {
        const existing = lanes.get(assistant);
        if (existing !== undefined) return existing;
        const made = yield* Semaphore.make(1);
        lanes.set(assistant, made);
        return made;
      });

    /** The result, a few times over a short outage; the console's janitor covers the rest. */
    const report = (event: AutomationEvent, body: AutomationResultBody) =>
      deps.client.result(event.id, body).pipe(
        // Only a console that didn't answer is asked again; a 4xx (409
        // ALREADY_FINISHED, 404) is final.
        Effect.retry({ times: RESULT_ATTEMPTS - 1, while: isRetryableConsoleError }),
        Effect.tap(() =>
          Effect.logInfo("automation run finished").pipe(
            Effect.annotateLogs({
              eventId: event.id,
              automationId: event.automationId,
              state: body.state,
            }),
          ),
        ),
        Effect.catch((error) =>
          Effect.logWarning("automation result not reported").pipe(
            Effect.annotateLogs({ eventId: event.id, error: error.message }),
          ),
        ),
      );

    /** One event, start to end. Never fails. */
    const processEvent = (event: AutomationEvent) =>
      Effect.gen(function* () {
        if (deps.journal.has(event.id)) return "duplicate" as const;
        const claimed = yield* deps.client.claim(event.id).pipe(
          Effect.map((outcome) => ({ ok: true as const, outcome })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
        );
        if (!claimed.ok) {
          // Not taken: it stays in the queue; the next poll lists it again.
          after = Math.min(after, event.id - 1);
          yield* Effect.logWarning("automation event not claimed").pipe(
            Effect.annotateLogs({ eventId: event.id, error: claimed.error.message }),
          );
          return "unclaimed" as const;
        }
        yield* deps.journal.add(event.id);
        if (claimed.outcome === "already_claimed") return "already_claimed" as const;

        const executor = event.executor;
        if (executor.kind !== "assistant") {
          if (deps.runChatTurn === undefined) {
            yield* report(event, {
              state: "failed",
              reason: "This Uno Work can't run automations in a chat yet — update it.",
            });
            return "no_assistant" as const;
          }
          const chatTurn = yield* deps
            .runChatTurn({
              target:
                executor.kind === "chat"
                  ? { kind: "chat", threadId: executor.threadId }
                  : {
                      kind: "new_chat",
                      projectId: executor.projectId,
                      fromThreadId: executor.fromThreadId,
                      title: newChatTitle(event.name, now()),
                    },
              prompt: automationChatPrompt(event),
              timeoutSec: TURN_TIMEOUT_SEC,
              reason: `automation ${event.automationId}`,
            })
            .pipe(
              Effect.map((result) => ({ ok: true as const, result })),
              Effect.catch((error) =>
                Effect.succeed({ ok: false as const, message: error.message }),
              ),
            );
          yield* report(event, resultOfChatTurn(chatTurn));
          return "ran" as const;
        }

        const name = yield* deps.assistantName(event.assistant);
        if (name === null) {
          yield* report(event, {
            state: "failed",
            reason: `The assistant ${oneLine(event.assistantName, 80) || event.assistant} isn't on this computer any more — move the automation to another assistant or delete it.`,
          });
          return "no_assistant" as const;
        }
        const turn = yield* deps
          .runTurn({
            projectId: ProjectId.make(event.assistant),
            prompt: automationEventPrompt(event),
            header: automationHeader(event.name),
            threadTitle: AUTOMATION_THREAD_TITLE,
            source: AUTOMATION_SOURCE,
            timeoutSec: TURN_TIMEOUT_SEC,
          })
          .pipe(
            Effect.map((result) => ({ ok: true as const, result })),
            Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
          );
        yield* report(event, resultOfTurn(turn));
        return "ran" as const;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("automation event failed", { cause }).pipe(
            Effect.andThen(
              report(event, {
                state: "failed",
                reason: "Uno Work hit an error running it. It will run again on the next event.",
              }),
            ),
            Effect.as("error" as const),
          ),
        ),
      );

    /** Hand an event to its assistant's lane (one at a time per assistant). */
    const dispatch = (event: AutomationEvent) =>
      Effect.gen(function* () {
        if (deps.journal.has(event.id) || inFlight.has(event.id)) return false;
        inFlight.add(event.id);
        const sem = yield* lane(event.assistant);
        yield* Effect.forkDetach(
          sem
            .withPermits(1)(processEvent(event))
            .pipe(Effect.ensuring(Effect.sync(() => inFlight.delete(event.id)))),
        );
        return true;
      });

    /** One long-poll; the events go to their lanes. */
    const pollOnce = (waitSec = POLL_WAIT_SEC) =>
      Effect.gen(function* () {
        if (!(yield* deps.linked)) return { kind: "idle", reason: "not_linked" } as PollOutcome;
        const listed = yield* deps.client.events({ after, waitSec }).pipe(
          Effect.map((events) => ({ ok: true as const, events })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
        );
        if (!listed.ok) {
          return listed.error.code === "AUTOMATIONS_DISABLED"
            ? ({ kind: "idle", reason: "disabled" } as PollOutcome)
            : listed.error.code === "NOT_CLOUD_COMPUTER"
              ? ({ kind: "idle", reason: "not_linked" } as PollOutcome)
              : ({ kind: "error", error: listed.error } as PollOutcome);
        }
        for (const event of listed.events.toSorted((a, b) => a.id - b.id)) {
          after = Math.max(after, event.id);
          yield* dispatch(event);
        }
        return { kind: "events", count: listed.events.length } as PollOutcome;
      });

    const run = Effect.gen(function* () {
      let failures = 0;
      let lastIdle: string | null = null;
      while (true) {
        const started = now();
        const outcome = yield* pollOnce();
        failures = outcome.kind === "error" ? failures + 1 : 0;
        if (outcome.kind === "error" && (failures === 1 || failures % 10 === 0)) {
          yield* Effect.logWarning("automations poll failed").pipe(
            Effect.annotateLogs({ failures, error: outcome.error.message }),
          );
        }
        const idle = outcome.kind === "idle" ? outcome.reason : null;
        if (idle !== lastIdle) {
          lastIdle = idle;
          yield* Effect.logInfo(
            idle === null ? "automations: polling" : `automations: idle (${idle})`,
          );
        }
        const delay = nextPollDelayMs(outcome, failures, now() - started);
        if (delay > 0) yield* Effect.sleep(delay);
      }
    });

    return {
      pollOnce,
      processEvent,
      run,
      cursor: () => after,
      inFlight: () => inFlight.size,
    };
  });

/** Starts with the server; idles off a cloud computer. */
export const AutomationEventLoopLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const settings = yield* ServerSettingsService;
    const automations = yield* AutomationsService;
    const turns = yield* Effect.serviceOption(AssistantScheduledTurns);
    if (Option.isNone(turns)) return;
    const journal = yield* makeFileJournal(path.join(config.stateDir, PROCESSED_FILE));
    const loop = yield* makeAutomationEventLoop({
      client: automations.client,
      journal,
      linked: settings.getSettings.pipe(
        Effect.map((s) => readWorkMachineIdentity(s.uno) !== null),
        Effect.orElseSucceed(() => false),
      ),
      assistantName: automations.assistantName,
      runTurn: turns.value.runEvent,
      ...(turns.value.runInChat ? { runChatTurn: turns.value.runInChat } : {}),
    });
    yield* Effect.forkScoped(
      loop.run.pipe(
        Effect.catchCause((cause) => Effect.logError("automations loop stopped", { cause })),
      ),
    );
  }),
);
