/**
 * telegramMedia - Pure helpers for Telegram media in the assistant connector.
 *
 * Inbound: every media kind a Telegram message can carry (photo, voice, video
 * note, audio, video, document, sticker, animation) is normalized into a
 * {@link TelegramMediaDescriptor} so the connector can download it via the Bot
 * API. Images are routed into the chat attachment pipeline (harnesses see them
 * as vision inputs); everything else is saved to disk and surfaced to the
 * harness as a bracketed note with the absolute path.
 *
 * Outbound: the assistant is told (via {@link TELEGRAM_SEND_FILE_HINT}) to mark
 * files it wants delivered to the chat with `[[send-file: /abs/path]]` lines;
 * {@link extractOutgoingFiles} strips those markers out of the reply text.
 */

import type { NormalizedIncomingMessage } from "./addressing.ts";

export interface TelegramFileSize {
  readonly file_id?: string;
  readonly file_size?: number;
  readonly width?: number;
}

export interface TelegramMessageEntity {
  readonly type?: string;
  readonly offset?: number;
  readonly length?: number;
}

export interface TelegramIncomingMessage {
  readonly chat?: {
    readonly id?: number;
    readonly title?: string;
    readonly username?: string;
    /** "private" | "group" | "supergroup" | "channel". */
    readonly type?: string;
  };
  /** Sender; used to gate group messages and to never answer other bots. */
  readonly from?: {
    readonly id?: number;
    readonly is_bot?: boolean;
    readonly username?: string;
    readonly first_name?: string;
  };
  /** Formatting spans of `text` — how @mentions and /commands are detected. */
  readonly entities?: ReadonlyArray<TelegramMessageEntity>;
  /** Formatting spans of `caption` (media messages carry mentions here). */
  readonly caption_entities?: ReadonlyArray<TelegramMessageEntity>;
  /** The message this one replies to; a reply to the bot counts as addressing it. */
  readonly reply_to_message?: {
    readonly from?: {
      readonly id?: number;
      readonly is_bot?: boolean;
      readonly username?: string;
    };
  };
  readonly text?: string;
  readonly caption?: string;
  readonly photo?: ReadonlyArray<TelegramFileSize>;
  readonly voice?: {
    readonly file_id?: string;
    readonly duration?: number;
    readonly mime_type?: string;
    readonly file_size?: number;
  };
  readonly audio?: {
    readonly file_id?: string;
    readonly duration?: number;
    readonly mime_type?: string;
    readonly file_name?: string;
    readonly file_size?: number;
  };
  readonly video?: {
    readonly file_id?: string;
    readonly duration?: number;
    readonly mime_type?: string;
    readonly file_name?: string;
    readonly file_size?: number;
  };
  readonly video_note?: {
    readonly file_id?: string;
    readonly duration?: number;
    readonly file_size?: number;
  };
  readonly document?: {
    readonly file_id?: string;
    readonly file_name?: string;
    readonly mime_type?: string;
    readonly file_size?: number;
  };
  readonly sticker?: {
    readonly file_id?: string;
    readonly emoji?: string;
    readonly is_animated?: boolean;
    readonly is_video?: boolean;
    readonly file_size?: number;
  };
  readonly animation?: {
    readonly file_id?: string;
    readonly file_name?: string;
    readonly mime_type?: string;
    readonly file_size?: number;
  };
  readonly location?: {
    readonly latitude?: number;
    readonly longitude?: number;
  };
  readonly contact?: {
    readonly phone_number?: string;
    readonly first_name?: string;
    readonly last_name?: string;
  };
}

export type TelegramMediaKind =
  | "photo"
  | "voice"
  | "video_note"
  | "audio"
  | "video"
  | "document"
  | "sticker"
  | "animation";

export interface TelegramMediaDescriptor {
  readonly kind: TelegramMediaKind;
  readonly fileId: string;
  /** Suggested file name including extension; always non-empty and path-safe. */
  readonly fileName: string;
  readonly mimeType: string | null;
  readonly durationSec: number | null;
  readonly sizeBytes: number | null;
}

