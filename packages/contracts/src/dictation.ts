/**
 * dictation - Push-to-talk voice input for the chat composer.
 *
 * Audio is captured in the renderer, shipped to the server as base64 and
 * transcribed through the Uno Gateway's OpenAI-compatible
 * `POST /audio/transcriptions`. An optional second pass sends the raw
 * transcript through `POST /chat/completions` together with a project
 * glossary so project jargon ("worktree", "typecheck", branch names) survives
 * the speech model, which has no way to know them.
 */

import { Schema } from "effect";
import { NonNegativeInt, TrimmedString } from "./baseSchemas.ts";

/** The only transcription model the Uno Gateway accepts today. */
export const DICTATION_STT_MODEL = "openai/whisper-large-v3";

/** Cheap, fast, and good at multilingual clean-up of a short transcript. */
export const DEFAULT_DICTATION_CLEANUP_MODEL = "google/gemini-3.6-flash";

/** Audio longer than this is closed out client-side before the upload. */
export const DICTATION_MAX_DURATION_MS = 5 * 60 * 1000;

/** The gateway caps transcription uploads at 25 MB; stay well below it. */
export const DICTATION_MAX_AUDIO_BYTES = 20 * 1024 * 1024;

/**
 * "auto" lets the speech model detect the language. Explicit codes exist
 * because auto-detect occasionally returns an English *translation* instead of
 * a transcript, and pinning the language is the only lever the
 * OpenAI-compatible API gives us.
 */
export const DICTATION_LANGUAGES = [
  "auto",
  "ru",
  "en",
  "es",
  "de",
  "fr",
  "it",
  "pt",
  "uk",
  "pl",
  "tr",
  "zh",
  "ja",
] as const;

export const DictationLanguage = Schema.Literals(DICTATION_LANGUAGES);
export type DictationLanguage = typeof DictationLanguage.Type;

export const DICTATION_LANGUAGE_LABELS: Readonly<Record<DictationLanguage, string>> = {
  auto: "Auto",
  ru: "Русский",
  en: "English",
  es: "Español",
  de: "Deutsch",
  fr: "Français",
  it: "Italiano",
  pt: "Português",
  uk: "Українська",
  pl: "Polski",
  tr: "Türkçe",
  zh: "中文",
  ja: "日本語",
};

export const DictationAudioMimeType = Schema.Literals([
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
]);
export type DictationAudioMimeType = typeof DictationAudioMimeType.Type;

export const DictationTranscribeInput = Schema.Struct({
  /** Base64 (no `data:` prefix) of the recorded audio. */
  audioBase64: Schema.String,
  mimeType: DictationAudioMimeType,
  durationMs: NonNegativeInt,
  /**
   * Absolute path of the project the dictation belongs to. Used to build the
   * glossary for the clean-up pass; dictation still works without it.
   */
  projectPath: Schema.optional(TrimmedString),
  /**
   * Extra terms the client knows about and the server cannot see (active
   * branch, model name, open file). Merged into the glossary.
   */
  contextTerms: Schema.optional(Schema.Array(TrimmedString)),
});
export type DictationTranscribeInput = typeof DictationTranscribeInput.Type;

export const DictationTranscribeResult = Schema.Struct({
  /** What the composer should insert. */
  text: Schema.String,
  /** Transcript before the glossary pass — kept for debugging and telemetry. */
  rawText: Schema.String,
  cleanupApplied: Schema.Boolean,
  /** Set when the clean-up pass was requested but failed (transcript still valid). */
  cleanupError: Schema.optional(Schema.String),
  model: Schema.String,
  transcribeMs: NonNegativeInt,
  cleanupMs: NonNegativeInt,
});
export type DictationTranscribeResult = typeof DictationTranscribeResult.Type;

export const DictationErrorKind = Schema.Literals([
  "not_configured",
  "disabled",
  "too_large",
  "gateway",
  "empty",
]);
export type DictationErrorKind = typeof DictationErrorKind.Type;

export class DictationRpcError extends Schema.TaggedErrorClass<DictationRpcError>()(
  "DictationRpcError",
  {
    kind: DictationErrorKind,
    message: Schema.String,
    status: Schema.optional(Schema.Number),
  },
) {}
