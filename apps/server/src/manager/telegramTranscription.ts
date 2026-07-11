/**
 * telegramTranscription - Voice-to-text for the Telegram assistant connector.
 *
 * Voice and video notes are transcribed through the Uno Gateway's
 * OpenAI-compatible `POST /audio/transcriptions` so the transcript lands
 * directly in the user message text (visible in the in-app dialog and readable
 * by every harness). Callers degrade to the plain saved-file note when the
 * gateway is unreachable or no API key is configured.
 */

import { Data, Effect } from "effect";

import type { TelegramMediaDescriptor } from "./telegramMedia.ts";

export class TelegramTranscriptionError extends Data.TaggedError("TelegramTranscriptionError")<{
  readonly message: string;
}> {}

/** Узкая сигнатура fetch — глобальный тип Bun несёт лишний `preconnect`. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Namespaced upstream id — hermes/openai clients strip bare `whisper-large-v3`. */
export const TELEGRAM_STT_MODEL = "openai/whisper-large-v3";

export const isTranscribableMedia = (descriptor: TelegramMediaDescriptor): boolean =>
  descriptor.kind === "voice" || descriptor.kind === "video_note";

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

/**
 * Transcript goes first (it IS the user's message); the file path stays as a
 * bracketed note so the harness can still reach the raw audio — the transcript
 * is whisper's normalized text, so anything about HOW it was said
 * (pronunciation, accent, hesitation) is only in the audio file. The note
 * says so, and names the gateway route that can actually listen to it.
 */
export const buildTranscriptMessageText = (input: {
  readonly descriptor: TelegramMediaDescriptor;
  readonly transcript: string;
  readonly savedPath: string;
}): string => {
  const duration =
    input.descriptor.durationSec !== null ? ` (${input.descriptor.durationSec}s)` : "";
  return `🎤${duration}: ${input.transcript}\n[Telegram ${
    input.descriptor.kind === "video_note" ? "video note" : "voice message"
  } saved at ${input.savedPath}. The transcript above is auto-normalized text; to analyze delivery (pronunciation, accent, tone), send the audio file itself to an audio-capable model via the Uno Gateway chat/completions (e.g. google/gemini-3.1-pro-preview with an input_audio content part).]`;
};

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
          throw new Error(`transcription request failed with status ${response.status}`);
        }
        const contentType = response.headers.get("content-type") ?? "";
        return contentType.includes("application/json")
          ? await response.json()
          : await response.text();
      },
      catch: (cause) =>
        new TelegramTranscriptionError({
          message: cause instanceof Error ? cause.message : String(cause),
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
