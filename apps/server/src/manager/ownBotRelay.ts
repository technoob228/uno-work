/**
 * The assistant's own Telegram bot through the console relay (11.11).
 *
 * A cloud computer in economy mode sleeps when idle. A bot that long-polls
 * `api.telegram.org` from inside it goes deaf while it sleeps, and nothing
 * wakes it: the person writes to their assistant and gets silence (account
 * 2709, 11.11). Uno's own bots never had this problem — the console holds
 * their webhook, queues updates and wakes the computer. This module gives an
 * own bot the same path:
 *
 * - `register` — `POST …/work/telegram/relay {"bot":"own","token",…}`: the
 *   console checks the token, takes the bot's webhook and answers a `tgo_`
 *   relay token; `setOwnBotRelay` then re-points every Bot-API URL of this
 *   bot at the console's mirror (`channelRelay.ts`). The connector row keeps
 *   the real token.
 * - `release` — `DELETE …?bot=own&bot_id=`: the console drops the webhook
 *   (only if this computer holds the bot — a computer the assistant moved
 *   away from cannot take it from the new one).
 * - `listHeld` — the bots the console routes to this computer (the cleanup
 *   after a restart: a bot no assistant here uses any more is released).
 *
 * When to try again is decided here too (`attemptDue` / `defer`): a console
 * without the feature (flag off, older build) is asked again in 30 minutes,
 * an unreachable one in 5, a relay that vanished (the bot moved to another
 * computer) in 10 — never at once, so two computers with one bot do not
 * take it from each other in a loop.
 *
 * Contract: `reports/day_2026-11-11/own-bot-relay/CONTRACT.md`.
 *
 * @module manager/ownBotRelay
 */
import { Effect } from "effect";

import {
  isRelayCredential,
  isRouteCredential,
  OWN_BOT_RELAY_PREFIX,
  ownBotRelay,
  setOwnBotRelay,
} from "./channelRelay.ts";
import {
  callWorkConsole,
  consoleString,
  type FetchLike,
  type WorkConsoleResponse,
  type WorkMachineIdentity,
} from "./workConsole.ts";

/** The console's code for "own bots don't go through Uno for this account". */
export const OWN_BOT_RELAY_OFF = "OWN_BOT_RELAY_OFF";

/** Retry delays after an attempt that did not end on the relay. */
export const OWN_BOT_RETRY_WHEN_OFF_MS = 30 * 60_000;
export const OWN_BOT_RETRY_WHEN_UNREACHABLE_MS = 5 * 60_000;
export const OWN_BOT_RETRY_AFTER_LOST_MS = 10 * 60_000;
/** A direct poll that failed for another reason (bad token, another poller). */
export const OWN_BOT_RETRY_AFTER_ERROR_MS = 60_000;
/** How often a computer asks the console to drop a webhook that blocks it. */
export const OWN_BOT_RELEASE_EVERY_MS = 10 * 60_000;

/** A Telegram bot token: `<bot id>:<secret>`. */
const BOT_TOKEN_RE = /^(\d{1,20}):[A-Za-z0-9_-]{20,}$/;

/** Whether a connector credential is the person's own bot token (not Uno's relay). */
export function isOwnBotToken(credential: string): boolean {
  return (
    !isRelayCredential(credential) &&
    !isRouteCredential(credential) &&
    BOT_TOKEN_RE.test(credential.trim())
  );
}

/** The bot's Telegram id — the part of its token before the colon. */
export function ownBotIdOf(botToken: string): string | null {
  return BOT_TOKEN_RE.exec(botToken.trim())?.[1] ?? null;
}

const nextAttemptAt = new Map<string, number>();
const lastReleaseAt = new Map<string, number>();
const answeredOff = new Set<string>();

/** Whether the latest registration of this bot was refused as "not for this account". */
export function lastAnsweredOff(botToken: string): boolean {
  return answeredOff.has(botToken);
}

/** Whether this bot may try (again) to switch to the console now. */
export function attemptDue(botToken: string, nowMs: number): boolean {
  return (nextAttemptAt.get(botToken) ?? 0) <= nowMs;
}

/** Hold the next switch attempt of this bot for `ms`. */
export function defer(botToken: string, nowMs: number, ms: number): void {
  nextAttemptAt.set(botToken, nowMs + ms);
}

/**
 * The console no longer knows this relay (401 on the mirror): the bot moved
 * to another computer, was released, or the relay was dropped on purpose.
 * Back to `api.telegram.org`; the next switch attempt waits.
 */
export function dropRelay(botToken: string, nowMs: number): void {
  setOwnBotRelay(botToken, null);
  defer(botToken, nowMs, OWN_BOT_RETRY_AFTER_LOST_MS);
}

/** Tests only: forget every attempt (the relay map is reset by its own setter). */
export function resetOwnBotRelayState(): void {
  nextAttemptAt.clear();
  lastReleaseAt.clear();
  answeredOff.clear();
}

export type RegisterOutcome =
  | { readonly kind: "registered"; readonly botUsername: string | null }
  /** The console does not route own bots for this account (flag off, older build). */
  | { readonly kind: "off"; readonly status: number }
  /** No usable answer: unreachable, 5xx, a token the console refused. */
  | { readonly kind: "failed"; readonly status: number | null; readonly reason: string };

const askConsole = (input: Parameters<typeof callWorkConsole>[0]) =>
  callWorkConsole(input).pipe(
    Effect.map((response): WorkConsoleResponse | null => response),
    Effect.catchTag("WorkConsoleUnreachable", (error) =>
      Effect.logWarning("work console unreachable").pipe(
        Effect.annotateLogs({ subpath: input.subpath, error: error.message }),
        Effect.as(null),
      ),
    ),
  );

