/**
 * Several computers — of one Uno account or of several — in one Slack
 * workspace through Uno's app (console migration 257, decisions 21.10).
 *
 * The console routes each event to ONE computer: a channel to the computer
 * that took it; direct messages and @mentions outside taken channels to the
 * author's account's default computer (the one the person picked, else the
 * cloud computer, else a desktop). This computer manages its share through
 * its relay token (`/work-relay/slack/<slr>/routing`):
 *
 * - the channels its assistants answer in are claimed at the console, so the
 *   channel's events come here and nowhere else;
 * - a channel another computer of the account took (`elsewhere`) or a
 *   computer of another account answers in (`taken`) is not answered here —
 *   it leaves the local allowlists, and picking it here again moves it (own
 *   account) or is refused (another account);
 * - "Answer direct messages here" makes this computer the account's default.
 *
 * Network helpers never throw (null on any failure); the rest is pure.
 *
 * @module manager/slackRouting
 */
import { ASSISTANT_PROJECT_ID, ManagerSlackConnectorConfig } from "@t3tools/contracts";
import { Effect, Option, Schema } from "effect";

import type { ManagerRepositoryError } from "../persistence/Errors.ts";
import { ManagerConnectorRepository } from "../persistence/Services/ManagerConnectors.ts";
import {
  isRelayCredential,
  parseRelayCredential,
  routeCredential,
  slackRelayRoutingUrl,
} from "./channelRelay.ts";
import { isSlackDmChannel } from "./slackAssistants.ts";
import type { FetchLike } from "./workConsole.ts";

export interface SlackRoutingComputer {
  readonly name: string;
  readonly kind: "cloud" | "desktop";
  readonly isThis: boolean;
  readonly isDefault: boolean;
}

/** The console's answer, seen by this computer. */
export interface SlackRouting {
  /** Channels routed to this computer. */
  readonly channelIds: ReadonlyArray<string>;
  /** Channels other computers of this account answer in. */
  readonly elsewhere: ReadonlyArray<string>;
  /** Channels computers of other Uno accounts answer in. */
  readonly taken: ReadonlyArray<string>;
  /** Of the last PUT: channels that were not routed here. */
  readonly refused: ReadonlyArray<string>;
  /** This computer gets the account's DMs and @mentions outside taken channels. */
  readonly isDefault: boolean;
  /** The person picked the default (not the cloud-first rule). */
  readonly defaultChosen: boolean;
  readonly defaultComputer: SlackRoutingComputer | null;
  /** This account's live computers in the workspace. */
  readonly computers: ReadonlyArray<SlackRoutingComputer>;
  /** Other Uno accounts answer in this workspace too. */
  readonly shared: boolean;
  /** "Misha's assistant" — what replies are signed with in a shared workspace. */
  readonly signedAs: string | null;
}

const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const computerOf = (value: unknown): SlackRoutingComputer | null => {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== "string") return null;
  return {
    name: raw.name,
    kind: raw.kind === "desktop" ? "desktop" : "cloud",
    isThis: raw.this === true,
    isDefault: raw.default === true,
  };
};

/** The console's `SlackRouting` JSON, or null when it isn't one. */
export function parseSlackRouting(body: unknown): SlackRouting | null {
  if (body === null || typeof body !== "object") return null;
  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.channel_ids)) return null;
  return {
    channelIds: strings(raw.channel_ids),
    elsewhere: strings(raw.elsewhere),
    taken: strings(raw.taken),
    refused: strings(raw.refused),
    isDefault: raw.default === true,
    defaultChosen: raw.default_chosen === true,
    defaultComputer: computerOf(raw.default_computer),
    computers: Array.isArray(raw.computers)
      ? raw.computers.flatMap((item) => {
          const computer = computerOf(item);
          return computer === null ? [] : [computer];
        })
      : [],
    shared: raw.shared === true,
    signedAs: typeof raw.signed_as === "string" && raw.signed_as !== "" ? raw.signed_as : null,
  };
}

