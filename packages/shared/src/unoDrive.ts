/**
 * Uno Drive: reading the console's `/api/v1/drive*` answers (snake_case) into
 * the contract shapes. Shared by the daemon (files/drive.ts) and the web lite
 * build, which calls the console as the signed-in person.
 */
import type {
  FilesDriveFile,
  FilesDriveShare,
  FilesDriveState,
  FilesDriveTelegramChat,
} from "@t3tools/contracts";

import { controlPlaneErrorStatus } from "./unoCloud.ts";

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

export function parseDriveFiles(raw: unknown): FilesDriveFile[] {
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
