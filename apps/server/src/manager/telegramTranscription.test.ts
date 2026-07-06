import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import type { TelegramMediaDescriptor } from "./telegramMedia.ts";
import {
  TELEGRAM_STT_MODEL,
  buildTranscriptMessageText,
  isTranscribableMedia,
  parseTranscriptionResponse,
  transcribeTelegramAudio,
  type FetchLike,
} from "./telegramTranscription.ts";

const voiceDescriptor: TelegramMediaDescriptor = {
  kind: "voice",
  fileId: "file-1",
  fileName: "voice.ogg",
  mimeType: "audio/ogg",
  durationSec: 3,
  sizeBytes: 15129,
};

describe("isTranscribableMedia", () => {
  it("targets voice and video notes only", () => {
    expect(isTranscribableMedia(voiceDescriptor)).toBe(true);
    expect(isTranscribableMedia({ ...voiceDescriptor, kind: "video_note" })).toBe(true);
    expect(isTranscribableMedia({ ...voiceDescriptor, kind: "audio" })).toBe(false);
    expect(isTranscribableMedia({ ...voiceDescriptor, kind: "document" })).toBe(false);
  });
});

describe("parseTranscriptionResponse", () => {
  it("accepts OpenAI json and plain text bodies", () => {
    expect(parseTranscriptionResponse({ text: " привет " })).toBe("привет");
    expect(parseTranscriptionResponse("привет")).toBe("привет");
  });

  it("rejects empty and malformed bodies", () => {
    expect(parseTranscriptionResponse({ text: "  " })).toBeNull();
    expect(parseTranscriptionResponse({ transcript: "x" })).toBeNull();
    expect(parseTranscriptionResponse("")).toBeNull();
    expect(parseTranscriptionResponse(null)).toBeNull();
  });
});

describe("buildTranscriptMessageText", () => {
  it("leads with the transcript and keeps the saved path as a note", () => {
    const text = buildTranscriptMessageText({
      descriptor: voiceDescriptor,
      transcript: "перезапусти треды",
      savedPath: "/state/telegram-files/1/voice.ogg",
    });
    expect(text).toBe(
      "🎤 (3s): перезапусти треды\n[Telegram voice message saved at /state/telegram-files/1/voice.ogg]",
    );
  });
});

describe("transcribeTelegramAudio", () => {
  const request = (fetchImpl: FetchLike) =>
    transcribeTelegramAudio({
      baseUrl: "https://gw.test/v1",
      apiKey: "sk-uno",
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "voice.ogg",
      mimeType: "audio/ogg",
      fetchImpl,
    });

  it.effect("posts multipart to the gateway and returns the transcript", () =>
    Effect.gen(function* () {
      let seenUrl = "";
      let seenAuth = "";
      let seenModel = "";
      const fetchImpl: FetchLike = async (url, init) => {
        seenUrl = String(url);
        seenAuth = new Headers(init?.headers).get("authorization") ?? "";
        seenModel = String((init?.body as FormData).get("model"));
        return new Response(JSON.stringify({ text: "привет" }), {
          headers: { "content-type": "application/json" },
        });
      };
      const transcript = yield* request(fetchImpl);
      expect(transcript).toBe("привет");
      expect(seenUrl).toBe("https://gw.test/v1/audio/transcriptions");
      expect(seenAuth).toBe("Bearer sk-uno");
      expect(seenModel).toBe(TELEGRAM_STT_MODEL);
    }),
  );

  it.effect("fails on a non-2xx gateway response", () =>
    Effect.gen(function* () {
      const fetchImpl: FetchLike = async () => new Response("nope", { status: 401 });
      const exit = yield* Effect.exit(request(fetchImpl));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("fails when the body carries no text", () =>
    Effect.gen(function* () {
      const fetchImpl: FetchLike = async () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      const exit = yield* Effect.exit(request(fetchImpl));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});
