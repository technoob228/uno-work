/**
 * telegramTranscription - Voice-to-text for the Telegram assistant connector.
 *
 * Voice messages and audio files are transcribed through the Uno Gateway's
 * OpenAI-compatible `POST /audio/transcriptions`; videos and video messages
 * are described through `POST /video/describe` (speech + what is on screen;
 * an older gateway without it: the audio track is transcribed and Telegram's
 * preview frame shown instead). The text lands directly in the user message
 * (visible in the in-app dialog and readable by every harness). A gateway
 * failure still sends the turn, labelled "could not transcribe" with a note
 * that names the cause (Uno's side, the person's limit, the file, no Uno key),
 * what to tell the person, and the saved file.
 */

import { SUPPORT_TELEGRAM } from "@t3tools/shared/supportDraft";
import { Data, Effect } from "effect";

import { buildMediaNote, mediaLabel, type TelegramMediaDescriptor } from "./telegramMedia.ts";

export class TelegramTranscriptionError extends Data.TaggedError("TelegramTranscriptionError")<{
  readonly message: string;
  /** Human sentence from the gateway's `{"error":{"message"}}`, shown as is. */
  readonly gatewayMessage?: string;
  /** HTTP status of the gateway's answer; absent: no answer (network, timeout). */
  readonly status?: number;
  /** The gateway's error code/type (`ai_hours_empty`, `invalid_request`, …). */
  readonly gatewayCode?: string;
  /** The gateway answered, but with no text (silence, noise). */
  readonly empty?: boolean;
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

/**
 * The gateway's machine-readable error: `{"error":{"code":"ai_hours_empty"}}`
 * (limits) or `{"error":{"type":"invalid_request","code":400}}` (the rest).
 */
export const readGatewayErrorCode = (body: unknown): string | null => {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return null;
  }
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string") {
    return error.trim().length > 0 ? error.trim() : null;
  }
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const { code, type } = error as { code?: unknown; type?: unknown };
  if (typeof code === "string" && code.trim().length > 0) return code.trim();
  if (typeof type === "string" && type.trim().length > 0) return type.trim();
  return null;
};

class GatewayHttpError extends Error {
  readonly status: number;
  readonly gatewayMessage: string | null;
  readonly gatewayCode: string | null;
  constructor(status: number, errorBody: unknown, what = "transcription") {
    super(`${what} request failed with status ${status}`);
    this.status = status;
    this.gatewayMessage = readGatewayErrorMessage(errorBody);
    this.gatewayCode = readGatewayErrorCode(errorBody);
  }
}

/** What a failed gateway call tells about its cause, for the error types below. */
const gatewayFailureFields = (cause: unknown) =>
  cause instanceof GatewayHttpError
    ? {
        status: cause.status,
        ...(cause.gatewayMessage !== null ? { gatewayMessage: cause.gatewayMessage } : {}),
        ...(cause.gatewayCode !== null ? { gatewayCode: cause.gatewayCode } : {}),
      }
    : {};

