/**
 * Relay mode of the chat connectors (onboarding v3, "Message your computer
 * from anywhere").
 *
 * A cloud computer can talk through Uno's own Telegram bot / Slack app
 * instead of one the owner registers: the console holds the real credentials
 * and exposes a per-computer relay, authenticated by a relay token in the
 * path. The connector row stores that token as its bot token with the
 * `unorelay:` prefix:
 *
 * - Telegram: `unorelay:<tgr_…>` — the console mirrors the Bot API at
 *   `/api/v1/work-relay/telegram/bot<tgr>/<method>` (files at
 *   `/api/v1/work-relay/telegram/file/bot<tgr>/<path>`), so the connector
 *   stays a Bot-API client and only its base URL changes.
 * - Slack: `unorelay:<slr_…>` (app token `unorelay`) — Web API calls go to
 *   `/api/v1/work-relay/slack/<slr>/api/<method>`, events are long-polled
 *   from `/events`, private files come through `/file?url=` and uploads go
 *   through `/upload?url=`.
 *
 * Every URL of both providers is built here, so no connector code decides
 * "which host" on its own. Pure apart from reading the control-plane base.
 *
 * @module manager/channelRelay
 */
import { controlPlaneBaseUrl } from "../workspaceRegistry/unoCloudParse.ts";

/** Prefix of a connector credential that is a console relay token. */
export const RELAY_CREDENTIAL_PREFIX = "unorelay:";
/** The Slack app token stored for a relay-mode row (no Socket Mode there). */
export const SLACK_RELAY_APP_TOKEN = "unorelay";

/** The relay token inside `unorelay:<token>`, or null for an ordinary credential. */
export function parseRelayCredential(credential: string): string | null {
  if (!credential.startsWith(RELAY_CREDENTIAL_PREFIX)) return null;
  const token = credential.slice(RELAY_CREDENTIAL_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

export function isRelayCredential(credential: string): boolean {
  return parseRelayCredential(credential) !== null;
}

export function relayCredential(relayToken: string): string {
  return `${RELAY_CREDENTIAL_PREFIX}${relayToken}`;
}

/**
 * Several assistants on one computer, one relay (assistants MVP, 02.10):
 * the console keeps ONE relay per computer, and minting a new one rotates
 * the old token away. The first assistant that connects Uno's bot holds the
 * relay (`unorelay:<token>` in its row); every other assistant of this
 * computer stores `unoroute:<holder projectId>` instead. A route row is not
 * a poll source — the holder polls, and the daemon sends each chat to the
 * assistant it is linked to (a binding `chat → {assistant, projectId}`).
 */
export const ROUTE_CREDENTIAL_PREFIX = "unoroute:";

/** The holder's project id inside `unoroute:<projectId>`, or null. */
export function parseRouteCredential(credential: string): string | null {
  if (!credential.startsWith(ROUTE_CREDENTIAL_PREFIX)) return null;
  const holder = credential.slice(ROUTE_CREDENTIAL_PREFIX.length).trim();
  return holder.length > 0 ? holder : null;
}

export function isRouteCredential(credential: string): boolean {
  return parseRouteCredential(credential) !== null;
}

export function routeCredential(holderProjectId: string): string {
  return `${ROUTE_CREDENTIAL_PREFIX}${holderProjectId}`;
}

const TELEGRAM_API_BASE = "https://api.telegram.org";

/**
 * Dev/test switch: send an OWN bot's Bot-API calls to a local stub instead of
 * Telegram (`UNO_WORK_DEV_TELEGRAM_API_URL=http://127.0.0.1:9999`). The bot
 * token goes to whatever this names, so it is read from the daemon's own
 * environment only — never from settings a client can write.
 */
export const TELEGRAM_API_URL_OVERRIDE_ENV = "UNO_WORK_DEV_TELEGRAM_API_URL";

function telegramApiBase(): string {
  const override = process.env[TELEGRAM_API_URL_OVERRIDE_ENV]?.trim();
  return override && override.length > 0 ? override.replace(/\/+$/, "") : TELEGRAM_API_BASE;
}

function telegramRelayBase(baseUrl: string): string {
  return `${baseUrl}/api/v1/work-relay/telegram`;
}

/** Bot-API method URL for a connector credential (own bot or relay). */
export function telegramApiUrl(
  botToken: string,
  method: string,
  baseUrl: string = controlPlaneBaseUrl(),
): string {
  const relay = parseRelayCredential(botToken);
  return relay === null
    ? `${telegramApiBase()}/bot${botToken}/${method}`
    : `${telegramRelayBase(baseUrl)}/bot${relay}/${method}`;
}

/** Download URL of a file `getFile` resolved (own bot or relay). */
export function telegramFileUrl(
  botToken: string,
  filePath: string,
  baseUrl: string = controlPlaneBaseUrl(),
): string {
  const relay = parseRelayCredential(botToken);
  return relay === null
    ? `${telegramApiBase()}/file/bot${botToken}/${filePath}`
    : `${telegramRelayBase(baseUrl)}/file/bot${relay}/${filePath}`;
}

/**
 * A credential must never reach a log line or an error shown to a client:
 * strip both Bot-API path forms and any `unorelay:` token from `text`.
 */
export function redactConnectorSecrets(text: string): string {
  return text
    .replace(/\/bot[^/\s?]+/g, "/bot<redacted>")
    .replace(/\/work-relay\/slack\/[^/\s?]+/g, "/work-relay/slack/<redacted>")
    .replace(/unorelay:[^\s"']+/g, "unorelay:<redacted>")
    .replace(/\b(tgr|slr)_[0-9a-fA-F]{8,}\b/g, "$1_<redacted>");
}

function slackRelayBase(relayToken: string, baseUrl: string): string {
  return `${baseUrl}/api/v1/work-relay/slack/${encodeURIComponent(relayToken)}`;
}

/** `slackApiUrl` for a relay-mode WebClient (trailing slash, like `https://slack.com/api/`). */
export function slackRelayApiBase(
  relayToken: string,
  baseUrl: string = controlPlaneBaseUrl(),
): string {
  return `${slackRelayBase(relayToken, baseUrl)}/api/`;
}

export function slackRelayEventsUrl(
  relayToken: string,
  after: string,
  waitSeconds: number,
  baseUrl: string = controlPlaneBaseUrl(),
): string {
  const query = new URLSearchParams({ after, wait: String(waitSeconds) });
  return `${slackRelayBase(relayToken, baseUrl)}/events?${query.toString()}`;
}

/** Where to `fetch` a Slack upload target (`files.getUploadURLExternal`'s `upload_url`). */
export function slackUploadTarget(
  botToken: string,
  uploadUrl: string,
  baseUrl: string = controlPlaneBaseUrl(),
): string {
  const relay = parseRelayCredential(botToken);
  return relay === null
    ? uploadUrl
    : `${slackRelayBase(relay, baseUrl)}/upload?${new URLSearchParams({ url: uploadUrl }).toString()}`;
}

/**
 * How to download a Slack private file (`url_private[_download]`): straight
 * from Slack with the bot token, or through the relay (which adds the
 * installation's token itself).
 */
export function slackFileRequest(
  botToken: string,
  fileUrl: string,
  baseUrl: string = controlPlaneBaseUrl(),
): { readonly url: string; readonly headers: Record<string, string> } {
  const relay = parseRelayCredential(botToken);
  return relay === null
    ? { url: fileUrl, headers: { authorization: `Bearer ${botToken}` } }
    : {
        url: `${slackRelayBase(relay, baseUrl)}/file?${new URLSearchParams({ url: fileUrl }).toString()}`,
        headers: {},
      };
}

export interface TelegramBotApiAnswer {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly description?: string;
  readonly error_code?: number;
}

/**
 * One JSON Bot-API call on a connector credential — used for the relay's
 * custom methods (`unoRegisterStartCode`, `unoUnlinkChat`). Network failures
 * resolve as `{ ok: false }` with a redacted description; never throws.
 */
export async function callTelegramBotMethod(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = globalThis.fetch,
): Promise<TelegramBotApiAnswer> {
  try {
    const response = await fetchImpl(telegramApiUrl(botToken, method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const parsed = (await response.json().catch(() => null)) as TelegramBotApiAnswer | null;
    if (parsed === null || typeof parsed !== "object") {
      return { ok: false, error_code: response.status, description: `HTTP ${response.status}` };
    }
    return parsed.ok === true
      ? parsed
      : {
          ...parsed,
          ok: false,
          description: redactConnectorSecrets(parsed.description ?? `HTTP ${response.status}`),
        };
  } catch (cause) {
    return {
      ok: false,
      description: redactConnectorSecrets(cause instanceof Error ? cause.message : String(cause)),
    };
  }
}
