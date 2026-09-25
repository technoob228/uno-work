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
  FilesDriveFileList,
  FilesDriveShare,
  FilesDriveState,
  FilesDriveTelegramLink,
} from "@t3tools/contracts";

import { fetchControlPlaneJson } from "../workspaceRegistry/unoCloudParse.ts";
import {
  describeDriveError,
  parseDriveFiles,
  parseDriveShare,
  parseDriveState,
  unavailableDriveState,
} from "@t3tools/shared/unoDrive";

import { CloudError, type CloudDeps } from "./cloudStorage.ts";

export { describeDriveError, parseDriveState, unavailableDriveState };

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

async function call(deps: CloudDeps, path: string, init?: RequestInit): Promise<unknown> {
  try {
    return await (deps.fetchJson ?? fetchControlPlaneJson)(deps.token, path, init);
  } catch (cause) {
    throw new CloudError(describeDriveError(cause));
  }
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
  return { files: parseDriveFiles(raw), smart: rec(raw)["smart"] === true };
}

export async function driveRecent(
  deps: CloudDeps,
  input: { readonly limit?: number | undefined },
): Promise<FilesDriveFileList> {
  const limit = Math.min(200, Math.max(1, input.limit ?? 30));
  return {
    files: parseDriveFiles(await call(deps, `/api/v1/drive/recent?limit=${limit}`)),
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
