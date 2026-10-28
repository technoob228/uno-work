/**
 * telegramTranscription - Voice-to-text for the Telegram assistant connector.
 *
 * Voice messages and audio files are transcribed through the Uno Gateway's
 * OpenAI-compatible `POST /audio/transcriptions`; videos and video messages
 * are described through `POST /video/describe` (speech + what is on screen;
 * an older gateway without it: the audio track is transcribed and Telegram's
 * preview frame shown instead). The text lands directly in the user message
 * (visible in the in-app dialog and readable by every harness). A gateway
 * failure still sends the turn, labelled "could not transcribe" with the
 * saved-file note.
 */

import { Data, Effect } from "effect";

import { buildMediaNote, mediaLabel, type TelegramMediaDescriptor } from "./telegramMedia.ts";

export class TelegramTranscriptionError extends Data.TaggedError("TelegramTranscriptionError")<{
  readonly message: string;
  /** Human sentence from the gateway's `{"error":{"message"}}`, shown as is. */
  readonly gatewayMessage?: string;
}> {}

/** The gateway answers errors as `{"error":{"code","message"}}`; old ones as `{"error":"CODE"}`. */
export const readGatewayErrorMessage = (body: unknown): string | null => {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return null;
  }
  const error = (body as { error?: unknown }).error;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
  }
  return null;
};

class GatewayHttpError extends Error {
  readonly status: number;
  readonly gatewayMessage: string | null;
  constructor(status: number, gatewayMessage: string | null, what = "transcription") {
    super(`${what} request failed with status ${status}`);
    this.status = status;
    this.gatewayMessage = gatewayMessage;
  }
}

export class TelegramVideoDescribeError extends Data.TaggedError("TelegramVideoDescribeError")<{
  readonly message: string;
  /** The gateway has no `/video/describe` yet (404/405): fall back to the audio track. */
  readonly unsupported: boolean;
}> {}

/** Узкая сигнатура fetch — глобальный тип Bun несёт лишний `preconnect`. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Namespaced upstream id — hermes/openai clients strip bare `whisper-large-v3`. */
export const TELEGRAM_STT_MODEL = "openai/whisper-large-v3";

/** Voice messages and audio files: transcribed through `/audio/transcriptions`. */
export const isTranscribableMedia = (descriptor: TelegramMediaDescriptor): boolean =>
  descriptor.kind === "voice" || descriptor.kind === "audio";

/** Videos and video messages: described (speech + what is on screen) through `/video/describe`. */
export const isDescribableVideo = (descriptor: TelegramMediaDescriptor): boolean =>
  descriptor.kind === "video" || descriptor.kind === "video_note";

/**
 * Media whose speech a smart-wake group needs before deciding whether the
 * assistant was addressed ("Антоха, посмотри" said aloud): voice, audio and
 * the round video message (a video's audio track transcribes the same way).
 */
export const isGatingSpeechMedia = (descriptor: TelegramMediaDescriptor): boolean =>
  isTranscribableMedia(descriptor) || descriptor.kind === "video_note";

export const parseTranscriptionResponse = (body: unknown): string | null => {
  if (typeof body === "string") {
    return body.trim().length > 0 ? body.trim() : null;
  }
  if (typeof body === "object" && body !== null && "text" in body) {
    const text = (body as { text?: unknown }).text;
    if (typeof text === "string" && text.trim().length > 0) {
      return text.trim();
    }
  }
  return null;
};

const PRONUNCIATION_NOTE =
  "The transcript above is auto-normalized text, not evidence of pronunciation. Before giving any pronunciation feedback, always send the saved audio itself once to google/gemini-3.1-pro-preview via Uno Gateway chat/completions with an input_audio part. Ask it for: exact transcript, confidence (low/medium/high), at most one observed pronunciation issue only if it can actually hear one, and a separately labelled general tip. Never infer that the pronunciation was clean/correct merely because transcription succeeded, and never present a general tip as an observed error. If its confidence is low or it reports no observed issue, say only that the phrase was understood and offer an optional general tip.";

const SAVED_KIND: Record<string, string> = {
  voice: "voice message",
  audio: "audio file",
  video: "video",
  video_note: "video message",
};

/**
 * Transcript goes first (it IS the user's message), labelled like
 * `[voice, 0:42] …` / `[audio "song.mp3", 3:10] …`; the file path stays as a
 * bracketed note so the harness can still reach the raw audio — the
 * transcript is whisper's normalized text, so anything about HOW it was said
 * (pronunciation, accent, hesitation) is only in the audio file. The note
 * says so, and names the gateway route that can actually listen to it.
 *
 * Replaces the older `🎤 (Ns): …` line; nothing parses either form.
 */
