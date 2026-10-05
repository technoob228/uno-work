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
import { assignSlackChannels } from "./slackAssistants.ts";
import {
  callTelegramBotMethod,
  isRelayCredential,
  isRouteCredential,
  parseRelayCredential,
  relayCredential,
  routeCredential,
  SLACK_RELAY_APP_TOKEN,
  slackRelayApiBase,
} from "./channelRelay.ts";
import { ManagerSlackService } from "./Layers/SlackConnector.ts";
import { ManagerTelegramService } from "./Layers/TelegramConnector.ts";
import { telegramPairingLink } from "./telegramPairing.ts";
import { pickRelayHolder } from "./connectorBindings.ts";
import { withOwnerUserId } from "./connectorSenders.ts";
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

    // One relay per computer: when another assistant of this computer holds
    // Uno's bot already, this one routes through it instead of minting a new
    // relay (which would rotate the holder's token away and silence it).
    const rows = yield* repository.listByKind("telegram");
    const holder = pickRelayHolder(
      rows.flatMap((row) => {
        const config = decodeTelegramRow(row.config);
        return config === null
          ? []
          : [{ projectId: row.projectId, isRelay: isRelayCredential(config.botToken) }];
      }),
      input.projectId,
    );
    if (holder !== null) {
      return yield* routeThroughHolder({ projectId: input.projectId, holder });
    }

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
      ...(previous?.ownerUserIds !== undefined ? { ownerUserIds: previous.ownerUserIds } : {}),
      ...(previous?.groupMembers !== undefined ? { groupMembers: previous.groupMembers } : {}),
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
 * `connectSharedTelegram` for the second (third…) assistant of a computer:
 * its row becomes `unoroute:<holder>` (allowlist, addressing and harness
 * choice kept, switched on), and the link code is registered through the
 * holder's relay — the holder's poller sees `/start <code>` and links the
 * chat to this assistant.
 */
const routeThroughHolder = (input: {
  readonly projectId: ProjectId;
  readonly holder: ProjectId;
}): Effect.Effect<
  ChannelSetupOutcome<ManagerTelegramSharedResult>,
  ManagerRepositoryError,
  ManagerConnectorRepository | ManagerTelegramService
