import { describe, expect, it } from "@effect/vitest";

import { DEFAULT_ADDRESSING_CONFIG, decideAddressing } from "./addressing.ts";
import {
  collectTelegramMedia,
  describeNonFileContent,
  extractOutgoingFiles,
  isImageLikeMedia,
  pickTelegramUploadMethod,
  sanitizeFileName,
  telegramIsDirectMessage,
  telegramMentionsBot,
  telegramRepliesToBot,
  telegramSenderIsBot,
  toNormalizedMessage,
} from "./telegramMedia.ts";

describe("collectTelegramMedia", () => {
  it("picks the largest photo size", () => {
    const media = collectTelegramMedia({
      photo: [
        { file_id: "small", width: 90, file_size: 1_000 },
        { file_id: "large", width: 1280, file_size: 100_000 },
        { file_id: "medium", width: 320, file_size: 20_000 },
      ],
    });
    expect(media).toEqual([
      {
        kind: "photo",
        fileId: "large",
        fileName: "photo.jpg",
        mimeType: "image/jpeg",
        durationSec: null,
        sizeBytes: 100_000,
      },
    ]);
  });

  it("maps voice and video notes with duration", () => {
    const media = collectTelegramMedia({
      voice: { file_id: "v1", duration: 12, mime_type: "audio/ogg", file_size: 34_567 },
      video_note: { file_id: "n1", duration: 7, file_size: 200_000 },
    });
    expect(media.map((entry) => [entry.kind, entry.fileId, entry.durationSec])).toEqual([
      ["voice", "v1", 12],
      ["video_note", "n1", 7],
    ]);
  });

  it("keeps document file names but sanitizes path tricks", () => {
    const media = collectTelegramMedia({
      document: {
        file_id: "d1",
        file_name: "../../etc/passwd",
        mime_type: "text/plain",
      },
    });
    expect(media[0]?.fileName).not.toContain("/");
    expect(media[0]?.fileName).not.toMatch(/^\./);
  });

  it("distinguishes static, animated, and video stickers", () => {
    expect(collectTelegramMedia({ sticker: { file_id: "s1" } })[0]?.fileName).toBe("sticker.webp");
    expect(
      collectTelegramMedia({ sticker: { file_id: "s2", is_animated: true } })[0]?.fileName,
    ).toBe("sticker.tgs");
    expect(collectTelegramMedia({ sticker: { file_id: "s3", is_video: true } })[0]?.fileName).toBe(
      "sticker.webm",
    );
  });

  it("returns nothing for a plain text message", () => {
    expect(collectTelegramMedia({ text: "hello" })).toEqual([]);
  });
});

describe("isImageLikeMedia", () => {
  it("routes photos, image documents, and static stickers to the image pipeline", () => {
    const [photo] = collectTelegramMedia({ photo: [{ file_id: "p", width: 100 }] });
    const [imageDoc] = collectTelegramMedia({
      document: { file_id: "d", file_name: "scan.png", mime_type: "image/png" },
    });
    const [sticker] = collectTelegramMedia({ sticker: { file_id: "s" } });
    const [voice] = collectTelegramMedia({ voice: { file_id: "v" } });
    expect(photo && isImageLikeMedia(photo)).toBe(true);
    expect(imageDoc && isImageLikeMedia(imageDoc)).toBe(true);
    expect(sticker && isImageLikeMedia(sticker)).toBe(true);
    expect(voice && isImageLikeMedia(voice)).toBe(false);
  });
});

