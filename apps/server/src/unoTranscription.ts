/**
 * unoTranscription - Dictation support for the web client.
 *
 * Audio recorded in the composer is shipped here as base64 and forwarded to
 * the Uno Gateway's OpenAI-compatible `POST /audio/transcriptions`, reusing
 * the same transport as the Telegram voice-message pipeline. The account API
 * key stays server-side (`settings.uno.apiKey`), never in the browser.
 */

import {
  UNO_GATEWAY_BASE_URL,
  type UnoTranscribeAudioInput,
  type UnoTranscribeAudioResult,
  UnoTranscriptionError,
} from "@t3tools/contracts";
import { Effect } from "effect";

import { transcribeTelegramAudio } from "./manager/telegramTranscription.ts";
import { ServerSettingsService } from "./serverSettings.ts";

export const DICTATION_STT_MODEL = "openai/whisper-large-v3";

const decodeAudioBase64 = (audioBase64: string) =>
  Effect.try({
    try: () => {
      const bytes = Uint8Array.from(Buffer.from(audioBase64, "base64"));
      if (bytes.byteLength === 0) {
        throw new Error("decoded audio is empty");
      }
      return bytes;
    },
    catch: () =>
      new UnoTranscriptionError({
        message: "Recorded audio could not be decoded.",
        reason: "invalid-audio",
      }),
  });

export const transcribeUnoAudio = (
  input: UnoTranscribeAudioInput,
): Effect.Effect<UnoTranscribeAudioResult, UnoTranscriptionError, ServerSettingsService> =>
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        () =>
          new UnoTranscriptionError({
            message: "Unable to read Uno settings.",
            reason: "missing-api-key",
          }),
      ),
    );
    const apiKey = settings.uno.apiKey.trim();
    if (apiKey.length === 0) {
      return yield* new UnoTranscriptionError({
        message: "Connect your Uno account (Settings → Uno API key) to use dictation.",
        reason: "missing-api-key",
      });
    }

    const bytes = yield* decodeAudioBase64(input.audioBase64);

    const text = yield* transcribeTelegramAudio({
      baseUrl: UNO_GATEWAY_BASE_URL,
      apiKey,
      bytes,
      fileName: input.fileName ?? "dictation.webm",
      mimeType: input.mimeType,
      model: DICTATION_STT_MODEL,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new UnoTranscriptionError({
            message: `Transcription failed: ${cause.message}`,
            reason: "gateway",
          }),
      ),
    );

    return { text };
  });
