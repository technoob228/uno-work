/**
 * One-click chat channels for a cloud computer (onboarding v3, "Message
 * your computer from anywhere"): the logic behind
 *
 * - `POST /api/manager/assistant/telegram/shared` — Uno's shared Telegram bot;
 * - `POST|GET|DELETE /api/manager/assistant/slack/install` — Uno's Slack app.
 *
 * Both talk to the console as the machine itself (`workConsole.ts`), store
 * the relay token the console mints in the ordinary connector row
 * (`unorelay:<token>`, see `channelRelay.ts`), and leave the rest to the
 * connectors, which re-read their rows every few seconds. The owner's own
 * bot / own Slack tokens keep working exactly as before.
 *
 * Results are plain outcomes (`ok` + value, or an HTTP status + error code)
 * so `http.ts` stays a thin adapter and the flows are testable without a
 * server.
 *
 * @module manager/channelSetup
 */
import {
  ManagerSlackConnectorConfig,
  ManagerTelegramConnectorConfig,
  type ManagerChannelSetupErrorCode,
  type ManagerSlackInstallStartResult,
  type ManagerSlackInstallStatus,
  type ManagerTelegramSharedResult,
  type ProjectId,
} from "@t3tools/contracts";
import { Effect, Option, Schema } from "effect";

import type { ManagerRepositoryError } from "../persistence/Errors.ts";
import { ManagerConnectorRepository } from "../persistence/Services/ManagerConnectors.ts";
import {
  callTelegramBotMethod,
  isRelayCredential,
  relayCredential,
  SLACK_RELAY_APP_TOKEN,
} from "./channelRelay.ts";
import { ManagerSlackService } from "./Layers/SlackConnector.ts";
import { ManagerTelegramService } from "./Layers/TelegramConnector.ts";
import { telegramPairingLink } from "./telegramPairing.ts";
import {
  callWorkConsole,
  consoleBoolean,
  consoleString,
  type FetchLike,
  type WorkConsoleResponse,
  type WorkMachineIdentity,
} from "./workConsole.ts";

export interface ChannelSetupFailure {
  readonly status: 400 | 409 | 502 | 503;
  readonly error: ManagerChannelSetupErrorCode;
  readonly message: string;
}

export type ChannelSetupOutcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly failure: ChannelSetupFailure };

const succeed = <A>(value: A): ChannelSetupOutcome<A> => ({ ok: true, value });
const fail = <A>(
  status: ChannelSetupFailure["status"],
  error: ManagerChannelSetupErrorCode,
  message: string,
): ChannelSetupOutcome<A> => ({ ok: false, failure: { status, error, message } });

const NOT_CLOUD_COMPUTER_MESSAGE =
  "Only an Uno cloud computer can use Uno's bot; connect your own bot instead.";

const isSuccess = (response: WorkConsoleResponse): boolean =>
  response.status >= 200 && response.status < 300;

/** A console call that returned no usable answer, as a 502 outcome. */
const consoleFailure = <A>(what: string, response: WorkConsoleResponse | null) =>
  response === null
    ? fail<A>(502, "console_unreachable", `Could not reach Uno to ${what}. Try again in a minute.`)
    : fail<A>(502, "console_error", `Uno could not ${what} (HTTP ${response.status}).`);

/** `callWorkConsole` with unreachability folded into a null response. */
const askConsole = (input: Parameters<typeof callWorkConsole>[0]) =>
  callWorkConsole(input).pipe(
    Effect.catchTag("WorkConsoleUnreachable", (error) =>
      Effect.logWarning("work console unreachable").pipe(
        Effect.annotateLogs({ subpath: input.subpath, error: error.message }),
        Effect.as(null),
      ),
    ),
  );

const decodeTelegramRow = (config: unknown) => {
  const decoded = Schema.decodeUnknownExit(ManagerTelegramConnectorConfig)(config);
  return decoded._tag === "Success" ? decoded.value : null;
};

const decodeSlackRow = (config: unknown) => {
  const decoded = Schema.decodeUnknownExit(ManagerSlackConnectorConfig)(config);
  return decoded._tag === "Success" ? decoded.value : null;
};

// ---------------------------------------------------------------------------
// Telegram: Uno's shared bot
// ---------------------------------------------------------------------------

/**
 * Switch the assistant's Telegram connector to Uno's shared bot and issue a
 * link code: mint (rotate) the relay at the console, store it in the row
 * (allowlist, addressing and harness choice kept), then pair exactly like
 * `/telegram/pair` — the connector registers the code with the console.
 */
export const connectSharedTelegram = (input: {
  readonly projectId: ProjectId;
  readonly identity: WorkMachineIdentity | null;
  readonly fetchImpl?: FetchLike;
}): Effect.Effect<
  ChannelSetupOutcome<ManagerTelegramSharedResult>,
  ManagerRepositoryError,
  ManagerConnectorRepository | ManagerTelegramService