// Telegram Bot API refuses `getFile` for anything above 20 MB.
export const TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
// Bot uploads are capped at 50 MB.
export const TELEGRAM_BOT_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;

const HUMAN_KIND_LABEL: Record<TelegramMediaKind, string> = {
  photo: "photo",
  voice: "voice message",
  video_note: "round video message",
  audio: "audio file",
  video: "video",
  document: "file",
  sticker: "sticker",
  animation: "animation",
};

export function sanitizeFileName(name: string, fallback: string): string {
  const base = name
    .replace(/[/\\]+/g, "_")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return /^[_. -]*$/.test(base) ? fallback : base;
}

/** Normalize every media payload of a Telegram message into descriptors. */
export function collectTelegramMedia(
  message: TelegramIncomingMessage,
): ReadonlyArray<TelegramMediaDescriptor> {
  const media: Array<TelegramMediaDescriptor> = [];

  if (message.photo !== undefined && message.photo.length > 0) {
    // Telegram sends every resolution of the same photo; the last entry is the
    // largest one.
    const best = [...message.photo]
      .filter((size) => size.file_id !== undefined)
      .sort((a, b) => (a.width ?? 0) - (b.width ?? 0))
      .at(-1);
    if (best?.file_id !== undefined) {
      media.push({
        kind: "photo",
        fileId: best.file_id,
        fileName: "photo.jpg",
        mimeType: "image/jpeg",
        durationSec: null,
        sizeBytes: best.file_size ?? null,
      });
    }
  }

  if (message.voice?.file_id !== undefined) {
    media.push({
      kind: "voice",
      fileId: message.voice.file_id,
      fileName: "voice.ogg",
      mimeType: message.voice.mime_type ?? "audio/ogg",
      durationSec: message.voice.duration ?? null,
      sizeBytes: message.voice.file_size ?? null,
    });
  }

  if (message.video_note?.file_id !== undefined) {
    media.push({
      kind: "video_note",
      fileId: message.video_note.file_id,
      fileName: "video-note.mp4",
      mimeType: "video/mp4",
      durationSec: message.video_note.duration ?? null,
      sizeBytes: message.video_note.file_size ?? null,
    });
  }

  if (message.audio?.file_id !== undefined) {
    media.push({
      kind: "audio",
      fileId: message.audio.file_id,
      fileName: sanitizeFileName(message.audio.file_name ?? "", "audio.mp3"),
      mimeType: message.audio.mime_type ?? null,
      durationSec: message.audio.duration ?? null,
      sizeBytes: message.audio.file_size ?? null,
    });
  }

  if (message.video?.file_id !== undefined) {
    media.push({
      kind: "video",
      fileId: message.video.file_id,
      fileName: sanitizeFileName(message.video.file_name ?? "", "video.mp4"),
      mimeType: message.video.mime_type ?? "video/mp4",
      durationSec: message.video.duration ?? null,
      sizeBytes: message.video.file_size ?? null,
    });
  }

  if (message.document?.file_id !== undefined) {
    media.push({
      kind: "document",
      fileId: message.document.file_id,
      fileName: sanitizeFileName(message.document.file_name ?? "", "document.bin"),
      mimeType: message.document.mime_type ?? null,
      durationSec: null,
      sizeBytes: message.document.file_size ?? null,
    });
  }

  const sticker = message.sticker;
  if (sticker?.file_id !== undefined) {
    const fileName =
      sticker.is_video === true
        ? "sticker.webm"
        : sticker.is_animated === true
          ? "sticker.tgs"
          : "sticker.webp";
    const mimeType =
      sticker.is_video === true ? "video/webm" : sticker.is_animated === true ? null : "image/webp";
    media.push({
      kind: "sticker",
      fileId: sticker.file_id,
      fileName,
      mimeType,
      durationSec: null,
      sizeBytes: sticker.file_size ?? null,
    });
  }

  if (message.animation?.file_id !== undefined) {
    media.push({
      kind: "animation",
      fileId: message.animation.file_id,
      fileName: sanitizeFileName(message.animation.file_name ?? "", "animation.mp4"),
      mimeType: message.animation.mime_type ?? "video/mp4",
      durationSec: null,
      sizeBytes: message.animation.file_size ?? null,
    });
  }

  return media;
}