export class TelegramVideoDescribeError extends Data.TaggedError("TelegramVideoDescribeError")<{
  readonly message: string;
  /** The gateway has no `/video/describe` yet (404/405): fall back to the audio track. */
  readonly unsupported: boolean;
  /** Human sentence from the gateway's `{"error":{"message"}}`, shown as is. */
  readonly gatewayMessage?: string;
  readonly status?: number;
  readonly gatewayCode?: string;
  readonly empty?: boolean;
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
 * Why a voice/audio/video did not become text (Misha 20.11: say it is a
 * recognition error; when it is on Uno's side, say so and point to support;
 * when it is on the person's side, say what to do; always offer text):
 * - `uno_side` — our gateway or its provider failed: 5xx (19.11: OpenRouter
 *   out of credit -> 502 «Transcription provider failed»), no answer at all,
 *   the key refused (401/403). Nothing is missing on the computer;
 * - `limit` — the person's own Uno AI balance or limit (402/429 from the
 *   gateway itself, its sentence says which);
 * - `bad_file` — the gateway refused the file (400/413: format, size, empty);
 * - `no_speech` — the file went through, no speech in it;
 * - `no_key` — this computer has no Uno key, nothing was sent anywhere.
 */
export type MediaTextFailureReason =
  | { readonly kind: "uno_side"; readonly detail: string | null }
  | { readonly kind: "limit"; readonly detail: string | null }
  | { readonly kind: "bad_file"; readonly detail: string | null }
  | { readonly kind: "no_speech" }
  | { readonly kind: "no_key" };

/** Sorts a failed gateway call by whose side it is on (see the type above). */
export const classifyMediaFailure = (error: {
  readonly message: string;
  readonly status?: number;
  readonly gatewayMessage?: string;
  readonly gatewayCode?: string;
  readonly empty?: boolean;
}): MediaTextFailureReason => {
  if (error.empty === true) {
    return { kind: "no_speech" };
  }
  const detail = error.gatewayMessage ?? error.message;
  const status = error.status;
  if (status === 402 || status === 429) {
    return { kind: "limit", detail: error.gatewayMessage ?? null };
  }
  if (status === 400 || status === 413 || status === 415) {
    // A route the gateway does not know is ours, not the file's.
    return error.gatewayCode === "model_not_found" || error.gatewayCode === "invalid_route"
      ? { kind: "uno_side", detail }
      : { kind: "bad_file", detail: error.gatewayMessage ?? null };
  }
  return { kind: "uno_side", detail };
};

/** One line, no brackets — it sits inside the bracketed note. */
const failureDetail = (detail: string | null): string => {
  const line = (detail ?? "").replace(/\s+/g, " ").replace(/[[\]]/g, "").trim();
  return line.length === 0 ? "" : ` (${line.length > 160 ? `${line.slice(0, 157)}...` : line})`;
};

/**
 * What the assistant is told after a failure. The old note («Transcribe it
 * with the tools available to you, e.g. ffmpeg + a speech-to-text tool»)
 * made it answer «I can't recognise voice, Whisper isn't connected» while
 * the real cause was the gateway's provider balance (19–20.11): the note now
 * names the cause and what to tell the person.
 */
const failureNote = (input: {
  readonly descriptor: TelegramMediaDescriptor;
  readonly savedPath: string;
  readonly reason: MediaTextFailureReason;
}): string => {
  const saved = `[Telegram ${SAVED_KIND[input.descriptor.kind] ?? "file"} saved at ${input.savedPath}.`;
  const video = isDescribableVideo(input.descriptor);
  const what = video ? "this video" : "this voice message";
  const error = video ? "a recognition error" : "a speech recognition error";
  const tell = `Tell the person, in their language, that ${what} could not be recognised (${error})`;
  const typeIt = "and offer them to write the same as text.";
  const never =
    "Never say that Whisper or speech recognition is not connected or not available to you, and do not install or register a transcriber.";
  const reason = input.reason;
  switch (reason.kind) {
    case "uno_side":
      return `${saved} Uno's built-in recognition (the Uno AI gateway) failed on Uno's side${failureDetail(
        reason.detail,
      )}. ${tell}, that the problem is on Uno's side, that they can write to Uno support on Telegram @${SUPPORT_TELEGRAM} (https://t.me/${SUPPORT_TELEGRAM}), ${typeIt} ${never}]`;
    case "limit":
      return `${saved} The Uno AI gateway refused it because of the person's own Uno AI balance or limit${failureDetail(
        reason.detail,
      )}. ${tell}, pass on the gateway's reason in plain words (top up or wait for the limit in the Uno console), ${typeIt} ${never}]`;
    case "bad_file":
      return `${saved} The Uno AI gateway could not take this file${failureDetail(
        reason.detail,
      )}. ${tell}, ask them to record it again (shorter, under 25 MB, a usual format such as ogg or mp3), ${typeIt} ${never}]`;
    case "no_speech":
      return `${saved} The file was processed, but no speech was heard in it. ${tell}: no speech was heard; ask them to record it again closer to the microphone, ${typeIt} ${never}]`;
    case "no_key":
      return `${saved} Not sent anywhere: this computer is not signed in to Uno (no Uno key), and Uno's built-in recognition needs it. ${tell}, that Uno Work on this computer has to be signed in to their Uno account for it, ${typeIt}]`;
  }
};

/**
 * A voice/audio/video the gateway could not turn into text: the turn still
 * reaches the assistant — the label says what happened, the note says why
 * and where the file is.
 */
export const buildMediaTextFailure = (input: {
  readonly descriptor: TelegramMediaDescriptor;
  readonly savedPath: string;
  readonly reason?: MediaTextFailureReason;
}): string =>
  `[${mediaLabel(input.descriptor)} — could not ${
    isDescribableVideo(input.descriptor) ? "describe" : "transcribe"
  }]\n${
    input.reason === undefined
      ? buildMediaNote(input.descriptor, input.savedPath)
      : failureNote({
          descriptor: input.descriptor,
          savedPath: input.savedPath,
          reason: input.reason,
        })
  }`;

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
          throw new GatewayHttpError(response.status, errorBody);
        }
        const contentType = response.headers.get("content-type") ?? "";
        return contentType.includes("application/json")
          ? await response.json()
          : await response.text();
      },
      catch: (cause) =>
        new TelegramTranscriptionError({
          message: cause instanceof Error ? cause.message : String(cause),
          ...gatewayFailureFields(cause),
        }),
    });

    const transcript = parseTranscriptionResponse(body);
    if (transcript === null) {
      return yield* new TelegramTranscriptionError({
        message: "transcription response contained no text",
        empty: true,
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
          throw new GatewayHttpError(response.status, errorBody, "video description");
        }
        return (await response.json()) as unknown;
      },
      catch: (cause) =>
        new TelegramVideoDescribeError({
          message: cause instanceof Error ? cause.message : String(cause),
          unsupported:
            cause instanceof GatewayHttpError && (cause.status === 404 || cause.status === 405),
          ...gatewayFailureFields(cause),
        }),
    });
    const description = parseVideoDescription(body);
    if (description === null) {
      return yield* new TelegramVideoDescribeError({
        message: "video description contained no text",
        unsupported: false,
        empty: true,
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
    const failed = (reason: MediaTextFailureReason): MediaText => ({
      text: buildMediaTextFailure({ descriptor, savedPath, reason }),
      thumbnailFileId: null,
    });
    const noKey: MediaTextFailureReason = { kind: "no_key" };
    type Transcribed =
      | { readonly ok: true; readonly transcript: string }
      | { readonly ok: false; readonly reason: MediaTextFailureReason };
    const transcribe = (mimeType: string | null): Effect.Effect<Transcribed> =>
      input.precomputedTranscript !== null
        ? Effect.succeed({ ok: true, transcript: input.precomputedTranscript })
        : input.apiKey.length === 0
          ? Effect.succeed({ ok: false, reason: noKey })
          : transcribeTelegramAudio({
              baseUrl: input.baseUrl,
              apiKey: input.apiKey,
              bytes: input.bytes,
              fileName: descriptor.fileName,
              mimeType,
              ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
            }).pipe(
              Effect.map((transcript): Transcribed => ({ ok: true, transcript })),
              Effect.catch((cause) =>
                Effect.logWarning("telegram media transcription failed").pipe(
                  Effect.annotateLogs({ kind: descriptor.kind, cause: cause.message }),
                  Effect.as<Transcribed>({ ok: false, reason: classifyMediaFailure(cause) }),
                ),
              ),
            );

    if (isTranscribableMedia(descriptor)) {
      const transcribed = yield* transcribe(descriptor.mimeType);
      return transcribed.ok
        ? {
            text: buildTranscriptMessageText({
              descriptor,
              transcript: transcribed.transcript,
              savedPath,
            }),
            thumbnailFileId: null,
          }
        : failed(transcribed.reason);
    }

    if (input.apiKey.length === 0) {
      return input.precomputedTranscript === null
        ? failed(noKey)
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
          Effect.as({
            ok: false as const,
            unsupported: error.unsupported,
            reason: classifyMediaFailure(error),
          }),
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
      return failed(described.reason);
    }
    // An older gateway: the audio track of the mp4 transcribes like a voice
    // message, and Telegram's preview frame shows what the video is of.
    const transcribed = yield* transcribe(descriptor.mimeType ?? "video/mp4");
    const thumbnailFileId = descriptor.thumbnailFileId ?? null;
    return transcribed.ok
      ? {
          text: buildVideoMessageText({
            descriptor,
            speech: transcribed.transcript,
            visual: null,
            savedPath,
          }),
          thumbnailFileId,
        }
      : { text: failed(transcribed.reason).text, thumbnailFileId };
  });
