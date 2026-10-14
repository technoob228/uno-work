import fsPromises from "node:fs/promises";
import * as OS from "node:os";

import { Effect, FileSystem, Path } from "effect";
import {
  type ChatAttachment,
  type ChatFileAttachment,
  type ChatImageAttachment,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type UploadChatFileAttachment,
  type UploadChatImageAttachment,
  type UploadChatVideoDigestAttachment,
  type VideoDigest,
  type VideoContextPackArtifact,
} from "@t3tools/contracts";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import {
  incomingUploadPath,
  moveIntoUploads,
  pruneStaleIncomingUploads,
  saveBytesToUploads,
} from "../files/chatUploads.ts";
import { configuredFilesRoot } from "../files/filesPaths.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import {
  downloadUnoVideoArtifactWithApiKey,
  getUnoVideoDigestWithApiKey,
  packUnoVideoDigestWithApiKey,
} from "../unoVideoGateway.ts";
import { WorkspacePaths } from "../workspace/Services/WorkspacePaths.ts";

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function sanitizeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildVideoContextBlock(input: {
  readonly attachment: UploadChatVideoDigestAttachment;
  readonly digest: VideoDigest;
  readonly promptText: string;
}): string {
  return [
    `<video_context name="${sanitizeXmlAttribute(input.attachment.name)}" digest_id="${sanitizeXmlAttribute(
      input.attachment.digestId,
    )}" job_id="${sanitizeXmlAttribute(input.attachment.jobId)}" duration="${formatDuration(
      input.digest.source.durationMs,
    )}">`,
    input.promptText.trim(),
    "</video_context>",
  ].join("\n");
}