export const buildTranscriptMessageText = (input: {
  readonly descriptor: TelegramMediaDescriptor;
  readonly transcript: string;
  readonly savedPath: string;
}): string =>
  `[${mediaLabel(input.descriptor)}] ${input.transcript}\n[Telegram ${
    SAVED_KIND[input.descriptor.kind] ?? "file"
  } saved at ${input.savedPath}. ${PRONUNCIATION_NOTE}]`;

/**
 * A voice/audio/video the gateway could not turn into text: the turn still
 * reaches the assistant — the label says what happened, the saved-file note
 * says where the file is.
 */
export const buildMediaTextFailure = (input: {
  readonly descriptor: TelegramMediaDescriptor;
  readonly savedPath: string;
}): string =>
  `[${mediaLabel(input.descriptor)} — could not ${
    isDescribableVideo(input.descriptor) ? "describe" : "transcribe"
  }]\n${buildMediaNote(input.descriptor, input.savedPath)}`;

/**
 * A described video: `[video, 0:35]`, then what is said and what is on
 * screen, then where the file is.
 */
export const buildVideoMessageText = (input: {
  readonly descriptor: TelegramMediaDescriptor;
  readonly speech: string | null;
  readonly visual: string | null;
  readonly savedPath: string;
}): string =>
  [
    `[${mediaLabel(input.descriptor)}]`,
    `Speech: ${input.speech !== null && input.speech.length > 0 ? input.speech : "(none)"}`,
    ...(input.visual !== null && input.visual.length > 0 ? [`On screen: ${input.visual}`] : []),
    `[Telegram ${SAVED_KIND[input.descriptor.kind] ?? "video"} saved at ${input.savedPath}.]`,
  ].join("\n");

export const transcribeTelegramAudio = (input: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mimeType: string | null;
  readonly model?: string;
  readonly fetchImpl?: FetchLike;
}): Effect.Effect<string, TelegramTranscriptionError> =>
  Effect.gen(function* () {
    const fetchImpl = input.fetchImpl ?? fetch;
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(input.bytes)], {
        type: input.mimeType ?? "application/octet-stream",
      }),
      input.fileName,
    );
    form.append("model", input.model ?? TELEGRAM_STT_MODEL);
    form.append("response_format", "json");

    const body = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetchImpl(`${input.baseUrl}/audio/transcriptions`, {
          method: "POST",
          headers: { authorization: `Bearer ${input.apiKey}` },
          body: form,
        });
        if (!response.ok) {
          const errorBody: unknown = await response.json().catch(() => null);
          throw new GatewayHttpError(response.status, readGatewayErrorMessage(errorBody));
        }
        const contentType = response.headers.get("content-type") ?? "";
        return contentType.includes("application/json")
          ? await response.json()
          : await response.text();
      },
      catch: (cause) =>
        new TelegramTranscriptionError({
          message: cause instanceof Error ? cause.message : String(cause),
          ...(cause instanceof GatewayHttpError && cause.gatewayMessage !== null
            ? { gatewayMessage: cause.gatewayMessage }
            : {}),
        }),
    });

    const transcript = parseTranscriptionResponse(body);
    if (transcript === null) {
      return yield* new TelegramTranscriptionError({
        message: "transcription response contained no text",
      });
    }
    return transcript;
  });

export interface VideoDescription {
  readonly speech: string | null;
  readonly visual: string | null;
}

/** `{"speech","visual","duration_sec"}` of `/video/describe`; null when it says nothing. */
export const parseVideoDescription = (body: unknown): VideoDescription | null => {
  if (typeof body !== "object" || body === null) return null;
  const read = (key: string): string | null => {
    const value = (body as Record<string, unknown>)[key];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  };
  const speech = read("speech");
  const visual = read("visual");
  return speech === null && visual === null ? null : { speech, visual };
};

/** `POST {gateway}/video/describe` (multipart `file`, `duration_sec`) with the Uno key. */
export const describeTelegramVideo = (input: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mimeType: string | null;
  readonly durationSec: number | null;
  readonly fetchImpl?: FetchLike;
}): Effect.Effect<VideoDescription, TelegramVideoDescribeError> =>
  Effect.gen(function* () {
    const fetchImpl = input.fetchImpl ?? fetch;
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(input.bytes)], { type: input.mimeType ?? "video/mp4" }),
      input.fileName,
    );
    if (input.durationSec !== null) {
      form.append("duration_sec", String(input.durationSec));
    }
    const body = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetchImpl(`${input.baseUrl}/video/describe`, {
          method: "POST",
          headers: { authorization: `Bearer ${input.apiKey}` },
          body: form,
        });
        if (!response.ok) {
          const errorBody: unknown = await response.json().catch(() => null);
          throw new GatewayHttpError(
            response.status,
            readGatewayErrorMessage(errorBody),
            "video description",
          );
        }
        return (await response.json()) as unknown;
      },
      catch: (cause) =>
        new TelegramVideoDescribeError({
          message: cause instanceof Error ? cause.message : String(cause),
          unsupported:
            cause instanceof GatewayHttpError && (cause.status === 404 || cause.status === 405),
        }),
    });
    const description = parseVideoDescription(body);
    if (description === null) {
      return yield* new TelegramVideoDescribeError({
        message: "video description contained no text",
        unsupported: false,
      });
    }
    return description;
  });

export interface MediaText {
  /** What the assistant reads for this file (label + text + saved-file note). */
  readonly text: string;
  /**
   * Telegram's preview frame to show the assistant as an image: only when an
   * older gateway could not describe the video itself.
   */
  readonly thumbnailFileId: string | null;
}

/**
 * The text a voice message, audio file, video or video message becomes for
 * the assistant (null for any other media: the caller keeps its saved-file
 * note). Never fails — a gateway error is a "could not transcribe" label
 * plus the saved-file note, so the turn still runs.
 *
 * `precomputedTranscript` is the speech already transcribed to decide
 * whether a group addressed the assistant: never paid for twice.
 */
export const mediaToText = (input: {
  readonly descriptor: TelegramMediaDescriptor;
  readonly bytes: Uint8Array;
  readonly savedPath: string;
  readonly baseUrl: string;
  /** Uno key; empty when the person has none (nothing is sent anywhere). */
  readonly apiKey: string;
  readonly precomputedTranscript: string | null;
  readonly fetchImpl?: FetchLike;
}): Effect.Effect<MediaText | null> =>
  Effect.gen(function* () {
    const { descriptor, savedPath } = input;
    if (!isTranscribableMedia(descriptor) && !isDescribableVideo(descriptor)) {
      return null;
    }
    const failed: MediaText = {
      text: buildMediaTextFailure({ descriptor, savedPath }),
      thumbnailFileId: null,
    };
    const transcribe = (mimeType: string | null) =>
      input.precomputedTranscript !== null
        ? Effect.succeed<string | null>(input.precomputedTranscript)
        : input.apiKey.length === 0
          ? Effect.succeed<string | null>(null)
          : transcribeTelegramAudio({
              baseUrl: input.baseUrl,
              apiKey: input.apiKey,
              bytes: input.bytes,
              fileName: descriptor.fileName,
              mimeType,
              ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
            }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("telegram media transcription failed").pipe(
                  Effect.annotateLogs({ kind: descriptor.kind, cause: cause.message }),
                  Effect.as(null),
                ),
              ),
            );

    if (isTranscribableMedia(descriptor)) {
      const transcript = yield* transcribe(descriptor.mimeType);
      return transcript === null
        ? failed
        : {
            text: buildTranscriptMessageText({ descriptor, transcript, savedPath }),
            thumbnailFileId: null,
          };
    }

    if (input.apiKey.length === 0) {
      return input.precomputedTranscript === null
        ? failed
        : {
            text: buildVideoMessageText({
              descriptor,
              speech: input.precomputedTranscript,
              visual: null,
              savedPath,
            }),
            thumbnailFileId: descriptor.thumbnailFileId ?? null,
          };
    }
    const described = yield* describeTelegramVideo({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      bytes: input.bytes,
      fileName: descriptor.fileName,
      mimeType: descriptor.mimeType,
      durationSec: descriptor.durationSec,
      ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
    }).pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch((error) =>
        Effect.logWarning("telegram video description failed").pipe(
          Effect.annotateLogs({ kind: descriptor.kind, cause: error.message }),
          Effect.as({ ok: false as const, unsupported: error.unsupported }),
        ),
      ),
    );
    if (described.ok) {
      return {
        text: buildVideoMessageText({
          descriptor,
          speech: described.value.speech,
          visual: described.value.visual,
          savedPath,
        }),
        thumbnailFileId: null,
      };
    }
    if (!described.unsupported) {
      return failed;
    }
    // An older gateway: the audio track of the mp4 transcribes like a voice
    // message, and Telegram's preview frame shows what the video is of.
    const transcript = yield* transcribe(descriptor.mimeType ?? "video/mp4");
    const thumbnailFileId = descriptor.thumbnailFileId ?? null;
    return transcript === null
      ? { text: failed.text, thumbnailFileId }
      : {
          text: buildVideoMessageText({ descriptor, speech: transcript, visual: null, savedPath }),
          thumbnailFileId,
        };
  });
