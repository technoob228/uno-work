import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import type { ChatAttachment } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendChatAttachmentsNote,
  buildChatAttachmentsNote,
  incomingUploadPath,
  moveIntoUploads,
  pruneStaleIncomingUploads,
  safeUploadFileName,
  saveBytesToUploads,
  uploadsMonthDir,
  uploadsMonthFolderName,
} from "./chatUploads.ts";

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "uno-chat-uploads-")));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const OCTOBER = new Date(2026, 9, 14, 12, 0, 0);

describe("uploads folder", () => {
  it("is one folder per month under Uploads", () => {
    expect(uploadsMonthFolderName(OCTOBER)).toBe("2026-10");
    expect(uploadsMonthFolderName(new Date(2027, 0, 2))).toBe("2027-01");
    expect(uploadsMonthDir("/home/me", OCTOBER)).toBe("/home/me/Uploads/2026-10");
  });

  it("stages incoming uploads in a hidden folder", () => {
    expect(incomingUploadPath("/home/me", "abc12345")).toBe("/home/me/Uploads/.incoming/abc12345");
  });
});

describe("safeUploadFileName", () => {
  it("keeps an ordinary name as it is", () => {
    expect(safeUploadFileName("Отчёт за май.pdf")).toBe("Отчёт за май.pdf");
    expect(safeUploadFileName("photo (1).png")).toBe("photo (1).png");
  });

  it("keeps only the last path segment", () => {
    expect(safeUploadFileName("../../etc/passwd")).toBe("passwd");
    expect(safeUploadFileName("C:\\Users\\me\\doc.docx")).toBe("doc.docx");
  });

  it("never makes a hidden or empty name", () => {
    expect(safeUploadFileName(".env")).toBe("env");
    expect(safeUploadFileName("...")).toBe("file");
    expect(safeUploadFileName("   ")).toBe("file");
    expect(safeUploadFileName("dir/")).toBe("file");
    expect(safeUploadFileName("", "image")).toBe("image");
  });

  it("drops control characters", () => {
    expect(safeUploadFileName("a\u0000b\nc.txt")).toBe("a b c.txt");
  });

  it("shortens a very long name but keeps the extension", () => {
    const name = `${"я".repeat(300)}.xlsx`;
    const safe = safeUploadFileName(name);
    expect(Buffer.byteLength(safe, "utf8")).toBeLessThanOrEqual(200);
    expect(safe.endsWith(".xlsx")).toBe(true);
  });
});

describe("saveBytesToUploads", () => {
  it("saves under the month folder and never overwrites", async () => {
    const first = await saveBytesToUploads({
      filesRoot: root,
      name: "image.png",
      bytes: new Uint8Array([1]),
      now: OCTOBER,
    });
    const second = await saveBytesToUploads({
      filesRoot: root,
      name: "image.png",
      bytes: new Uint8Array([2]),
      now: OCTOBER,
    });
    expect(first).toBe(nodePath.join(root, "Uploads", "2026-10", "image.png"));
    expect(second).toBe(nodePath.join(root, "Uploads", "2026-10", "image (2).png"));
    expect([...fs.readFileSync(first)]).toEqual([1]);
    expect([...fs.readFileSync(second)]).toEqual([2]);
  });
});

describe("moveIntoUploads", () => {
  it("moves a staged file next to existing ones without replacing them", async () => {
    const existing = await saveBytesToUploads({
      filesRoot: root,
      name: "report.pdf",
      bytes: new TextEncoder().encode("old"),
      now: OCTOBER,
    });
    const staged = incomingUploadPath(root, "upload-0001");
    fs.mkdirSync(nodePath.dirname(staged), { recursive: true });
    fs.writeFileSync(staged, "new");

    const moved = await moveIntoUploads({
      filesRoot: root,
      sourcePath: staged,
      name: "report.pdf",
      now: OCTOBER,
    });
    expect(moved).toBe(nodePath.join(root, "Uploads", "2026-10", "report (2).pdf"));
    expect(fs.readFileSync(moved, "utf8")).toBe("new");
    expect(fs.readFileSync(existing, "utf8")).toBe("old");
    expect(fs.existsSync(staged)).toBe(false);
  });
});

describe("pruneStaleIncomingUploads", () => {
  it("drops only staged files older than the limit", async () => {
    const fresh = incomingUploadPath(root, "fresh-0001");
    const stale = incomingUploadPath(root, "stale-0001");
    fs.mkdirSync(nodePath.dirname(fresh), { recursive: true });
    fs.writeFileSync(fresh, "a");
    fs.writeFileSync(stale, "b");
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);

    expect(await pruneStaleIncomingUploads(root)).toBe(1);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
  });

  it("is quiet when there is nothing staged", async () => {
    expect(await pruneStaleIncomingUploads(root)).toBe(0);
  });
});

describe("buildChatAttachmentsNote", () => {
  const file: ChatAttachment = {
    type: "file",
    id: "thread-1-a",
    name: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 10,
    path: "/home/me/Uploads/2026-10/report.pdf",
  };
  const savedImage: ChatAttachment = {
    type: "image",
    id: "thread-1-b",
    name: 'my "best" photo.png',
    mimeType: "image/png",
    sizeBytes: 10,
    savedPath: "/home/me/Uploads/2026-10/photo.png",
  };
  const connectorImage: ChatAttachment = {
    type: "image",
    id: "thread-1-c",
    name: "telegram.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 10,
  };

  it("tells the model where each file and picture is", () => {
    expect(buildChatAttachmentsNote([file, savedImage])).toBe(
      [
        '[Attached file "report.pdf" saved at /home/me/Uploads/2026-10/report.pdf — open it from there whenever you need it again.]',
        "[Attached image \"my 'best' photo.png\" saved at /home/me/Uploads/2026-10/photo.png — open it from there whenever you need it again.]",
      ].join("\n"),
    );
  });

  it("falls back to the internal copy for pictures without a saved one", () => {
    expect(
      buildChatAttachmentsNote([connectorImage], {
        storedImagePath: (id) => `/data/attachments/${id}.jpg`,
      }),
    ).toBe('[Attached image "telegram.jpg" is also on disk at /data/attachments/thread-1-c.jpg.]');
    expect(buildChatAttachmentsNote([connectorImage])).toBeNull();
  });

  it("is null when there is nothing to say", () => {
    expect(buildChatAttachmentsNote([])).toBeNull();
  });

  it("goes after the message text", () => {
    expect(appendChatAttachmentsNote("summarize", "[note]")).toBe("summarize\n\n[note]");
    expect(appendChatAttachmentsNote("", "[note]")).toBe("[note]");
    expect(appendChatAttachmentsNote("hi", null)).toBe("hi");
  });
});