/** Non-file payloads (location, contact) rendered as plain text lines. */
export function describeNonFileContent(message: TelegramIncomingMessage): ReadonlyArray<string> {
  const lines: Array<string> = [];
  if (message.location?.latitude !== undefined && message.location.longitude !== undefined) {
    lines.push(
      `[Telegram location: latitude ${message.location.latitude}, longitude ${message.location.longitude}]`,
    );
  }
  if (message.contact?.phone_number !== undefined) {
    const name = [message.contact.first_name, message.contact.last_name]
      .filter((part) => part !== undefined && part.length > 0)
      .join(" ");
    lines.push(
      `[Telegram contact: ${name.length > 0 ? name : "unnamed"}, phone ${message.contact.phone_number}]`,
    );
  }
  return lines;
}

// ===============================
// Addressing signals
// ===============================

/** A private (1:1) chat — the assistant always answers here. */
export function telegramIsDirectMessage(message: TelegramIncomingMessage): boolean {
  return message.chat?.type === "private";
}

/** The sender is another bot — never engage, it invites message loops. */
export function telegramSenderIsBot(message: TelegramIncomingMessage): boolean {
  return message.from?.is_bot === true;
}

function entitiesTargetBot(
  text: string | undefined,
  entities: ReadonlyArray<TelegramMessageEntity> | undefined,
  handle: string,
): boolean {
  if (text === undefined || entities === undefined) return false;
  for (const entity of entities) {
    if (entity.offset === undefined || entity.length === undefined) continue;
    const slice = text.slice(entity.offset, entity.offset + entity.length).toLowerCase();
    if (entity.type === "mention" && slice === handle) return true;
    // `/status@mybot` — a command explicitly routed to this bot.
    if (entity.type === "bot_command" && slice.endsWith(handle)) return true;
  }
  return false;
}

/**
 * Is the bot @-mentioned (or targeted by a `/cmd@bot`) in this message? Reads
 * the message's own entities first (Telegram always emits them for mentions);
 * a plain-text fallback covers the rare client that omits them.
 */