async function routingCall(
  relayToken: string,
  init: RequestInit,
  fetchImpl: FetchLike,
): Promise<SlackRouting | null> {
  try {
    const response = await fetchImpl(slackRelayRoutingUrl(relayToken), {
      ...init,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    return parseSlackRouting(await response.json().catch(() => null));
  } catch {
    return null;
  }
}

/** `GET …/routing`; null on any failure (an older console, no network). */
export function readSlackRouting(
  relayToken: string,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<SlackRouting | null> {
  return routingCall(relayToken, { method: "GET" }, fetchImpl);
}

/** `PUT …/routing`; null on any failure. */
export function putSlackRouting(
  relayToken: string,
  body: { readonly channelIds?: ReadonlyArray<string>; readonly isDefault?: boolean },
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<SlackRouting | null> {
  return routingCall(
    relayToken,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(body.channelIds !== undefined ? { channel_ids: body.channelIds } : {}),
        ...(body.isDefault !== undefined ? { default: body.isDefault } : {}),
      }),
    },
    fetchImpl,
  );
}

/**
 * A channel the console routes (`C…` / `G…`); DMs (`D…`) go by author and
 * anything else in an allowlist is left alone.
 */
export const isRoutableSlackChannel = (id: string): boolean => /^[CG][A-Z0-9]{2,40}$/.test(id);

/**
 * The channels this computer claims: every channel its relay assistants
 * answer in, minus those another computer answers in — unless the person
 * just picked them here (`picked`: a move).
 */
export function channelsToClaim(input: {
  readonly local: ReadonlyArray<ReadonlyArray<string>>;
  readonly routing: SlackRouting | null;
  readonly picked?: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  const picked = new Set(input.picked ?? []);
  const away = new Set([...(input.routing?.elsewhere ?? []), ...(input.routing?.taken ?? [])]);
  const out = new Set<string>();
  for (const list of input.local) {
    for (const id of list) {
      if (!isRoutableSlackChannel(id)) continue;
      if (away.has(id) && !picked.has(id)) continue;
      out.add(id);
    }
  }
  return [...out].toSorted();
}

/**
 * A relay assistant's allowlist after the console answered: its DMs (and
 * anything that isn't a channel) stay, its channels only those the console
 * routes here.
 */
export function keepRoutedChannels(
  allowed: ReadonlyArray<string>,
  routing: SlackRouting,
): ReadonlyArray<string> {
  const here = new Set(routing.channelIds);
  return allowed.filter(
    (id) => isSlackDmChannel(id) || !isRoutableSlackChannel(id) || here.has(id),
  );
}

const sameSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && new Set([...a, ...b]).size === a.length;

const decodeSlackConfig = (config: unknown): ManagerSlackConnectorConfig | null => {
  const decoded = Schema.decodeUnknownExit(ManagerSlackConnectorConfig)(config);
  return decoded._tag === "Success" ? decoded.value : null;
};

/** This computer's relay token and the assistants that answer through it. */
const relayRows = Effect.gen(function* () {
  const repository = yield* ManagerConnectorRepository;
  const rows = (yield* repository.listByKind("slack")).flatMap((row) => {
    const config = decodeSlackConfig(row.config);
    return config === null ? [] : [{ projectId: row.projectId, config }];
  });
  // One relay per computer (`pickRelayHolder`): the assistant's own row first.
  const holders = rows.filter((row) => isRelayCredential(row.config.botToken));
  const holder =
    holders.find((row) => row.projectId === ASSISTANT_PROJECT_ID) ?? holders[0] ?? undefined;
  const relayToken = holder === undefined ? null : parseRelayCredential(holder.config.botToken);
  if (holder === undefined || relayToken === null) return null;
  const route = routeCredential(holder.projectId);
  return {
    relayToken,
    rows: rows.filter((row) => row.projectId === holder.projectId || row.config.botToken === route),
  };
});

/**
 * Bring this computer's share of the workspace in line with its assistants:
 * claim their channels at the console (`picked` — just chosen here, so taken
 * from another computer of the account) and drop from the allowlists what
 * answers elsewhere. Returns the console's routing, or null when there is no
 * relay here or the console didn't answer (then nothing changes).
 */
export const syncSlackRouting = (input?: {
  readonly picked?: ReadonlyArray<string>;
  readonly fetchImpl?: FetchLike;
}): Effect.Effect<SlackRouting | null, ManagerRepositoryError, ManagerConnectorRepository> =>
  Effect.gen(function* () {
    const relay = yield* relayRows;
    if (relay === null) return null;
    const fetchImpl = input?.fetchImpl ?? globalThis.fetch;
    const current = yield* Effect.promise(() => readSlackRouting(relay.relayToken, fetchImpl));
    if (current === null) return null;
    const claim = channelsToClaim({
      local: relay.rows.map((row) => row.config.allowedChannelIds),
      routing: current,
      ...(input?.picked !== undefined ? { picked: input.picked } : {}),
    });
    const routing = sameSet(claim, current.channelIds)
      ? current
      : ((yield* Effect.promise(() =>
          putSlackRouting(relay.relayToken, { channelIds: claim }, fetchImpl),
        )) ?? null);
    if (routing === null) return current;
    const repository = yield* ManagerConnectorRepository;
    const now = new Date().toISOString();
    for (const row of relay.rows) {
      // Re-read: a settings save in between is not overwritten.
      const latest = yield* repository.get({ projectId: row.projectId, kind: "slack" });
      const config =
        (Option.isSome(latest) ? decodeSlackConfig(latest.value.config) : null) ?? row.config;
      const kept = keepRoutedChannels(config.allowedChannelIds, routing);
      if (kept.length === config.allowedChannelIds.length) continue;
      yield* repository.upsert({
        projectId: row.projectId,
        kind: "slack",
        config: { ...config, allowedChannelIds: kept },
        updatedAt: now,
      });
      yield* Effect.logInfo("slack channels answered on another computer left this one").pipe(
        Effect.annotateLogs({
          projectId: row.projectId,
          dropped: config.allowedChannelIds.length - kept.length,
        }),
      );
    }
    return routing;
  });

/** "Answer direct messages here" (true) or back to the cloud-first rule (false). */
export const setSlackDefaultHere = (input: {
  readonly isDefault: boolean;
  readonly fetchImpl?: FetchLike;
}): Effect.Effect<SlackRouting | null, ManagerRepositoryError, ManagerConnectorRepository> =>
  Effect.gen(function* () {
    const relay = yield* relayRows;
    if (relay === null) return null;
    return yield* Effect.promise(() =>
      putSlackRouting(
        relay.relayToken,
        { isDefault: input.isDefault },
        input.fetchImpl ?? globalThis.fetch,
      ),
    );
  });

/** The console's routing as it is now (read only). */
export const currentSlackRouting = (
  fetchImpl: FetchLike = globalThis.fetch,
): Effect.Effect<SlackRouting | null, ManagerRepositoryError, ManagerConnectorRepository> =>
  Effect.gen(function* () {
    const relay = yield* relayRows;
    if (relay === null) return null;
    return yield* Effect.promise(() => readSlackRouting(relay.relayToken, fetchImpl));
  });

/** Where a channel answers, for the channel picker: another computer, another account, or here/nobody. */
export function channelRoutedAway(
  channelId: string,
  routing: SlackRouting | null,
): "computer" | "account" | null {
  if (routing === null) return null;
  if (routing.taken.includes(channelId)) return "account";
  if (routing.elsewhere.includes(channelId)) return "computer";
  return null;
}
