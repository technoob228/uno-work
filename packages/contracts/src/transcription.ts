import { Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * uno.transcribeAudio — dictation clips recorded in the web client are
 * transcribed server-side through the Uno Gateway `/audio/transcriptions`
 * route, so the account API key never reaches the browser.
 */

/** ~16 MB of base64 ≈ 12 MB of audio — far above any realistic dictation clip. */
export const UNO_TRANSCRIBE_MAX_BASE64_LENGTH = 16_000_000;

export const UnoTranscribeAudioInput = Schema.Struct({
  audioBase64: TrimmedNonEmptyString.check(Schema.isMaxLength(UNO_TRANSCRIBE_MAX_BASE64_LENGTH)),
  mimeType: TrimmedNonEmptyString,
  fileName: Schema.optional(Schema.String),
});
export type UnoTranscribeAudioInput = typeof UnoTranscribeAudioInput.Type;

export const UnoTranscribeAudioResult = Schema.Struct({
  text: Schema.String,
});
export type UnoTranscribeAudioResult = typeof UnoTranscribeAudioResult.Type;

export class UnoTranscriptionError extends Schema.TaggedErrorClass<UnoTranscriptionError>()(
  "UnoTranscriptionError",
  {
    message: Schema.String,
    reason: Schema.optional(Schema.Literals(["missing-api-key", "invalid-audio", "gateway"])),
  },
) {}