describe("describeNonFileContent", () => {
  it("renders location and contact as text lines", () => {
    const lines = describeNonFileContent({
      location: { latitude: 52.52, longitude: 13.405 },
      contact: { phone_number: "+491234", first_name: "Max", last_name: "Mustermann" },
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("52.52");
    expect(lines[1]).toContain("Max Mustermann");
  });
});

describe("extractOutgoingFiles", () => {
  it("collects marker paths in order, deduplicated, and cleans the text", () => {
    const { text, files } = extractOutgoingFiles(
      [
        "Готово, вот отчёт:",
        "",
        "[[send-file: /tmp/report.pdf]]",
        "[[ send-file : /tmp/chart.png ]]",
        "[[send-file: /tmp/report.pdf]]",
        "",
        "Что-нибудь ещё?",
      ].join("\n"),
    );
    expect(files).toEqual(["/tmp/report.pdf", "/tmp/chart.png"]);
    expect(text).toBe("Готово, вот отчёт:\n\nЧто-нибудь ещё?");
  });

  it("leaves marker-free text untouched", () => {
    expect(extractOutgoingFiles("plain reply")).toEqual({
      text: "plain reply",
      files: [],
    });
  });
});

describe("pickTelegramUploadMethod", () => {
  it("uploads photos via sendPhoto and everything else as documents", () => {
    expect(pickTelegramUploadMethod("chart.png").method).toBe("sendPhoto");
    expect(pickTelegramUploadMethod("photo.JPG").method).toBe("sendPhoto");
    expect(pickTelegramUploadMethod("report.pdf").method).toBe("sendDocument");
    expect(pickTelegramUploadMethod("diagram.svg").method).toBe("sendDocument");
    expect(pickTelegramUploadMethod("noextension").method).toBe("sendDocument");
  });
});

describe("sanitizeFileName", () => {
  it("falls back when the name is empty after cleaning", () => {
    expect(sanitizeFileName("///", "fallback.bin")).toBe("fallback.bin");
    expect(sanitizeFileName("", "fallback.bin")).toBe("fallback.bin");
  });
});

describe("telegram addressing signals", () => {
  it("recognizes a private chat as a direct message", () => {
    expect(telegramIsDirectMessage({ chat: { id: 1, type: "private" } })).toBe(true);
    expect(telegramIsDirectMessage({ chat: { id: -1, type: "supergroup" } })).toBe(false);
  });

  it("flags messages sent by other bots", () => {
    expect(telegramSenderIsBot({ from: { id: 7, is_bot: true } })).toBe(true);
    expect(telegramSenderIsBot({ from: { id: 7, is_bot: false } })).toBe(false);
    expect(telegramSenderIsBot({})).toBe(false);
  });

  it("detects an @mention via entities", () => {
    const message = {
      text: "эй @MyBot глянь",
      entities: [{ type: "mention", offset: 4, length: 6 }],
    };
    expect(telegramMentionsBot(message, "mybot")).toBe(true);
    expect(telegramMentionsBot(message, "otherbot")).toBe(false);
  });

  it("detects a /command@bot and a caption mention", () => {
    expect(
      telegramMentionsBot(
        { text: "/status@MyBot", entities: [{ type: "bot_command", offset: 0, length: 13 }] },
        "mybot",
      ),
    ).toBe(true);
    expect(
      telegramMentionsBot(
        { caption: "смотри @MyBot", caption_entities: [{ type: "mention", offset: 7, length: 6 }] },
        "mybot",
      ),
    ).toBe(true);
  });

  it("does not treat @mybot2 as a mention of @mybot (word boundary)", () => {
    expect(telegramMentionsBot({ text: "пинг @mybot2" }, "mybot")).toBe(false);
    expect(telegramMentionsBot({ text: "пинг @mybot!" }, "mybot")).toBe(true);
  });

  it("detects a reply to the bot's own message", () => {
    expect(
      telegramRepliesToBot(
        { reply_to_message: { from: { username: "MyBot", is_bot: true } } },
        "mybot",
      ),
    ).toBe(true);
    expect(
      telegramRepliesToBot({ reply_to_message: { from: { username: "someone" } } }, "mybot"),
    ).toBe(false);
    expect(telegramRepliesToBot({}, "mybot")).toBe(false);
  });

  it("keeps a caption-less private voice message addressed through the gate (voice regression)", () => {
    // A voice message carries no text — the addressing gate must still let a
    // private (1:1) chat through, or transcription would never run for it.
    const voiceInDm = {
      chat: { id: 42, type: "private" as const },
      from: { id: 42, is_bot: false },
      voice: { file_id: "v", duration: 5 },
    };
    const normalized = toNormalizedMessage({ message: voiceInDm, botUsername: "mybot", text: "" });
    expect(normalized.isDirectMessage).toBe(true);
    expect(decideAddressing(normalized, DEFAULT_ADDRESSING_CONFIG)).toEqual({
      addressed: true,
      reason: "direct",
    });
  });

  it("gates the same voice message in a group without a name/mention", () => {
    const voiceInGroup = {
      chat: { id: -100, type: "supergroup" as const },
      from: { id: 7, is_bot: false },
      voice: { file_id: "v", duration: 5 },
    };
    const normalized = toNormalizedMessage({
      message: voiceInGroup,
      botUsername: "mybot",
      text: "",
    });
    expect(decideAddressing(normalized, DEFAULT_ADDRESSING_CONFIG)).toEqual({
      addressed: false,
      needsSmartCheck: false,
    });
  });

  it("normalizes a group message and disables mention/reply when the bot username is unknown", () => {
    const message = {
      chat: { id: -100, type: "supergroup" as const },
      from: { id: 5, is_bot: false },
      text: "@MyBot привет",
      entities: [{ type: "mention", offset: 0, length: 6 }],
    };
    expect(toNormalizedMessage({ message, botUsername: "mybot", text: "@MyBot привет" })).toEqual({
      isDirectMessage: false,
      isReplyToBot: false,
      explicitMention: true,
      senderIsBot: false,
      text: "@MyBot привет",
    });
    expect(
      toNormalizedMessage({ message, botUsername: null, text: "@MyBot привет" }).explicitMention,
    ).toBe(false);
  });
});