> =>
  Effect.gen(function* () {
    if (input.identity === null) {
      return fail(409, "not_cloud_computer", NOT_CLOUD_COMPUTER_MESSAGE);
    }
    const repository = yield* ManagerConnectorRepository;
    const telegram = yield* ManagerTelegramService;

    const minted = yield* askConsole({
      identity: input.identity,
      method: "POST",
      subpath: "telegram/relay",
      body: {},
      ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
    });
    if (minted !== null && minted.status === 503) {
      return fail(503, "shared_bot_unavailable", "Uno's Telegram bot is not available right now.");
    }
    const relayToken =
      minted !== null && isSuccess(minted) ? consoleString(minted.body, "relay_token") : null;
    if (minted === null || relayToken === null) {
      return consoleFailure("set up its Telegram bot for this computer", minted);
    }
    const botUsername = consoleString(minted.body, "bot_username");

    const existing = yield* repository.get({ projectId: input.projectId, kind: "telegram" });
    const previous = Option.isSome(existing) ? decodeTelegramRow(existing.value.config) : null;
    const config = {
      botToken: relayCredential(relayToken),
      allowedChatIds: previous?.allowedChatIds ?? [],
      enabled: true,
      defaultModelSelection: previous?.defaultModelSelection ?? null,
      ...(previous?.addressing !== undefined ? { addressing: previous.addressing } : {}),
    } satisfies ManagerTelegramConnectorConfig;
    yield* repository.upsert({
      projectId: input.projectId,
      kind: "telegram",
      config,
      updatedAt: new Date().toISOString(),
    });
    yield* Effect.logInfo("telegram connector switched to Uno's shared bot").pipe(
      Effect.annotateLogs({ projectId: input.projectId, boxId: input.identity.boxId }),
    );

    const pairing = yield* telegram.startPairing(input.projectId).pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catchTag("TelegramPairingError", (error) =>
        Effect.succeed({ ok: false as const, message: error.message }),
      ),
    );
    if (!pairing.ok) {
      return fail(502, "console_error", `Uno did not accept the link code: ${pairing.message}`);
    }
    const username = botUsername ?? pairing.value.botUsername;
    return succeed({
      code: pairing.value.code,
      expiresAt: pairing.value.expiresAt,
      botUsername: username,
      link: telegramPairingLink(username, pairing.value.code),
    });
  });

/**
 * Side effects of saving the Telegram connector through the ordinary
 * settings route, relay-aware: chats the owner removed from a shared-bot
 * connector are unlinked at the console (`unoUnlinkChat`), and switching
 * from the shared bot to an own bot deletes the relay. Best effort: the
 * local save already happened and is what counts.
 */
export const afterTelegramConfigSaved = (input: {
  readonly previous: ManagerTelegramConnectorConfig | null;
  readonly next: ManagerTelegramConnectorConfig;
  readonly identity: WorkMachineIdentity | null;
  readonly fetchImpl?: FetchLike;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const previous = input.previous;
    if (previous === null || !isRelayCredential(previous.botToken)) return;
    if (isRelayCredential(input.next.botToken)) {
      const kept = new Set(input.next.allowedChatIds);
      const removed = previous.allowedChatIds.filter((chatId) => !kept.has(chatId));
      for (const chatId of removed) {
        const answer = yield* Effect.promise(() =>
          callTelegramBotMethod(
            input.next.botToken,
            "unoUnlinkChat",
            { chat_id: chatId },
            input.fetchImpl,
          ),
        );
        if (!answer.ok) {
          yield* Effect.logWarning("telegram relay unlink failed").pipe(
            Effect.annotateLogs({ chatId, description: answer.description }),
          );
        }
      }
      return;
    }
    if (input.identity === null) return;
    const deleted = yield* askConsole({
      identity: input.identity,
      method: "DELETE",
      subpath: "telegram/relay",
      ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
    });
    if (deleted === null || (!isSuccess(deleted) && deleted.status !== 404)) {
      yield* Effect.logWarning("telegram relay delete failed").pipe(
        Effect.annotateLogs({ status: deleted?.status ?? null }),
      );
    }
  });

// ---------------------------------------------------------------------------
// Slack: Uno's Slack app ("Add to Slack")
// ---------------------------------------------------------------------------

/** Where to send the person to add Uno's app to their workspace. */
export const startSlackInstall = (input: {
  readonly identity: WorkMachineIdentity | null;
  readonly fetchImpl?: FetchLike;
}): Effect.Effect<ChannelSetupOutcome<ManagerSlackInstallStartResult>> =>
  Effect.gen(function* () {
    if (input.identity === null) {
      return fail(409, "not_cloud_computer", NOT_CLOUD_COMPUTER_MESSAGE);
    }
    const response = yield* askConsole({
      identity: input.identity,
      method: "POST",
      subpath: "slack/install",
      body: {},
      ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
    });
    if (response !== null && response.status === 503) {
      return succeed({ available: false, authorizeUrl: null });
    }
    const authorizeUrl =
      response !== null && isSuccess(response)
        ? consoleString(response.body, "authorize_url")
        : null;
    if (response === null || authorizeUrl === null) {
      return consoleFailure("start adding its Slack app", response);
    }
    return succeed({
      available: consoleBoolean(response.body, "available") ?? true,
      authorizeUrl,
    });
  });

