import { it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, type DictationTranscribeInput } from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import { type FetchLike, runDictationPipeline } from "./dictationGateway.ts";

const AUDIO = Buffer.from("fake-opus-bytes").toString("base64");

const input: DictationTranscribeInput = {
  audioBase64: AUDIO,
  mimeType: "audio/webm",
  durationMs: 4200,
};

const dictation = DEFAULT_SERVER_SETTINGS.dictation;

interface Call {
  readonly url: string;
  readonly body: unknown;
}

/** Records each request and replays canned responses per endpoint. */
const stubFetch = (responses: {
  readonly transcription: () => Response;
  readonly cleanup?: () => Response;
}): { readonly fetchImpl: FetchLike; readonly calls: Call[] } => {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: init?.body });
    if (url.endsWith("/audio/transcriptions")) return responses.transcription();
    if (url.endsWith("/chat/completions")) {
      if (!responses.cleanup) throw new Error("unexpected clean-up call");
      return responses.cleanup();
    }
    throw new Error(`unexpected url ${url}`);
  };
  return { fetchImpl, calls };
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("runDictationPipeline", () => {
  it.effect("returns the raw transcript when clean-up is disabled", () =>
    Effect.gen(function* () {
      const { fetchImpl, calls } = stubFetch({
        transcription: () => json({ text: "открой ворктри" }),
      });
      const result = yield* runDictationPipeline({
        apiKey: "key",
        dictation: { ...dictation, cleanupEnabled: false },
        input,
        fetchImpl,
      });
      expect(result.text).toBe("открой ворктри");
      expect(result.cleanupApplied).toBe(false);
      expect(calls).toHaveLength(1);
    }),
  );

  it.effect("applies the glossary pass and reports it", () =>
    Effect.gen(function* () {
      const { fetchImpl, calls } = stubFetch({
        transcription: () => json({ text: "открой ворк три" }),
        cleanup: () => json({ choices: [{ message: { content: "открой worktree" } }] }),
      });
      const result = yield* runDictationPipeline({
        apiKey: "key",
        dictation: { ...dictation, vocabulary: "worktree" },
        input: { ...input, projectPath: "/tmp/uno-work-app" },
        fetchImpl,
      });
      expect(result.text).toBe("открой worktree");
      expect(result.rawText).toBe("открой ворк три");
      expect(result.cleanupApplied).toBe(true);

      const cleanupBody = JSON.parse(String(calls[1]?.body)) as {
        model: string;
        messages: ReadonlyArray<{ content: string }>;
      };
      expect(cleanupBody.model).toBe(dictation.cleanupModel);
      expect(cleanupBody.messages[1]?.content).toContain("worktree");
      expect(cleanupBody.messages[1]?.content).toContain("Project: uno-work-app");
    }),
  );

  it.effect("falls back to the raw transcript when the clean-up route fails", () =>
    Effect.gen(function* () {
      const { fetchImpl } = stubFetch({
        transcription: () => json({ text: "почини сборку" }),
        cleanup: () =>
          json({ error: { message: "The request is prohibited due to a violation" } }, 403),
      });
      const result = yield* runDictationPipeline({
        apiKey: "key",
        dictation,
        input,
        fetchImpl,
      });
      expect(result.text).toBe("почини сборку");
      expect(result.cleanupApplied).toBe(false);
      expect(result.cleanupError).toContain("prohibited");
    }),
  );

  it.effect("keeps the transcript when the model answers instead of editing", () =>
    Effect.gen(function* () {
      const { fetchImpl } = stubFetch({
        transcription: () => json({ text: "почини сборку" }),
        cleanup: () =>
          json({
            choices: [
              { message: { content: "Sure! Here is how you would fix the build: ".repeat(8) } },
            ],
          }),
      });
      const result = yield* runDictationPipeline({ apiKey: "key", dictation, input, fetchImpl });
      expect(result.text).toBe("почини сборку");
      expect(result.cleanupApplied).toBe(false);
    }),
  );

  it.effect("pins the language upstream when the user picked one", () =>
    Effect.gen(function* () {
      const { fetchImpl, calls } = stubFetch({
        transcription: () => json({ text: "привет" }),
      });
      yield* runDictationPipeline({
        apiKey: "key",
        dictation: { ...dictation, language: "ru", cleanupEnabled: false },
        input,
        fetchImpl,
      });
      const form = calls[0]?.body as FormData;
      expect(form.get("language")).toBe("ru");
      expect(form.get("model")).toBe("openai/whisper-large-v3");
      expect((form.get("file") as File).name).toBe("dictation.webm");
    }),
  );

  it.effect("surfaces an empty recognition as a typed error", () =>
    Effect.gen(function* () {
      const { fetchImpl } = stubFetch({ transcription: () => json({ text: "   " }) });
      const result = yield* Effect.result(
        runDictationPipeline({ apiKey: "key", dictation, input, fetchImpl }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("rejects an empty recording before touching the gateway", () =>
    Effect.gen(function* () {
      const { fetchImpl, calls } = stubFetch({
        transcription: () => json({ text: "unused" }),
      });
      const result = yield* Effect.result(
        runDictationPipeline({
          apiKey: "key",
          dictation,
          input: { ...input, audioBase64: "" },
          fetchImpl,
        }),
      );
      expect(result._tag).toBe("Failure");
      expect(calls).toHaveLength(0);
    }),
  );
});