const consoleCode = (body: unknown): string | null =>
  consoleString(body, "code") ?? consoleString(body, "error");

/**
 * Hand the bot to the console and switch its transport. Sets the retry delay
 * itself when the answer is not a relay token.
 */
export const register = (input: {
  readonly identity: WorkMachineIdentity;
  readonly botToken: string;
  readonly allowedUpdates: ReadonlyArray<string>;
  readonly nowMs: number;
  readonly fetchImpl?: FetchLike;
}): Effect.Effect<RegisterOutcome> =>
  Effect.gen(function* () {
    const response = yield* askConsole({
      identity: input.identity,
      method: "POST",
      subpath: "telegram/relay",
      body: { bot: "own", token: input.botToken, allowed_updates: input.allowedUpdates },
      ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
    });
    if (response === null) {
      defer(input.botToken, input.nowMs, OWN_BOT_RETRY_WHEN_UNREACHABLE_MS);
      return { kind: "failed", status: null, reason: "console unreachable" } as const;
    }
    const relayToken = consoleString(response.body, "relay_token");
    if (
      response.status >= 200 &&
      response.status < 300 &&
      relayToken !== null &&
      relayToken.startsWith(OWN_BOT_RELAY_PREFIX)
    ) {
      setOwnBotRelay(input.botToken, relayToken);
      nextAttemptAt.delete(input.botToken);
      answeredOff.delete(input.botToken);
      return {
        kind: "registered",
        botUsername: consoleString(response.body, "bot_username"),
      } as const;
    }
    // Flag off (503 OWN_BOT_RELAY_OFF), or a console that does not know
    // {"bot":"own"} yet (400 unknown bot / 404): direct polling, ask later.
    const code = consoleCode(response.body);
    if (
      code === OWN_BOT_RELAY_OFF ||
      response.status === 404 ||
      (response.status === 400 && code !== "BAD_BOT_TOKEN")
    ) {
      defer(input.botToken, input.nowMs, OWN_BOT_RETRY_WHEN_OFF_MS);
      answeredOff.add(input.botToken);
      return { kind: "off", status: response.status } as const;
    }
    defer(input.botToken, input.nowMs, OWN_BOT_RETRY_WHEN_UNREACHABLE_MS);
    return {
      kind: "failed",
      status: response.status,
      reason: code ?? `HTTP ${response.status}`,
    } as const;
  });

/**
 * Ask the console to let the bot go (drop its webhook) and talk to
 * `api.telegram.org` again. A no-op at the console when another computer
 * holds the bot. Never fails; returns whether the console answered 2xx.
 */
export const release = (input: {
  readonly identity: WorkMachineIdentity;
  readonly botToken: string;
  readonly fetchImpl?: FetchLike;
}): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    setOwnBotRelay(input.botToken, null);
    const botId = ownBotIdOf(input.botToken);
    if (botId === null) return false;
    return yield* releaseById({
      identity: input.identity,
      botId,
      ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
    });
  });

const releaseById = (input: {
  readonly identity: WorkMachineIdentity;
  readonly botId: string;
  readonly fetchImpl?: FetchLike;
}): Effect.Effect<boolean> =>
  askConsole({
    identity: input.identity,
    method: "DELETE",
    subpath: `telegram/relay?bot=own&bot_id=${encodeURIComponent(input.botId)}`,
    ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
  }).pipe(Effect.map((response) => response !== null && response.status < 300));

/**
 * A direct `getUpdates` answered 409 because a webhook holds the bot — ours
 * from before a restart, or one this computer cannot re-register (flag off).
 * Ask the console to drop it, at most every 10 minutes per bot.
 */
export const releaseBlockingWebhook = (input: {
  readonly identity: WorkMachineIdentity;
  readonly botToken: string;
  readonly nowMs: number;
  readonly fetchImpl?: FetchLike;
}): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (ownBotRelay(input.botToken) !== null) return false;
    if (input.nowMs - (lastReleaseAt.get(input.botToken) ?? 0) < OWN_BOT_RELEASE_EVERY_MS) {
      return false;
    }
    lastReleaseAt.set(input.botToken, input.nowMs);
    return yield* release(input);
  });

/** Telegram's 409 for a getUpdates while a webhook is set. */
export function isWebhookConflict(errorCode: number | undefined, description: string | undefined) {
  return errorCode === 409 && /webhook/i.test(description ?? "");
}

/**
 * Release every bot the console routes to this computer that no enabled
 * assistant here uses (`keepBotIds`). Run once per daemon start: the
 * process-local map is empty after a restart, so a bot an assistant stopped
 * using while Work was down would keep its webhook — and keep waking this
 * computer for messages nobody reads.
 */
export const releaseUnused = (input: {
  readonly identity: WorkMachineIdentity;
  readonly keepBotIds: ReadonlySet<string>;
  readonly fetchImpl?: FetchLike;
}): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const fetchOption = input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {};
    const response = yield* askConsole({
      identity: input.identity,
      method: "GET",
      subpath: "telegram/relay?bot=own",
      ...fetchOption,
    });
    if (response === null || response.status >= 300) return [];
    const bots = (response.body as { readonly bots?: unknown } | null)?.bots;
    if (!Array.isArray(bots)) return [];
    const released: string[] = [];
    for (const bot of bots) {
      const raw = (bot as { readonly bot_id?: unknown } | null)?.bot_id;
      const botId = typeof raw === "number" || typeof raw === "string" ? String(raw) : null;
      if (botId === null || input.keepBotIds.has(botId)) continue;
      if (yield* releaseById({ identity: input.identity, botId, ...fetchOption })) {
        released.push(botId);
      }
    }
    return released;
  });
