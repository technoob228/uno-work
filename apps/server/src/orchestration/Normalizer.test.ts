/**
 * A message with any kind of file (pdf, docx, zip, a script…): each one lands
 * in ~/Uploads/YYYY-MM as a plain, non-executable file, and the model only
 * hears where it is — never gets its bytes as a picture.
 */
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ThreadId,
  type ChatAttachment,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ServerConfig } from "../config.ts";
import {
  buildChatAttachmentsNote,
  incomingUploadPath,
  uploadsMonthFolderName,
} from "../files/chatUploads.ts";
import { FILES_ROOT_ENV } from "../files/filesPaths.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";

let home: string;
const savedEnv = { HOME: process.env.HOME, [FILES_ROOT_ENV]: process.env[FILES_ROOT_ENV] };

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "uno-normalizer-")));
  process.env.HOME = home;
  process.env[FILES_ROOT_ENV] = home;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

function stage(uploadId: string, contents: string, mode = 0o644) {
  const staged = incomingUploadPath(home, uploadId);
  fs.mkdirSync(nodePath.dirname(staged), { recursive: true });
  fs.writeFileSync(staged, contents);
  fs.chmodSync(staged, mode);
}

function turnStart(
  attachments: ReadonlyArray<{ uploadId: string; name: string; mimeType: string; size: number }>,
): ClientOrchestrationCommand {
  return {
    type: "thread.turn.start",
    commandId: CommandId.make("cmd-files"),
    threadId: ThreadId.make("thread-files"),
    message: {
      messageId: MessageId.make("message-files"),
      role: "user",
      text: "look at these",
      attachments: attachments.map((attachment) => ({
        type: "file" as const,
        uploadId: attachment.uploadId,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.size,
      })),
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  } as ClientOrchestrationCommand;
}

function normalize(command: ClientOrchestrationCommand) {
  const layer = Layer.mergeAll(
    WorkspacePathsLive,
    ServerConfig.layerTest(home, nodePath.join(home, ".t3")),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  return Effect.runPromise(normalizeDispatchCommand(command).pipe(Effect.provide(layer)));
}

describe("normalizeDispatchCommand: attached files", () => {
  it("files every kind into ~/Uploads/YYYY-MM as 0644 and tells the model the paths", async () => {
    const files = [
      { uploadId: "upload-pdf-0001", name: "Report.pdf", mimeType: "application/pdf" },
      {
        uploadId: "upload-docx-0001",
        name: "Contract.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      { uploadId: "upload-zip-0001", name: "site.zip", mimeType: "application/zip" },
      { uploadId: "upload-py-00001", name: "script.py", mimeType: "text/x-python" },
      // An installer/script with the exec bit: kept, but never executable.
      { uploadId: "upload-sh-00001", name: "install.sh", mimeType: "" },
      // Path tricks and a hidden name: only the last segment, never hidden.
      { uploadId: "upload-evil-001", name: "../../.bashrc", mimeType: "text/plain" },
    ];
    for (const file of files) {
      stage(file.uploadId, `bytes of ${file.name}`, file.name.endsWith(".sh") ? 0o755 : 0o644);
    }
    // A taken name gets " (2)".
    const month = nodePath.join(home, "Uploads", uploadsMonthFolderName(new Date()));
    fs.mkdirSync(month, { recursive: true });
    fs.writeFileSync(nodePath.join(month, "Report.pdf"), "older");

    const normalized = await normalize(
      turnStart(files.map((file) => ({ ...file, size: `bytes of ${file.name}`.length }))),
    );
    if (normalized.type !== "thread.turn.start") throw new Error("unexpected command");
    const attachments = normalized.message.attachments as ReadonlyArray<ChatAttachment>;

    expect(attachments.map((attachment) => attachment.type)).toEqual(files.map(() => "file"));
    const paths = attachments.map((attachment) =>
      attachment.type === "file" ? attachment.path : null,
    );
    expect(paths).toEqual([
      nodePath.join(month, "Report (2).pdf"),
      nodePath.join(month, "Contract.docx"),
      nodePath.join(month, "site.zip"),
      nodePath.join(month, "script.py"),
      nodePath.join(month, "install.sh"),
      nodePath.join(month, "bashrc"),
    ]);
    for (const [index, path] of paths.entries()) {
      expect(fs.readFileSync(path!, "utf8")).toBe(`bytes of ${files[index]!.name}`);
      expect(fs.statSync(path!).mode & 0o777).toBe(0o644);
    }
    // Nothing escaped the month folder, the older file is untouched.
    expect(fs.readFileSync(nodePath.join(month, "Report.pdf"), "utf8")).toBe("older");
    expect(fs.existsSync(nodePath.join(home, ".bashrc"))).toBe(false);
    // An unknown type is still a file.
    expect(attachments[4]).toMatchObject({ mimeType: "application/octet-stream" });
    // The staged copies are gone.
    for (const file of files) {
      expect(fs.existsSync(incomingUploadPath(home, file.uploadId))).toBe(false);
    }
    // What the model gets: a path per file, no picture.
    const note = buildChatAttachmentsNote(attachments);
    expect(note).toContain(
      `[Attached file "site.zip" saved at ${nodePath.join(month, "site.zip")}`,
    );
    expect(note?.split("\n")).toHaveLength(files.length);
  });

  it("refuses a file that never finished uploading", async () => {
    await expect(
      normalize(
        turnStart([
          {
            uploadId: "upload-missing-1",
            name: "gone.pdf",
            mimeType: "application/pdf",
            size: 1,
          },
        ]),
      ),
    ).rejects.toThrow(/didn't finish uploading/);
  });
});