/**
 * The installation as the console sees it. Once Slack reports it installed
 * and the connector is not on the relay yet, mint the relay and store it in
 * the row (settings kept, enabled) — the connector switches to relay mode on
 * its next reconcile.
 */
export const readSlackInstall = (input: {
  readonly projectId: ProjectId;
  readonly identity: WorkMachineIdentity | null;
  readonly fetchImpl?: FetchLike;
}): Effect.Effect<
  ChannelSetupOutcome<ManagerSlackInstallStatus>,
  ManagerRepositoryError,
  ManagerConnectorRepository | ManagerSlackService
> =>
  Effect.gen(function* () {
    if (input.identity === null) {
      return fail(409, "not_cloud_computer", NOT_CLOUD_COMPUTER_MESSAGE);
    }
    const repository = yield* ManagerConnectorRepository;
    const slack = yield* ManagerSlackService;
    const fetchOption = input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {};

    const response = yield* askConsole({
      identity: input.identity,
      method: "GET",
      subpath: "slack",
      ...fetchOption,
    });
    if (response === null || !isSuccess(response)) {
      return consoleFailure("read the Slack installation", response);
    }
    const available = consoleBoolean(response.body, "available") ?? false;
    const installed = consoleBoolean(response.body, "installed") ?? false;
    const teamName = consoleString(response.body, "team_name");
    const botUserName = consoleString(response.body, "bot_user_name");

    const existing = yield* repository.get({ projectId: input.projectId, kind: "slack" });
    const previous = Option.isSome(existing) ? decodeSlackRow(existing.value.config) : null;
    let relayRow = previous !== null && isRelayCredential(previous.botToken) ? previous : null;

    if (installed && relayRow === null) {
      const minted = yield* askConsole({
        identity: input.identity,
        method: "POST",
        subpath: "slack/relay",
        body: {},
        ...fetchOption,
      });
      const relayToken =
        minted !== null && isSuccess(minted) ? consoleString(minted.body, "relay_token") : null;
      if (relayToken === null) {
        return consoleFailure("connect this computer to Slack", minted);
      }
      const config = {
        botToken: relayCredential(relayToken),
        appToken: SLACK_RELAY_APP_TOKEN,
        allowedChannelIds: previous?.allowedChannelIds ?? [],
        enabled: true,
        defaultModelSelection: previous?.defaultModelSelection ?? null,
        ...(previous?.addressing !== undefined ? { addressing: previous.addressing } : {}),
      } satisfies ManagerSlackConnectorConfig;
      yield* repository.upsert({
        projectId: input.projectId,
        kind: "slack",
        config,
        updatedAt: new Date().toISOString(),
      });
      relayRow = config;
      yield* Effect.logInfo("slack connector switched to Uno's Slack app").pipe(
        Effect.annotateLogs({ projectId: input.projectId, boxId: input.identity.boxId }),
      );
    }

    const runtime = yield* slack.getRuntimeStatus(input.projectId);
    return succeed({
      available,
      installed,
      teamName,
      botUserName: botUserName ?? runtime.botUserName,
      connected: installed && relayRow !== null && relayRow.enabled && runtime.connected,
    });
  });

/**
 * Remove Uno's app from the workspace (the console revokes the token) and
 * forget a relay-mode connector row. An own-token row is left alone.
 */
export const uninstallSlack = (input: {
  readonly projectId: ProjectId;
  readonly identity: WorkMachineIdentity | null;
  readonly fetchImpl?: FetchLike;
}): Effect.Effect<
  ChannelSetupOutcome<{ readonly ok: true }>,
  ManagerRepositoryError,
  ManagerConnectorRepository
> =>
  Effect.gen(function* () {
    if (input.identity === null) {
      return fail(409, "not_cloud_computer", NOT_CLOUD_COMPUTER_MESSAGE);
    }
    const repository = yield* ManagerConnectorRepository;
    const response = yield* askConsole({
      identity: input.identity,
      method: "DELETE",
      subpath: "slack",
      ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
    });
    if (response === null || (!isSuccess(response) && response.status !== 404)) {
      return consoleFailure("remove its Slack app", response);
    }
    const existing = yield* repository.get({ projectId: input.projectId, kind: "slack" });
    const previous = Option.isSome(existing) ? decodeSlackRow(existing.value.config) : null;
    if (previous !== null && isRelayCredential(previous.botToken)) {
      yield* repository.remove({ projectId: input.projectId, kind: "slack" });
    }
    return succeed({ ok: true as const });
  });