> =>
  Effect.gen(function* () {
    const repository = yield* ManagerConnectorRepository;
    const telegram = yield* ManagerTelegramService;
    const existing = yield* repository.get({ projectId: input.projectId, kind: "telegram" });
    const previous = Option.isSome(existing) ? decodeTelegramRow(existing.value.config) : null;
    // An own bot this assistant had stops here; its chats were that bot's.
    const keepChats = previous !== null && isRouteCredential(previous.botToken);
    const config = {
      botToken: routeCredential(input.holder),
      allowedChatIds: keepChats ? previous.allowedChatIds : [],
      enabled: true,
      defaultModelSelection: previous?.defaultModelSelection ?? null,
      ...(previous?.addressing !== undefined ? { addressing: previous.addressing } : {}),
      ...(keepChats && previous.ownerUserIds !== undefined
        ? { ownerUserIds: previous.ownerUserIds }
        : {}),
    } satisfies ManagerTelegramConnectorConfig;
    yield* repository.upsert({
      projectId: input.projectId,
      kind: "telegram",
      config,
      updatedAt: new Date().toISOString(),
    });
    yield* Effect.logInfo("telegram connector routed through this computer's shared bot").pipe(
      Effect.annotateLogs({ projectId: input.projectId, holder: input.holder }),
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
    return succeed({
      code: pairing.value.code,
      expiresAt: pairing.value.expiresAt,
      botUsername: pairing.value.botUsername,
      link: telegramPairingLink(pairing.value.botUsername, pairing.value.code),
    });
  });

/**
 * A bot of the assistant's own (the default since 02.10: every assistant its
 * own bot, made by the person in @BotFather): ask Telegram `getMe` before the
 * token is stored. A network failure is not the token's fault — saved, the
 * poller reports it. The token never leaves the daemon.
 */
export const verifyTelegramBotToken = (
  botToken: string,
  fetchImpl?: FetchLike,
): Effect.Effect<
  | { readonly ok: true; readonly username: string | null }
  | { readonly ok: false; readonly rejected: boolean; readonly message: string }
> =>
  Effect.promise(() =>
    callTelegramBotMethod(botToken, "getMe", {}, fetchImpl).then((answer) => {
      if (answer.ok) {
        const result = (answer as { result?: { username?: unknown } }).result;
        return {
          ok: true as const,
          username: typeof result?.username === "string" ? result.username : null,
        };
      }
      const rejected = answer.error_code === 401 || answer.error_code === 404;
      return {
        ok: false as const,
        rejected,
        message: rejected
          ? "Telegram didn't accept this token. Copy it again from @BotFather."
          : "Couldn't reach Telegram to check the token.",
      };
    }),
  );

const BOT_TOKEN_SHAPE = /^\d+:[\w-]{20,}$/;

/**
 * The assistant's own bot from the chat (assistant_connect → the "Create your
 * assistant's bot" card, decision 05.10): check the token with Telegram,
 * store it as the assistant's Telegram bot and leave the linking (Start) to
 * the Connect Telegram window. A new bot starts with no linked chats: the
 * person has not pressed Start on it yet, so it could not write to them.
 * Switching away from Uno's shared bot drops this computer's relay.
 */
export const saveAssistantOwnBot = (input: {
  readonly projectId: ProjectId;
  readonly botToken: string;
  readonly identity: WorkMachineIdentity | null;
  readonly fetchImpl?: FetchLike;
}): Effect.Effect<
  | { readonly ok: true; readonly botUsername: string | null }
  | { readonly ok: false; readonly message: string },
  ManagerRepositoryError,
  ManagerConnectorRepository
> =>
  Effect.gen(function* () {
    const botToken = input.botToken.trim();
    if (!BOT_TOKEN_SHAPE.test(botToken)) {
      return {
        ok: false as const,
        message: "A bot token looks like 123456789:AAE… — copy the whole line BotFather sent.",
      };
    }
    const verified = yield* verifyTelegramBotToken(botToken, input.fetchImpl);
    if (!verified.ok && verified.rejected) {
      return { ok: false as const, message: verified.message };
    }
    const repository = yield* ManagerConnectorRepository;
    const existing = yield* repository.get({ projectId: input.projectId, kind: "telegram" });
    const previous = Option.isSome(existing) ? decodeTelegramRow(existing.value.config) : null;
    const sameBot = previous !== null && previous.botToken === botToken;
    const config = {
      botToken,
      allowedChatIds: sameBot ? previous.allowedChatIds : [],
      enabled: true,
      defaultModelSelection: previous?.defaultModelSelection ?? null,
      ...(previous?.addressing !== undefined ? { addressing: previous.addressing } : {}),
      ...(sameBot && previous.ownerUserIds !== undefined
        ? { ownerUserIds: previous.ownerUserIds }
        : {}),
      ...(sameBot && previous.groupMembers !== undefined
        ? { groupMembers: previous.groupMembers }
        : {}),
    } satisfies ManagerTelegramConnectorConfig;
    yield* repository.upsert({
      projectId: input.projectId,
      kind: "telegram",
      config,
      updatedAt: new Date().toISOString(),
    });
    yield* afterTelegramConfigSaved({
      previous,
      next: config,
      identity: input.identity,
      ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
    });
    yield* Effect.logInfo("assistant's own Telegram bot saved from the chat").pipe(
      Effect.annotateLogs({ projectId: input.projectId, sameBot }),
    );
    return { ok: true as const, botUsername: verified.ok ? verified.username : null };
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

/**
 * `conversations.open {users}` through the relay Web API: the DM channel id
 * with that user, or null on any failure.
 */
async function openSlackDm(
  botToken: string,
  userId: string,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<string | null> {
  const relay = parseRelayCredential(botToken);
  if (relay === null) return null;
  try {
    const response = await fetchImpl(`${slackRelayApiBase(relay)}conversations.open`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ users: userId }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await response.json().catch(() => null)) as {
      readonly ok?: boolean;
      readonly channel?: { readonly id?: unknown };
    } | null;
    const channelId = body?.ok === true ? body.channel?.id : undefined;
    return typeof channelId === "string" && channelId.length > 0 ? channelId : null;
  } catch {
    return null;
  }
}

/**
 * One Uno Slack app per workspace (decision 02.10): the assistant that added
 * it holds this computer's relay; reading the installation for another
 * assistant would mint a new relay and silence the holder. So every other
 * assistant of this computer gets a routed row instead (`unoroute:<holder>`,
 * channels of its own, its name and emoji on its messages — see
 * `slackAssistants.ts`). Returns the holder, or null when there is none (or
 * the asking assistant holds it itself).
 */
export const slackRelayHolderFor = (
  projectId: ProjectId,
): Effect.Effect<ProjectId | null, never, ManagerConnectorRepository> =>
  Effect.gen(function* () {
    const repository = yield* ManagerConnectorRepository;
    const rows = yield* repository
      .listByKind("slack")
      .pipe(
        Effect.orElseSucceed((): ReadonlyArray<{ projectId: ProjectId; config: unknown }> => []),
      );
    return pickRelayHolder(
      rows.flatMap((row) => {
        const config = decodeSlackRow(row.config);
        return config === null
          ? []
          : [{ projectId: row.projectId, isRelay: isRelayCredential(config.botToken) }];
      }),
      projectId,
    );
  });

/** The routed row of an assistant that writes through `holder`'s Uno app (kept if there). */
export const routeSlackThroughHolder = (input: {
  readonly projectId: ProjectId;
  readonly holder: ProjectId;
}): Effect.Effect<void, ManagerRepositoryError, ManagerConnectorRepository> =>
  Effect.gen(function* () {
    const repository = yield* ManagerConnectorRepository;
    const existing = yield* repository.get({ projectId: input.projectId, kind: "slack" });
    const previous = Option.isSome(existing) ? decodeSlackRow(existing.value.config) : null;
    const route = routeCredential(input.holder);
    if (previous !== null && previous.botToken === route) return;
    const keep = previous !== null && isRouteCredential(previous.botToken);
    yield* repository.upsert({
      projectId: input.projectId,
      kind: "slack",
      config: {
        botToken: route,
        appToken: SLACK_RELAY_APP_TOKEN,
        allowedChannelIds: keep ? previous.allowedChannelIds : [],
        enabled: true,
        defaultModelSelection: previous?.defaultModelSelection ?? null,
        ...(previous?.addressing !== undefined ? { addressing: previous.addressing } : {}),
      } satisfies ManagerSlackConnectorConfig,
      updatedAt: new Date().toISOString(),
    });
    yield* Effect.logInfo("slack connector routed through this computer's Uno app").pipe(
      Effect.annotateLogs({ projectId: input.projectId, holder: input.holder }),
    );
  });

/** Whether this assistant's Slack is a routed row (it never owns the app). */
export const isRoutedSlack = (
  projectId: ProjectId,
): Effect.Effect<boolean, never, ManagerConnectorRepository> =>
  Effect.gen(function* () {
    const repository = yield* ManagerConnectorRepository;
    const row = yield* repository
      .get({ projectId, kind: "slack" })
      .pipe(Effect.orElseSucceed(() => Option.none()));
    const config = Option.isSome(row) ? decodeSlackRow(row.value.config) : null;
    return config !== null && isRouteCredential(config.botToken);
  });

/**
 * "Channels Ana answers in": Ana's row gets exactly these channels, every
 * other assistant of this computer loses them (a channel has one assistant).
 */
export const assignSlackChannelsFor = (input: {
  readonly projectId: ProjectId;
  readonly channelIds: ReadonlyArray<string>;
}): Effect.Effect<ReadonlyArray<string>, ManagerRepositoryError, ManagerConnectorRepository> =>
  Effect.gen(function* () {
    const repository = yield* ManagerConnectorRepository;
    const rows = (yield* repository.listByKind("slack")).flatMap((row) => {
      const config = decodeSlackRow(row.config);
      return config === null ? [] : [{ projectId: row.projectId, config }];
    });
    const next = assignSlackChannels(
      rows.map((row) => ({
        projectId: row.projectId,
        allowedChannelIds: row.config.allowedChannelIds,
      })),
      input.projectId,
      input.channelIds,
    );
    const now = new Date().toISOString();
    for (const row of rows) {
      const allowed = next.get(row.projectId);
      if (allowed === undefined) continue;
      yield* repository.upsert({
        projectId: row.projectId,
        kind: "slack",
        config: { ...row.config, allowedChannelIds: allowed },
        updatedAt: now,
      });
    }
    return next.get(input.projectId) ?? [];
  });

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
        ...(previous?.ownerUserIds !== undefined ? { ownerUserIds: previous.ownerUserIds } : {}),
        ...(previous?.groupMembers !== undefined ? { groupMembers: previous.groupMembers } : {}),
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

    // The person who added the app can DM it right away: open that DM
    // through the relay and allowlist it (channels stay opt-in).
    const installerUserId = consoleString(response.body, "installer_user_id");
    let installerDmReady = false;
    if (installed && relayRow !== null && installerUserId !== null) {
      const relayBotToken = relayRow.botToken;
      const dmChannelId = yield* Effect.promise(() =>
        openSlackDm(relayBotToken, installerUserId, input.fetchImpl),
      );
      if (dmChannelId === null) {
        yield* Effect.logWarning("slack installer DM could not be opened").pipe(
          Effect.annotateLogs({ projectId: input.projectId }),
        );
      } else {
        const installerIsOwner = (relayRow.ownerUserIds ?? []).includes(installerUserId);
        if (!relayRow.allowedChannelIds.includes(dmChannelId) || !installerIsOwner) {
          // Re-read so a concurrent settings save is not overwritten.
          const latest = yield* repository.get({ projectId: input.projectId, kind: "slack" });
          const base =
            (Option.isSome(latest) ? decodeSlackRow(latest.value.config) : null) ?? relayRow;
          const config = {
            ...base,
            allowedChannelIds: base.allowedChannelIds.includes(dmChannelId)
              ? base.allowedChannelIds
              : [...base.allowedChannelIds, dmChannelId],
            // The person who added the app is the owner channels obey.
            ownerUserIds: withOwnerUserId(base.ownerUserIds, installerUserId),
          } satisfies ManagerSlackConnectorConfig;
          yield* repository.upsert({
            projectId: input.projectId,
            kind: "slack",
            config,
            updatedAt: new Date().toISOString(),
          });
          relayRow = config;
          yield* Effect.logInfo("slack installer DM allowlisted").pipe(
            Effect.annotateLogs({ projectId: input.projectId, channelId: dmChannelId }),
          );
        }
        installerDmReady = true;
      }
    }

    const runtime = yield* slack.getRuntimeStatus(input.projectId);
    return succeed({
      available,
      installed,
      teamName,
      botUserName: botUserName ?? runtime.botUserName,
      connected: installed && relayRow !== null && relayRow.enabled && runtime.connected,
      installerDmReady,
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