export function telegramMentionsBot(
  message: TelegramIncomingMessage,
  botUsername: string,
): boolean {
  const handle = `@${botUsername.toLowerCase()}`;
  if (
    entitiesTargetBot(message.text, message.entities, handle) ||
    entitiesTargetBot(message.caption, message.caption_entities, handle)
  ) {
    return true;
  }
  const haystack = `${message.text ?? ""}\n${message.caption ?? ""}`.toLowerCase();
  // `@mybot` not glued to another word (so it never matches `@mybot2`).
  const escaped = botUsername.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${escaped}(?![a-z0-9_])`).test(haystack);
}

/** Does this message reply to one of the bot's own messages? */
export function telegramRepliesToBot(
  message: TelegramIncomingMessage,
  botUsername: string,
): boolean {
  const repliedTo = message.reply_to_message?.from;
  if (repliedTo === undefined) return false;
  return repliedTo.username?.toLowerCase() === botUsername.toLowerCase();
}

/**
 * Fold a Telegram message into the transport-agnostic shape the addressing
 * policy consumes. `text` is passed in explicitly because the connector may
 * have folded a voice transcript into it before deciding. A null bot username
 * (getMe not yet resolved) conservatively disables mention/reply detection.
 */
export function toNormalizedMessage(input: {
  readonly message: TelegramIncomingMessage;
  readonly botUsername: string | null;
  readonly text: string;
}): NormalizedIncomingMessage {
  const { message, botUsername } = input;
  return {
    isDirectMessage: telegramIsDirectMessage(message),
    isReplyToBot: botUsername !== null && telegramRepliesToBot(message, botUsername),
    explicitMention: botUsername !== null && telegramMentionsBot(message, botUsername),
    senderIsBot: telegramSenderIsBot(message),
    text: input.text,
  };
}

/**
 * Media that should enter the image attachment pipeline (harnesses receive it
 * as a vision input) rather than be dropped on disk as an opaque file.
 */
export function isImageLikeMedia(descriptor: TelegramMediaDescriptor): boolean {
  if (descriptor.kind === "photo") {
    return true;
  }
  return descriptor.mimeType !== null && /^image\//i.test(descriptor.mimeType);
}

function describeMedia(descriptor: TelegramMediaDescriptor): string {
  const details: Array<string> = [];
  if (descriptor.kind !== "photo" && descriptor.fileName.includes(".")) {
    details.push(`"${descriptor.fileName}"`);
  }
  if (descriptor.mimeType !== null) {
    details.push(descriptor.mimeType);
  }
  if (descriptor.durationSec !== null) {
    details.push(`${descriptor.durationSec}s`);
  }
  if (descriptor.sizeBytes !== null) {
    details.push(`${descriptor.sizeBytes} bytes`);
  }
  const label = HUMAN_KIND_LABEL[descriptor.kind];
  return details.length > 0 ? `${label} (${details.join(", ")})` : label;
}

/** Note injected into the turn for a media file saved to disk. */
export function buildMediaNote(descriptor: TelegramMediaDescriptor, savedPath: string): string {
  const base = `[Telegram attachment: ${describeMedia(descriptor)} saved at ${savedPath}.`;
  if (descriptor.kind === "voice" || descriptor.kind === "video_note") {
    return `${base} Transcribe it with the tools available to you (e.g. ffmpeg + a speech-to-text tool) and treat the transcript as the user's message.]`;
  }
  return `${base} Read or process the file as needed.]`;
}

/** Note injected when a media file could not be fetched from Telegram. */
export function buildMediaFailureNote(descriptor: TelegramMediaDescriptor, reason: string): string {
  return `[Telegram attachment: ${describeMedia(descriptor)} could not be downloaded: ${reason}]`;
}

/**
 * Standing instruction appended to every Telegram-originated turn. Kept to one
 * short line: it shows up in the thread projection too.
 */
export const TELEGRAM_SEND_FILE_HINT =
  "[tg: to attach a file to your Telegram reply, put [[send-file: /absolute/path]] on its own line]";

const SEND_FILE_MARKER = /\[\[\s*send-file\s*:\s*([^\]\n]+?)\s*\]\]/gi;

export interface OutgoingFilesExtraction {
  readonly text: string;
  readonly files: ReadonlyArray<string>;
}

/** Pull `[[send-file: …]]` markers out of a reply, deduplicated, in order. */
export function extractOutgoingFiles(text: string): OutgoingFilesExtraction {
  const files: Array<string> = [];
  const cleaned = text.replace(SEND_FILE_MARKER, (_match, rawPath: string) => {
    const filePath = rawPath.trim();
    if (filePath.length > 0 && !files.includes(filePath)) {
      files.push(filePath);
    }
    return "";
  });
  return {
    text: cleaned
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    files,
  };
}

const PHOTO_UPLOAD_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export interface TelegramUploadMethod {
  readonly method: "sendPhoto" | "sendDocument";
  readonly field: "photo" | "document";
}

/**
 * Photos go through `sendPhoto` (inline preview in the chat); everything else
 * is a document so Telegram never re-encodes it.
 */
export function pickTelegramUploadMethod(fileName: string): TelegramUploadMethod {
  const extensionIndex = fileName.lastIndexOf(".");
  const extension = extensionIndex >= 0 ? fileName.slice(extensionIndex).toLowerCase() : "";
  return PHOTO_UPLOAD_EXTENSIONS.has(extension)
    ? { method: "sendPhoto", field: "photo" }
    : { method: "sendDocument", field: "document" };
}
