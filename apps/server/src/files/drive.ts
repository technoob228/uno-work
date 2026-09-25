/**
 * Uno Drive — the account's cloud storage as an app (bucket "drive").
 *
 * Everything lives in the console (`/api/v1/drive*`): search over the whole
 * bucket, revocable share links, the Telegram bot that saves files sent to
 * it. The daemon only relays, with this computer's own token — so the bot
 * and the links keep working while the computer sleeps.
 *
 * Browsing, upload, download and Office use the plain bucket routes
 * (cloudStorage.ts) with the drive bucket's id.
 *
 * @module files/drive
 */
import type {
  FilesDriveBot,
  FilesDriveFile,
  FilesDriveFileList,
  FilesDriveShare,
  FilesDriveState,
  FilesDriveTelegramChat,
  FilesDriveTelegramLink,
} from "@t3tools/contracts";

import {
  controlPlaneErrorStatus,
  fetchControlPlaneJson,
} from "../workspaceRegistry/unoCloudParse.ts";
import { CloudError, type CloudDeps } from "./cloudStorage.ts";

type Json = Record<string, unknown>;

function rec(value: unknown): Json {
  return value && typeof value === "object" ? (value as Json) : {};
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function dateOrNull(value: unknown): string | null {
  const text = str(value);
  return text && !text.startsWith("0001-") ? text : null;
}

/** The console's `{"error": CODE, "detail": "…"}` out of a ControlPlaneHttpError message. */
function consoleError(cause: unknown): { code: string; detail: string } {
  const message = cause instanceof Error ? cause.message : "";
  const json = message.slice(message.indexOf("{"));
  try {
    const parsed = rec(JSON.parse(json));
    return { code: str(parsed["error"]), detail: str(parsed["detail"]) };
  } catch {
    return { code: "", detail: "" };
  }
}

export function describeDriveError(cause: unknown): string {
  const status = controlPlaneErrorStatus(cause);
  const { code, detail } = consoleError(cause);
  if (code === "DRIVE_NOT_CONFIGURED" || (status === 404 && code === ""))
    return "Uno Drive isn't available on this Uno console yet.";
  if (code === "DRIVE_BOT_NOT_CONFIGURED") return "The Uno Telegram bot isn't available right now.";
  if (code === "INVALID_BOT_TOKEN" || code === "DRIVE_BOT_TAKEN" || code === "TELEGRAM_ERROR")
    return detail || "Telegram didn't accept this bot.";
  if (code === "RATE_LIMITED" || status === 429) return "Too many tries. Wait a bit and try again.";
  if (code === "STORAGE_QUOTA_EXCEEDED" || status === 402)
    return "Cloud storage is full. Free up space or upgrade your plan.";
  if (code === "NOT_FOUND") return "That file or link doesn't exist anymore.";
  if (code === "INVALID_KEY") return "That file name isn't valid.";
  if (status === 401)
    return "The Uno console didn't accept this computer's key. Reconnect it in Settings.";
  if (status === 403) return "This computer's key isn't allowed to use Cloud storage.";
  if (status !== null) return `Uno Drive answered ${status}.`;
  return "Couldn't reach Uno Drive. Check the internet connection.";
}

async function call(deps: CloudDeps, path: string, init?: RequestInit): Promise<unknown> {
  try {
    return await (deps.fetchJson ?? fetchControlPlaneJson)(deps.token, path, init);
  } catch (cause) {
    throw new CloudError(describeDriveError(cause));
  }
}

export function parseDriveFile(raw: unknown): FilesDriveFile | null {
  const record = rec(raw);
  const key = str(record["key"]);
  if (!key) return null;
  return {
    key,
    name: str(record["name"]) || key.slice(key.lastIndexOf("/") + 1),
    size: num(record["size"]),
    modifiedAt: dateOrNull(record["last_modified"]),
  };
}

function parseFiles(raw: unknown): FilesDriveFile[] {
  const list = rec(raw)["files"];
  return Array.isArray(list)
    ? list.map(parseDriveFile).filter((file): file is FilesDriveFile => file !== null)
    : [];
}

export function parseDriveState(raw: unknown): FilesDriveState {
  const record = rec(raw);
  const telegram = rec(record["telegram"]);
  const ownBot = rec(telegram["own_bot"]);
  const chats: FilesDriveTelegramChat[] = (
    Array.isArray(telegram["links"]) ? telegram["links"] : []
  ).map((item) => {
    const link = rec(item);
    return {
      id: num(link["id"]),
      botId: num(link["bot_id"]),
      username: str(link["telegram_username"]),
      linkedAt: dateOrNull(link["created_at"]),
    };
  });
  const bucketId = record["bucket_id"];
  return {
    available: typeof bucketId === "number",
    message: null,
    bucketId: typeof bucketId === "number" ? bucketId : null,
    usedBytes: num(record["used_bytes"]),
    quotaBytes: num(record["quota_bytes"]),
    telegram: {
      sharedBot: str(telegram["shared_bot"]) || "get_uno_bot",
      sharedBotReady: telegram["shared_bot_ready"] === true,
      ownBot:
        typeof ownBot["id"] === "number"
          ? { id: ownBot["id"] as number, username: str(ownBot["username"]) }
          : null,
      ownBotsAvailable: telegram["own_bots_available"] === true,
      chats,
      downloadLimitBytes: num(telegram["download_limit_bytes"]) || 20 * 1024 * 1024,
    },
  };
}

export function unavailableDriveState(message: string): FilesDriveState {
  return {
    available: false,
    message,
    bucketId: null,
    usedBytes: 0,
    quotaBytes: 0,
    telegram: {
      sharedBot: "get_uno_bot",
      sharedBotReady: false,
      ownBot: null,
      ownBotsAvailable: false,
      chats: [],
      downloadLimitBytes: 20 * 1024 * 1024,
    },
  };
}

export function parseDriveShare(raw: unknown): FilesDriveShare {
  const record = rec(raw);
  return {
    id: num(record["id"]),
    key: str(record["key"]),
    url: str(record["url"]) || null,
    expiresAt: dateOrNull(record["expires_at"]),
    downloads: num(record["downloads"]),
    createdVia: str(record["created_via"]) || "app",
    createdAt: dateOrNull(record["created_at"]),
  };
}

export async function driveState(deps: CloudDeps): Promise<FilesDriveState> {
  return parseDriveState(await call(deps, "/api/v1/drive"));
}

export async function driveSearch(
  deps: CloudDeps,
  input: { readonly query: string; readonly smart?: boolean | undefined },
): Promise<FilesDriveFileList> {
  const query = input.query.trim();
  if (!query) return { files: [], smart: false };
  const raw = await call(
    deps,
    `/api/v1/drive/search?q=${encodeURIComponent(query)}&limit=50${input.smart ? "&smart=1" : ""}`,
  );
  return { files: parseFiles(raw), smart: rec(raw)["smart"] === true };
}

export async function driveRecent(
  deps: CloudDeps,
  input: { readonly limit?: number | undefined },
): Promise<FilesDriveFileList> {
  const limit = Math.min(200, Math.max(1, input.limit ?? 30));
  return {
    files: parseFiles(await call(deps, `/api/v1/drive/recent?limit=${limit}`)),
    smart: false,
  };
}

export async function driveShareCreate(
  deps: CloudDeps,
  input: {
    readonly key: string;
    readonly expiresInHours?: number | undefined;
    readonly via?: "app" | "agent";
  },
): Promise<FilesDriveShare> {
  const share = parseDriveShare(
    await call(deps, "/api/v1/drive/shares", {
      method: "POST",
      body: JSON.stringify({
        key: input.key,
        expires_in_hours: input.expiresInHours ?? 0,
        via: input.via ?? "app",
      }),
    }),
  );
  if (!share.url) throw new CloudError("The console didn't return a link.");
  return share;
}

export async function driveShareList(deps: CloudDeps): Promise<{ shares: FilesDriveShare[] }> {
  const list = rec(await call(deps, "/api/v1/drive/shares"))["shares"];
  return { shares: Array.isArray(list) ? list.map(parseDriveShare) : [] };
}

export async function driveShareRevoke(deps: CloudDeps, id: number): Promise<{ ok: boolean }> {
  await call(deps, `/api/v1/drive/shares/${Math.trunc(id)}`, { method: "DELETE" });
  return { ok: true };
}

export async function driveTelegramLink(
  deps: CloudDeps,
  input: { readonly ownBot?: boolean | undefined },
): Promise<FilesDriveTelegramLink> {
  const raw = rec(
    await call(deps, "/api/v1/drive/telegram/link", {
      method: "POST",
      body: JSON.stringify({ own_bot: input.ownBot === true }),
    }),
  );
  const url = str(raw["url"]);
  if (!url.startsWith("https://t.me/"))
    throw new CloudError("The console didn't return a Telegram link.");
  return { url, expiresAt: dateOrNull(raw["expires_at"]) };
}

export async function driveTelegramUnlink(deps: CloudDeps, id: number): Promise<{ ok: boolean }> {
  await call(deps, `/api/v1/drive/telegram/links/${Math.trunc(id)}`, { method: "DELETE" });
  return { ok: true };
}

export async function driveBotConnect(deps: CloudDeps, token: string): Promise<FilesDriveBot> {
  const raw = rec(
    await call(deps, "/api/v1/drive/telegram/bot", {
      method: "PUT",
      body: JSON.stringify({ token: token.trim() }),
    }),
  );
  return { id: num(raw["id"]), username: str(raw["username"]) };
}

export async function driveBotDisconnect(deps: CloudDeps): Promise<{ ok: boolean }> {
  await call(deps, "/api/v1/drive/telegram/bot", { method: "DELETE" });
  return { ok: true };
}
