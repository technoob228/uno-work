/**
 * A file too big for a messenger goes as a link instead of a refusal: it is
 * copied to Uno Drive and the person gets a download link for a week. Only
 * files that passed the send gate (`connectorOutgoingFiles.ts`) come here.
 *
 * Uses the cloud functions directly: the connectors sit below `FilesService`
 * in the layers, and all a call needs is the computer's token.
 *
 * @module manager/largeFileLink
 */
import * as nodePath from "node:path";

import type { ServerSettings } from "@t3tools/contracts";

import { copyToCloud, type CloudDeps } from "../files/cloudStorage.ts";
import { driveShareCreate, driveState } from "../files/drive.ts";
import type { ReplyLanguage } from "./connectorReplyText.ts";

/** Slack's own cap is 1 GB; above this a link is kinder. */
export const SLACK_UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024;

/** How long the link works, in the text the person reads too. */
const LINK_DAYS = 7;
const DRIVE_FOLDER = "sent-from-chats/";

/** The Drive of this computer's account; null when it isn't linked. */
export const largeFileCloudDeps = (settings: Pick<ServerSettings, "uno">): CloudDeps | null => {
  const token = settings.uno.boxToken?.trim() || settings.uno.apiKey.trim();
  return token.length > 0 ? { token } : null;
};

/** A download link to a copy of the file on Uno Drive; null when Drive can't take it. */
export async function driveLinkForFile(deps: CloudDeps, file: string): Promise<string | null> {
  const state = await driveState(deps);
  if (!state.available || state.bucketId === null) return null;
  const copied = await copyToCloud(deps, {
    paths: [file],
    bucketId: state.bucketId,
    prefix: DRIVE_FOLDER,
  });
  if (copied.files === 0) return null;
  const share = await driveShareCreate(deps, {
    key: `${DRIVE_FOLDER}${nodePath.basename(file)}`,
    expiresInHours: LINK_DAYS * 24,
    via: "agent",
  });
  return share.url;
}

/** One line for the person: the link, or where the file is when there is none. */
export const largeFileText = (input: {
  readonly language: ReplyLanguage;
  readonly name: string;
  readonly sizeBytes: number;
  readonly chat: "Telegram" | "Slack";
  readonly url: string | null;
  /** Uno Work, for when no link could be made. */
  readonly moreUrl: string;
}): string => {
  const megabytes = Math.ceil(input.sizeBytes / (1024 * 1024));
  if (input.language === "ru") {
    return input.url === null
      ? `«${input.name}» (${megabytes} МБ) не влезает в ${input.chat}, а ссылку сделать не вышло: файл ждёт в Uno Work: ${input.moreUrl}`
      : `«${input.name}» (${megabytes} МБ) не влезает в ${input.chat}: [скачать](${input.url}), ссылка работает ${LINK_DAYS} дней.`;
  }
  return input.url === null
    ? `“${input.name}” (${megabytes} MB) is too big for ${input.chat} and no link could be made: it waits in Uno Work: ${input.moreUrl}`
    : `“${input.name}” (${megabytes} MB) is too big for ${input.chat}: [download](${input.url}), the link works for ${LINK_DAYS} days.`;
};
