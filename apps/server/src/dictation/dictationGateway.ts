/**
 * dictationGateway - server half of composer dictation.
 *
 * Two hops through the Uno Gateway:
 *   1. `POST /audio/transcriptions` (whisper-large-v3) turns the recorded blob
 *      into text. This is the only transcription model the gateway accepts.
 *   2. optional `POST /chat/completions` re-reads that text with a project
 *      glossary so repo jargon and punctuation come back correct.
 *
 * Hop 2 is best-effort by design: any failure returns the raw transcript, so a
 * flaky (or unpaid) chat route can never swallow what the user just said.
 */

import {
  DICTATION_MAX_AUDIO_BYTES,
  DICTATION_STT_MODEL,
  type DictationSettings,
  type DictationTranscribeInput,
  type DictationTranscribeResult,
  DictationRpcError,
  UNO_GATEWAY_BASE_URL,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { ServerSettingsService } from "../serverSettings.ts";
import {
  buildCleanupMessages,
  buildDictationGlossary,
  parseVocabularyTerms,
  sanitizeCleanupText,
} from "./dictationVocabulary.ts";

const TRANSCRIBE_TIMEOUT_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 15_000;
const PROJECT_TERMS_TTL_MS = 5 * 60_000;
const PROJECT_TERMS_LIMIT = 40;

const gatewayUrl = (path: string): string =>
  `${UNO_GATEWAY_BASE_URL.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;

const AUDIO_FILE_EXTENSIONS: Readonly<Record<string, string>> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
};

/** The gateway derives the upstream container format from the file name. */
export const dictationAudioFileName = (mimeType: string): string =>
  `dictation.${AUDIO_FILE_EXTENSIONS[mimeType] ?? "webm"}`;

export const parseTranscriptionText = (body: unknown): string | null => {
  if (typeof body === "string") {
    const trimmed = body.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof body === "object" && body !== null && "text" in body) {
    const text = (body as { text?: unknown }).text;
    if (typeof text === "string" && text.trim().length > 0) return text.trim();
  }
  return null;
};

export const parseChatCompletionText = (body: unknown): string | null => {
  if (typeof body !== "object" || body === null) return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  const content = message?.content;
  if (typeof content === "string" && content.trim().length > 0) return content;
  return null;
};

export function extractGatewayErrorMessage(body: unknown, fallback: string): string {
  if (typeof body === "string" && body.trim().length > 0) return body.trim().slice(0, 300);
  if (typeof body === "object" && body !== null) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "object" && error !== null) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim().length > 0) return message;
    }
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  return fallback;
}

const readBody = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (text.trim().length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

/** Narrow fetch signature — Bun's global type carries an extra `preconnect`. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const fetchWithTimeout = (
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Effect.Effect<{ readonly response: Response; readonly body: unknown }, DictationRpcError> =>
  Effect.gen(function* () {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = yield* Effect.tryPromise({
      try: () => fetchImpl(url, { ...init, signal: controller.signal }),
      catch: (cause) =>
        new DictationRpcError({
          kind: "gateway",
          message:
            cause instanceof Error && cause.name === "AbortError"
              ? `${label} timed out.`
              : cause instanceof Error
                ? cause.message
                : `${label} failed.`,
        }),
    }).pipe(Effect.ensuring(Effect.sync(() => clearTimeout(timeout))));

    const body = yield* Effect.tryPromise({
      try: () => readBody(response),
      catch: () =>
        new DictationRpcError({ kind: "gateway", message: `${label} returned no body.` }),
    });

    if (!response.ok) {
      return yield* new DictationRpcError({
        kind: "gateway",
        status: response.status,
        message: extractGatewayErrorMessage(body, `${label} failed with HTTP ${response.status}.`),
      });
    }
    return { response, body };
  });

// Project terms rarely change and dictation is latency-sensitive, so the
// directory scan is cached per project.
const projectTermsCache = new Map<
  string,
  { readonly terms: string[]; readonly expiresAt: number }
>();

const IGNORED_PROJECT_ENTRIES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "vendor",
  "tmp",
]);

async function readProjectTerms(projectPath: string): Promise<string[]> {
  const terms: string[] = [basename(projectPath)];
  try {
    const packageJson = await readFile(join(projectPath, "package.json"), "utf8");
    const parsed = JSON.parse(packageJson) as { name?: unknown };
    if (typeof parsed.name === "string" && parsed.name.trim().length > 0) {
      terms.push(parsed.name.trim());
    }
  } catch {
    // Not a JS project (or unreadable) — directory names still help.
  }
  try {
    const entries = await readdir(projectPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || IGNORED_PROJECT_ENTRIES.has(entry.name)) continue;
      terms.push(entry.name);
    }
  } catch {
    // Path may be remote or gone; the glossary degrades to user + static terms.
  }
  return terms.slice(0, PROJECT_TERMS_LIMIT);
}

const collectProjectTerms = (
  projectPath: string | undefined,
  now: number,
): Effect.Effect<string[]> => {
  if (projectPath === undefined || projectPath.trim().length === 0) return Effect.succeed([]);
  const cached = projectTermsCache.get(projectPath);
  if (cached && cached.expiresAt > now) return Effect.succeed(cached.terms);
  return Effect.tryPromise({
    try: () => readProjectTerms(projectPath),
    catch: () =>
      new DictationRpcError({ kind: "gateway", message: "Unable to read project vocabulary." }),
  }).pipe(
    Effect.map((terms) => {
      projectTermsCache.set(projectPath, { terms, expiresAt: now + PROJECT_TERMS_TTL_MS });
      return terms;
    }),
    Effect.catch((_error: DictationRpcError) => Effect.succeed<string[]>([])),
  );
};

const transcribeAudio = (input: {
  readonly apiKey: string;
  readonly audio: Uint8Array;
  readonly mimeType: string;
  readonly language: string;
  readonly fetchImpl: FetchLike;
}): Effect.Effect<string, DictationRpcError> =>
  Effect.gen(function* () {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(input.audio)], { type: input.mimeType }),
      dictationAudioFileName(input.mimeType),
    );
    form.append("model", DICTATION_STT_MODEL);
    form.append("response_format", "json");
    // The gateway does not forward `language` upstream yet; sending it costs
    // nothing and starts working the moment it does.
    if (input.language !== "auto") {
      form.append("language", input.language);
    }

    const { body } = yield* fetchWithTimeout(
      input.fetchImpl,
      gatewayUrl("/audio/transcriptions"),
      { method: "POST", headers: { Authorization: `Bearer ${input.apiKey}` }, body: form },
      TRANSCRIBE_TIMEOUT_MS,
      "Transcription request",
    );

    const text = parseTranscriptionText(body);
    if (text === null) {
      return yield* new DictationRpcError({ kind: "empty", message: "No speech was recognized." });
    }
    return text;
  });

const cleanupTranscript = (input: {
  readonly apiKey: string;
  readonly model: string;
  readonly transcript: string;
  readonly glossary: readonly string[];
  readonly language: string;
  readonly projectName: string | undefined;
  readonly fetchImpl: FetchLike;
}): Effect.Effect<string, DictationRpcError> =>
  Effect.gen(function* () {
    const { body } = yield* fetchWithTimeout(
      input.fetchImpl,
      gatewayUrl("/chat/completions"),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: input.model,
          temperature: 0,
          messages: buildCleanupMessages({
            transcript: input.transcript,
            glossary: input.glossary,
            language: input.language,
            projectName: input.projectName,
          }),
        }),
      },
      CLEANUP_TIMEOUT_MS,
      "Dictation clean-up",
    );

    const content = parseChatCompletionText(body);
    const sanitized = content === null ? null : sanitizeCleanupText(content, input.transcript);
    if (sanitized === null) {
      return yield* new DictationRpcError({
        kind: "gateway",
        message: "Clean-up model returned an unusable result.",
      });
    }
    return sanitized;
  });

const decodeAudio = (audioBase64: string): Effect.Effect<Uint8Array, DictationRpcError> =>
  Effect.gen(function* () {
    const bytes = yield* Effect.try({
      try: () => new Uint8Array(Buffer.from(audioBase64, "base64")),
      catch: () =>
        new DictationRpcError({ kind: "gateway", message: "Audio payload was invalid." }),
    });
    if (bytes.byteLength === 0) {
      return yield* new DictationRpcError({ kind: "empty", message: "Recording was empty." });
    }
    if (bytes.byteLength > DICTATION_MAX_AUDIO_BYTES) {
      return yield* new DictationRpcError({
        kind: "too_large",
        message: "Recording is too long. Dictate in shorter takes.",
      });
    }
    return bytes;
  });

const readDictationConfig = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings.pipe(
    Effect.mapError(
      () => new DictationRpcError({ kind: "not_configured", message: "Unable to read settings." }),
    ),
  );
  const dictation: DictationSettings = settings.dictation;
  if (!dictation.enabled) {
    return yield* new DictationRpcError({
      kind: "disabled",
      message: "Dictation is turned off in settings.",
    });
  }
  const apiKey = settings.uno.apiKey.trim();
  if (apiKey.length === 0) {
    return yield* new DictationRpcError({
      kind: "not_configured",
      message: "Connect your Uno account to use dictation.",
    });
  }
  return { apiKey, dictation } as const;
});

/**
 * The whole pipeline with its two collaborators (settings, network) passed in,
 * so tests can drive both gateway hops without a live gateway.
 */
export const runDictationPipeline = (options: {
  readonly apiKey: string;
  readonly dictation: DictationSettings;
  readonly input: DictationTranscribeInput;
  readonly fetchImpl?: FetchLike;
}): Effect.Effect<DictationTranscribeResult, DictationRpcError> =>
  Effect.gen(function* () {
    const { apiKey, dictation, input } = options;
    const fetchImpl = options.fetchImpl ?? fetch;
    const audio = yield* decodeAudio(input.audioBase64);

    const transcribeStartedAt = Date.now();
    const rawText = yield* transcribeAudio({
      apiKey,
      audio,
      mimeType: input.mimeType,
      language: dictation.language,
      fetchImpl,
    });
    const transcribedAt = Date.now();
    const transcribeMs = transcribedAt - transcribeStartedAt;

    if (!dictation.cleanupEnabled) {
      return {
        text: rawText,
        rawText,
        cleanupApplied: false,
        model: DICTATION_STT_MODEL,
        transcribeMs,
        cleanupMs: 0,
      } satisfies DictationTranscribeResult;
    }

    const projectTerms = yield* collectProjectTerms(input.projectPath, transcribedAt);
    const glossary = buildDictationGlossary({
      userTerms: parseVocabularyTerms(dictation.vocabulary),
      contextTerms: input.contextTerms,
      projectTerms,
    });

    const cleanup = yield* cleanupTranscript({
      apiKey,
      model: dictation.cleanupModel,
      transcript: rawText,
      glossary,
      language: dictation.language,
      projectName:
        input.projectPath !== undefined && input.projectPath.length > 0
          ? basename(input.projectPath)
          : undefined,
      fetchImpl,
    }).pipe(
      Effect.map((text) => ({ ok: true, text }) as const),
      Effect.catch((error: DictationRpcError) =>
        Effect.succeed({ ok: false, message: error.message } as const),
      ),
    );

    const cleanupMs = Date.now() - transcribedAt;

    if (!cleanup.ok) {
      yield* Effect.logWarning("dictation clean-up failed, using raw transcript", {
        detail: cleanup.message,
      });
      return {
        text: rawText,
        rawText,
        cleanupApplied: false,
        cleanupError: cleanup.message,
        model: DICTATION_STT_MODEL,
        transcribeMs,
        cleanupMs,
      } satisfies DictationTranscribeResult;
    }

    return {
      text: cleanup.text,
      rawText,
      cleanupApplied: true,
      model: DICTATION_STT_MODEL,
      transcribeMs,
      cleanupMs,
    } satisfies DictationTranscribeResult;
  });

export const transcribeDictation = (
  input: DictationTranscribeInput,
): Effect.Effect<DictationTranscribeResult, DictationRpcError, ServerSettingsService> =>
  Effect.flatMap(readDictationConfig, ({ apiKey, dictation }) =>
    runDictationPipeline({ apiKey, dictation, input }),
  );
