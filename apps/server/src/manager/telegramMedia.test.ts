import { describe, expect, it } from "@effect/vitest";

import {
  collectTelegramMedia,
  describeNonFileContent,
  extractOutgoingFiles,
  isImageLikeMedia,
  pickTelegramUploadMethod,
  sanitizeFileName,
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
    expect(collectTelegramMedia({ sticker: { file_id: "s1" } })[0]?.fileName).toBe(
      "sticker.webp",
    );
    expect(
      collectTelegramMedia({ sticker: { file_id: "s2", is_animated: true } })[0]?.fileName,
    ).toBe("sticker.tgs");
    expect(
      collectTelegramMedia({ sticker: { file_id: "s3", is_video: true } })[0]?.fileName,
    ).toBe("sticker.webm");
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