export const normalizeDispatchCommand = (
  command: ClientOrchestrationCommand,
  options?: { readonly unoApiKey?: string | null | undefined },
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const workspacePaths = yield* WorkspacePaths;

    const normalizeProjectWorkspaceRoot = (workspaceRoot: string) =>
      workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );

    const normalizeProjectWorkspaceRootForCreate = (
      workspaceRoot: string,
      createIfMissing: boolean | undefined,
    ) =>
      workspacePaths
        .normalizeWorkspaceRoot(workspaceRoot, {
          createIfMissing: createIfMissing === true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: cause.message,
              }),
          ),
        );

    if (command.type === "project.create") {
      return {
        ...command,
        workspaceRoot: yield* normalizeProjectWorkspaceRootForCreate(
          command.workspaceRoot,
          command.createWorkspaceRootIfMissing,
        ),
        createWorkspaceRootIfMissing: command.createWorkspaceRootIfMissing === true,
      } satisfies OrchestrationCommand;
    }

    if (command.type === "project.meta.update" && command.workspaceRoot !== undefined) {
      return {
        ...command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(command.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (command.type !== "thread.turn.start") {
      return command as OrchestrationCommand;
    }

    const persistImageAttachment = (input: {
      readonly name: string;
      readonly mimeType: string;
      readonly bytes: Uint8Array;
    }) =>
      Effect.gen(function* () {
        if (
          !input.mimeType.toLowerCase().startsWith("image/") ||
          input.bytes.byteLength === 0 ||
          input.bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
        ) {
          return yield* new OrchestrationDispatchCommandError({
            message: `Image attachment '${input.name}' is empty, invalid, or too large.`,
          });
        }

        const attachmentId = createAttachmentId(command.threadId);
        if (!attachmentId) {
          return yield* new OrchestrationDispatchCommandError({
            message: "Failed to create a safe attachment id.",
          });
        }

        const persistedAttachment = {
          type: "image" as const,
          id: attachmentId,
          name: input.name,
          mimeType: input.mimeType.toLowerCase(),
          sizeBytes: input.bytes.byteLength,
        } satisfies ChatImageAttachment;

        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment: persistedAttachment,
        });
        if (!attachmentPath) {
          return yield* new OrchestrationDispatchCommandError({
            message: `Failed to resolve persisted path for '${input.name}'.`,
          });
        }

        yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
          Effect.mapError(
            () =>
              new OrchestrationDispatchCommandError({
                message: `Failed to create attachment directory for '${input.name}'.`,
              }),
          ),
        );
        yield* fileSystem.writeFile(attachmentPath, input.bytes).pipe(
          Effect.mapError(
            () =>
              new OrchestrationDispatchCommandError({
                message: `Failed to persist attachment '${input.name}'.`,
              }),
          ),
        );

        return persistedAttachment;
      });

    const persistUploadImageAttachment = (attachment: UploadChatImageAttachment) =>
      Effect.gen(function* () {
        const parsed = parseBase64DataUrl(attachment.dataUrl);
        if (!parsed || !parsed.mimeType.startsWith("image/")) {
          return yield* new OrchestrationDispatchCommandError({
            message: `Invalid image attachment payload for '${attachment.name}'.`,
          });
        }
        const bytes = Buffer.from(parsed.base64, "base64");
        const persisted = yield* persistImageAttachment({
          name: attachment.name,
          mimeType: parsed.mimeType,
          bytes,
        });
        // The person's own copy in ~/Uploads/YYYY-MM (visible in Files); the
        // turn tells the model this path. A full or read-only home must not
        // block the message: the picture still reaches the model inline.
        const savedPath = yield* Effect.tryPromise(() =>
          saveBytesToUploads({ filesRoot: configuredFilesRoot(), name: attachment.name, bytes }),
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("chat image attachment was not saved to Uploads", {
              name: attachment.name,
              cause: String(cause),
            }).pipe(Effect.as(null)),
          ),
        );
        return savedPath === null ? persisted : { ...persisted, savedPath };
      });

    // A non-image file: the composer already staged its bytes in
    // ~/Uploads/.incoming/<uploadId>; it moves to ~/Uploads/YYYY-MM/<name>.
    const persistUploadFileAttachment = (attachment: UploadChatFileAttachment) =>
      Effect.gen(function* () {
        const homeDir = OS.homedir();
        const stagedPath = incomingUploadPath(homeDir, attachment.uploadId);
        const notUploaded = new OrchestrationDispatchCommandError({
          message: `'${attachment.name}' didn't finish uploading. Attach it again.`,
        });
        const stat = yield* Effect.tryPromise(() => fsPromises.lstat(stagedPath)).pipe(
          Effect.mapError(() => notUploaded),
        );
        if (!stat.isFile()) {
          return yield* notUploaded;
        }
        if (stat.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
          return yield* new OrchestrationDispatchCommandError({
            message: `'${attachment.name}' is too large to attach.`,
          });
        }
        const attachmentId = createAttachmentId(command.threadId);
        if (!attachmentId) {
          return yield* new OrchestrationDispatchCommandError({
            message: "Failed to create a safe attachment id.",
          });
        }
        const savedPath = yield* Effect.tryPromise(() =>
          moveIntoUploads({
            filesRoot: configuredFilesRoot(),
            sourcePath: stagedPath,
            name: attachment.name,
          }),
        ).pipe(
          Effect.mapError(
            () =>
              new OrchestrationDispatchCommandError({
                message: `Couldn't save '${attachment.name}' to Uploads.`,
              }),
          ),
        );
        yield* Effect.promise(() => pruneStaleIncomingUploads(homeDir));
        const mimeType = attachment.mimeType.trim();
        return {
          type: "file" as const,
          id: attachmentId,
          name: attachment.name,
          mimeType: mimeType.length > 0 ? mimeType : "application/octet-stream",
          sizeBytes: stat.size,
          path: savedPath,
        } satisfies ChatFileAttachment;
      });

    const normalizedAttachments: ChatAttachment[] = [];
    const videoContextBlocks: string[] = [];

    for (const attachment of command.message.attachments) {
      if (attachment.type === "image") {
        normalizedAttachments.push(yield* persistUploadImageAttachment(attachment));
        continue;
      }
      if (attachment.type === "file") {
        normalizedAttachments.push(yield* persistUploadFileAttachment(attachment));
        continue;
      }

      const unoApiKey = options?.unoApiKey?.trim() ?? "";
      if (unoApiKey.length === 0) {
        return yield* new OrchestrationDispatchCommandError({
          message: "Connect your Uno account before sending video attachments.",
        });
      }

      const digest = yield* getUnoVideoDigestWithApiKey(unoApiKey, {
        digestId: attachment.digestId,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );
      const remainingImageSlots = Math.max(
        0,
        PROVIDER_SEND_TURN_MAX_ATTACHMENTS - normalizedAttachments.length - 1,
      );
      const pack = yield* packUnoVideoDigestWithApiKey(unoApiKey, {
        digestId: attachment.digestId,
        target: {
          providerKind: command.modelSelection?.instanceId ?? "unknown",
          modelId: command.modelSelection?.model ?? "unknown",
          supportsVision: remainingImageSlots > 0,
          maxInputChars: PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
          maxImages: remainingImageSlots,
        },
        userPrompt: command.message.text,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );

      const videoAttachmentId = createAttachmentId(command.threadId);
      if (!videoAttachmentId) {
        return yield* new OrchestrationDispatchCommandError({
          message: "Failed to create a safe video attachment id.",
        });
      }
      normalizedAttachments.push({
        type: "video_digest" as const,
        id: videoAttachmentId,
        name: attachment.name,
        sourceMimeType: digest.source.mimeType,
        sourceSizeBytes: digest.source.sizeBytes,
        durationMs: digest.source.durationMs,
        digestId: attachment.digestId,
        jobId: attachment.jobId,
        frameCount: digest.frames.length,
        transcriptSegmentCount: digest.transcript.segments.length,
      });
      videoContextBlocks.push(
        buildVideoContextBlock({
          attachment,
          digest,
          promptText: pack.promptText,
        }),
      );

      const selectedArtifacts = pack.artifacts.slice(0, remainingImageSlots);
      for (const artifact of selectedArtifacts) {
        const image = yield* materializeVideoArtifact(artifact, attachment.name);
        normalizedAttachments.push(image);
      }
    }

    function materializeVideoArtifact(artifact: VideoContextPackArtifact, videoName: string) {
      return Effect.gen(function* () {
        const unoApiKey = options?.unoApiKey?.trim() ?? "";
        if (unoApiKey.length === 0) {
          return yield* new OrchestrationDispatchCommandError({
            message: "Connect your Uno account before sending video attachments.",
          });
        }
        const downloaded = yield* downloadUnoVideoArtifactWithApiKey(unoApiKey, {
          artifactId: artifact.artifactId,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: cause.message,
              }),
          ),
        );
        return yield* persistImageAttachment({
          name: `${videoName} ${artifact.role} ${formatDuration(artifact.timestampMs)}`,
          mimeType: artifact.mimeType || downloaded.mimeType,
          bytes: downloaded.bytes,
        });
      });
    }

    const expandedText =
      videoContextBlocks.length > 0
        ? [command.message.text, ...videoContextBlocks]
            .filter((part) => part.length > 0)
            .join("\n\n")
        : command.message.text;

    return {
      ...command,
      message: {
        ...command.message,
        text: expandedText,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });
