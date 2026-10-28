import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import type { TelegramMediaDescriptor } from "./telegramMedia.ts";
import {
  TELEGRAM_STT_MODEL,
  buildMediaTextFailure,
  buildTranscriptMessageText,
  buildVideoMessageText,
  describeTelegramVideo,
  isDescribableVideo,
  isGatingSpeechMedia,
  isTranscribableMedia,
  mediaToText,
  parseTranscriptionResponse,
  parseVideoDescription,
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
  it("transcribes voice and audio; describes video and video messages", () => {
    expect(isTranscribableMedia(voiceDescriptor)).toBe(true);
    expect(isTranscribableMedia({ ...voiceDescriptor, kind: "audio" })).toBe(true);
    expect(isTranscribableMedia({ ...voiceDescriptor, kind: "video_note" })).toBe(false);
    expect(isTranscribableMedia({ ...voiceDescriptor, kind: "document" })).toBe(false);
    expect(isDescribableVideo({ ...voiceDescriptor, kind: "video" })).toBe(true);
    expect(isDescribableVideo({ ...voiceDescriptor, kind: "video_note" })).toBe(true);
    expect(isDescribableVideo(voiceDescriptor)).toBe(false);
  });

  it("gates smart-wake groups on spoken media only", () => {
    expect(isGatingSpeechMedia(voiceDescriptor)).toBe(true);
    expect(isGatingSpeechMedia({ ...voiceDescriptor, kind: "audio" })).toBe(true);
    expect(isGatingSpeechMedia({ ...voiceDescriptor, kind: "video_note" })).toBe(true);
    expect(isGatingSpeechMedia({ ...voiceDescriptor, kind: "photo" })).toBe(false);
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
  it("leads with the labelled transcript and keeps the saved path as a note", () => {
    const text = buildTranscriptMessageText({
      descriptor: { ...voiceDescriptor, durationSec: 42 },
      transcript: "перезапусти треды",
      savedPath: "/state/telegram-files/1/voice.ogg",
    });
    expect(text).toMatch(
      /^\[voice, 0:42\] перезапусти треды\n\[Telegram voice message saved at \/state\/telegram-files\/1\/voice\.ogg\./,
    );
    // The note must tell the harness how to analyze the raw audio (delivery
    // is not in the normalized transcript).
    expect(text).toContain("input_audio");
    expect(text).not.toContain("🎤");
  });

  it("names an audio file and its length", () => {
    const text = buildTranscriptMessageText({
      descriptor: { ...voiceDescriptor, kind: "audio", fileName: "song.mp3", durationSec: 190 },
      transcript: "la la",
      savedPath: "/s/song.mp3",
    });
    expect(text.startsWith('[audio "song.mp3", 3:10] la la\n[Telegram audio file saved at')).toBe(
      true,
    );
  });

  it("labels a gateway failure and keeps the saved-file note", () => {
    const text = buildMediaTextFailure({
      descriptor: { ...voiceDescriptor, durationSec: 42 },
      savedPath: "/s/voice.ogg",
    });
    expect(text.split("\n")[0]).toBe("[voice, 0:42 — could not transcribe]");
    expect(text).toContain("saved at /s/voice.ogg");
  });
});

describe("buildVideoMessageText", () => {
  it("says what is spoken and what is on screen", () => {
    expect(
      buildVideoMessageText({
        descriptor: { ...voiceDescriptor, kind: "video", fileName: "v.mp4", durationSec: 35 },
        speech: "look at this bug",
        visual: "a browser with a red error",
        savedPath: "/s/v.mp4",
      }),
    ).toBe(
      "[video, 0:35]\nSpeech: look at this bug\nOn screen: a browser with a red error\n[Telegram video saved at /s/v.mp4.]",
    );
    expect(
      buildVideoMessageText({
        descriptor: { ...voiceDescriptor, kind: "video_note", durationSec: 12 },
        speech: null,
        visual: "a cat",
        savedPath: "/s/n.mp4",
      }).split("\n")[0],
    ).toBe("[video message, 0:12]");
  });

  it("reads the gateway's answer", () => {
    expect(parseVideoDescription({ speech: " hi ", visual: "", duration_sec: 3 })).toEqual({
      speech: "hi",
      visual: null,
    });
    expect(parseVideoDescription({ duration_sec: 3 })).toBeNull();
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

  it.effect("keeps the gateway's own error sentence", () =>
    Effect.gen(function* () {
      const fetchImpl: FetchLike = async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "dictation_limit_reached",
              message: "You've used today's free dictation.",
            },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        );
      const error = yield* Effect.flip(request(fetchImpl));
      expect(error.gatewayMessage).toBe("You've used today's free dictation.");
      expect(error.message).toBe("transcription request failed with status 429");
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

const videoDescriptor: TelegramMediaDescriptor = {
  kind: "video",
  fileId: "video-1",
  fileName: "clip.mp4",
  mimeType: "video/mp4",
  durationSec: 35,
  sizeBytes: 1_000_000,
  thumbnailFileId: "thumb-1",
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A fake gateway: answers by path, records what was asked. */
const fakeGateway = (routes: Record<string, () => Response>) => {
  const seen: Array<{ url: string; form: FormData; auth: string }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    seen.push({
      url: String(url),
      form: init?.body as FormData,
      auth: new Headers(init?.headers).get("authorization") ?? "",
    });
    const path = new URL(String(url)).pathname;
    const answer = Object.entries(routes).find(([suffix]) => path.endsWith(suffix))?.[1];
    return answer === undefined ? new Response("not found", { status: 404 }) : answer();
  };
  return { seen, fetchImpl };
};

describe("describeTelegramVideo", () => {
  it.effect("posts the file and its length to /video/describe with the Uno key", () =>
    Effect.gen(function* () {
      const gateway = fakeGateway({
        "/video/describe": () => jsonResponse({ speech: "hi", visual: "a desk", duration_sec: 35 }),
      });
      const described = yield* describeTelegramVideo({
        baseUrl: "https://gw.test/v1",
        apiKey: "sk-uno",
        bytes: new Uint8Array([1]),
        fileName: "clip.mp4",
        mimeType: "video/mp4",
        durationSec: 35,
        fetchImpl: gateway.fetchImpl,
      });
      expect(described).toEqual({ speech: "hi", visual: "a desk" });
      expect(gateway.seen[0]?.url).toBe("https://gw.test/v1/video/describe");
      expect(gateway.seen[0]?.auth).toBe("Bearer sk-uno");
      expect(gateway.seen[0]?.form.get("duration_sec")).toBe("35");
      expect(gateway.seen[0]?.form.get("file")).toBeInstanceOf(Blob);
    }),
  );

  it.effect("marks an old gateway (404/405) as unsupported, other errors not", () =>
    Effect.gen(function* () {
      const ask = (status: number) =>
        Effect.flip(
          describeTelegramVideo({
            baseUrl: "https://gw.test/v1",
            apiKey: "sk-uno",
            bytes: new Uint8Array([1]),
            fileName: "clip.mp4",
            mimeType: "video/mp4",
            durationSec: 35,
            fetchImpl: async () => new Response("x", { status }),
          }),
        );
      expect((yield* ask(404)).unsupported).toBe(true);
      expect((yield* ask(405)).unsupported).toBe(true);
      expect((yield* ask(502)).unsupported).toBe(false);
    }),
  );
});

describe("mediaToText", () => {
  const convert = (
    descriptor: TelegramMediaDescriptor,
    fetchImpl: FetchLike,
    extra: { apiKey?: string; precomputedTranscript?: string | null } = {},
  ) =>
    mediaToText({
      descriptor,
      bytes: new Uint8Array([1, 2]),
      savedPath: `/s/${descriptor.fileName}`,
      baseUrl: "https://gw.test/v1",
      apiKey: extra.apiKey ?? "sk-uno",
      precomputedTranscript: extra.precomputedTranscript ?? null,
      fetchImpl,
    });

  it.effect("transcribes audio files too, labelled with name and length", () =>
    Effect.gen(function* () {
      const gateway = fakeGateway({
        "/audio/transcriptions": () => jsonResponse({ text: "lyrics" }),
      });
      const result = yield* convert(
        { ...voiceDescriptor, kind: "audio", fileName: "song.mp3", durationSec: 190 },
        gateway.fetchImpl,
      );
      expect(result?.text.startsWith('[audio "song.mp3", 3:10] lyrics')).toBe(true);
      expect(result?.thumbnailFileId).toBeNull();
    }),
  );

  it.effect("a gateway error still yields a turn: labelled, with the saved file", () =>
    Effect.gen(function* () {
      const gateway = fakeGateway({
        "/audio/transcriptions": () => new Response("boom", { status: 500 }),
      });
      const result = yield* convert({ ...voiceDescriptor, durationSec: 42 }, gateway.fetchImpl);
      expect(result?.text.split("\n")[0]).toBe("[voice, 0:42 — could not transcribe]");
      expect(result?.text).toContain("saved at /s/voice.ogg");
    }),
  );

  it.effect("reuses the transcript made for group gating (no second STT)", () =>
    Effect.gen(function* () {
      const gateway = fakeGateway({});
      const result = yield* convert(voiceDescriptor, gateway.fetchImpl, {
        precomputedTranscript: "Антоха, посмотри",
      });
      expect(result?.text.startsWith("[voice, 0:03] Антоха, посмотри")).toBe(true);
      expect(gateway.seen).toEqual([]);
    }),
  );

  it.effect("describes a video through /video/describe", () =>
    Effect.gen(function* () {
      const gateway = fakeGateway({
        "/video/describe": () =>
          jsonResponse({ speech: "see", visual: "a chart", duration_sec: 35 }),
      });
      const result = yield* convert(videoDescriptor, gateway.fetchImpl);
      expect(result).toEqual({
        text: "[video, 0:35]\nSpeech: see\nOn screen: a chart\n[Telegram video saved at /s/clip.mp4.]",
        thumbnailFileId: null,
      });
      expect(gateway.seen.map((call) => new URL(call.url).pathname)).toEqual([
        "/v1/video/describe",
      ]);
    }),
  );

  it.effect("old gateway without /video/describe: audio track transcribed + preview frame", () =>
    Effect.gen(function* () {
      const gateway = fakeGateway({
        "/video/describe": () => new Response("not found", { status: 404 }),
        "/audio/transcriptions": () => jsonResponse({ text: "spoken words" }),
      });
      const result = yield* convert(
        { ...videoDescriptor, kind: "video_note", durationSec: 12 },
        gateway.fetchImpl,
      );
      expect(result?.text.startsWith("[video message, 0:12]\nSpeech: spoken words\n")).toBe(true);
      expect(result?.text).not.toContain("On screen:");
      expect(result?.thumbnailFileId).toBe("thumb-1");
      expect(gateway.seen.map((call) => new URL(call.url).pathname)).toEqual([
        "/v1/video/describe",
        "/v1/audio/transcriptions",
      ]);
    }),
  );

  it.effect("a failing (not missing) /video/describe is a labelled failure, no fallback", () =>
    Effect.gen(function* () {
      const gateway = fakeGateway({
        "/video/describe": () => new Response("boom", { status: 502 }),
      });
      const result = yield* convert(videoDescriptor, gateway.fetchImpl);
      expect(result?.text.split("\n")[0]).toBe("[video, 0:35 — could not describe]");
      expect(gateway.seen).toHaveLength(1);
    }),
  );

  it.effect("no Uno key: nothing leaves the machine, the turn is labelled", () =>
    Effect.gen(function* () {
      const gateway = fakeGateway({});
      const voice = yield* convert(voiceDescriptor, gateway.fetchImpl, { apiKey: "" });
      const video = yield* convert(videoDescriptor, gateway.fetchImpl, { apiKey: "" });
      expect(voice?.text.split("\n")[0]).toBe("[voice, 0:03 — could not transcribe]");
      expect(video?.text.split("\n")[0]).toBe("[video, 0:35 — could not describe]");
      expect(gateway.seen).toEqual([]);
    }),
  );

  it.effect("leaves photos and documents to the saved-file note", () =>
    Effect.gen(function* () {
      const gateway = fakeGateway({});
      expect(
        yield* convert({ ...voiceDescriptor, kind: "document" }, gateway.fetchImpl),
      ).toBeNull();
    }),
  );
});
