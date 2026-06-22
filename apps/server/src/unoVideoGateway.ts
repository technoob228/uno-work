import {
  UNO_GATEWAY_BASE_URL,
  type UnoVideoCancelJobInput,
  UnoVideoCancelJobResult,
  type UnoVideoCompleteUploadInput,
  UnoVideoCompleteUploadResult,
  type UnoVideoCreateJobInput,
  UnoVideoCreateJobResult,
  type UnoVideoCreateUploadInput,
  UnoVideoCreateUploadResult,
  type UnoVideoDownloadArtifactInput,
  UnoVideoDownloadArtifactResult,
  type UnoVideoGetDigestInput,
  type UnoVideoGetJobInput,
  UnoVideoJobResult,
  UnoVideoRpcError,
  VideoContextPack,
  type VideoContextPackInput,
  VideoDigest,
} from "@t3tools/contracts";
import { Effect, Schema } from "effect";

import { ServerSettingsService } from "./serverSettings.ts";

const GATE_REQUEST_TIMEOUT_MS = 30_000;
const ARTIFACT_DOWNLOAD_TIMEOUT_MS = 60_000;

const videoApiUrl = (path: string): string =>
  `${UNO_GATEWAY_BASE_URL.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;

const getUnoApiKey = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings.pipe(
    Effect.mapError(
      () =>
        new UnoVideoRpcError({
          message: "Unable to read Uno video settings.",
        }),
    ),
  );
  const apiKey = settings.uno.apiKey.trim();
  if (apiKey.length === 0) {
    return yield* new UnoVideoRpcError({
      message: "Connect your Uno account before uploading video.",
    });
  }
  return apiKey;
});

function extractErrorMessage(status: number, body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["message", "error", "detail"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
    }
  }
  return fallback || `Uno video request failed with HTTP ${status}.`;
}

const readResponseBody = (response: Response) =>
  Effect.tryPromise({
    try: async () => {
      const text = await response.text();
      if (text.trim().length === 0) return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    },
    catch: (cause) =>
      new UnoVideoRpcError({
        message: cause instanceof Error ? cause.message : "Unable to read Uno video response.",
      }),
  });

function requestJsonWithApiKey<A>(
  path: string,
  options: {
    readonly method: "GET" | "POST";
    readonly body?: unknown;
    readonly decode: (body: unknown) => A;
    readonly timeoutMs?: number;
  },
  apiKey: string,
): Effect.Effect<A, UnoVideoRpcError> {
  return Effect.gen(function* () {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? GATE_REQUEST_TIMEOUT_MS,
    );

    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(videoApiUrl(path), {
          method: options.method,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        }),
      catch: (cause) =>
        new UnoVideoRpcError({
          message:
            cause instanceof Error && cause.name === "AbortError"
              ? "Uno video request timed out."
              : cause instanceof Error
                ? cause.message
                : "Uno video request failed.",
        }),
    }).pipe(Effect.ensuring(Effect.sync(() => clearTimeout(timeout))));

    const body = yield* readResponseBody(response);
    if (!response.ok) {
      return yield* new UnoVideoRpcError({
        message: extractErrorMessage(
          response.status,
          body,
          `Uno video request failed with HTTP ${response.status}.`,
        ),
        status: response.status,
      });
    }

    return yield* Effect.try({
      try: () => options.decode(body),
      catch: () =>
        new UnoVideoRpcError({
          message: "Uno video response was invalid.",
        }),
    });
  });
}

function requestJson<A>(
  path: string,
  options: {
    readonly method: "GET" | "POST";
    readonly body?: unknown;
    readonly decode: (body: unknown) => A;
    readonly timeoutMs?: number;
  },
): Effect.Effect<A, UnoVideoRpcError, ServerSettingsService> {
  return Effect.flatMap(getUnoApiKey, (apiKey) => requestJsonWithApiKey(path, options, apiKey));
}

export const createUnoVideoUpload = (input: UnoVideoCreateUploadInput) =>
  requestJson("/video/uploads", {
    method: "POST",
    body: input,
    decode: Schema.decodeUnknownSync(UnoVideoCreateUploadResult),
  });

export const completeUnoVideoUpload = (input: UnoVideoCompleteUploadInput) =>
  requestJson(`/video/uploads/${encodeURIComponent(input.uploadId)}/complete`, {
    method: "POST",
    body: { parts: input.parts, ...(input.sha256 !== undefined ? { sha256: input.sha256 } : {}) },
    decode: Schema.decodeUnknownSync(UnoVideoCompleteUploadResult),
  });

export const createUnoVideoJob = (input: UnoVideoCreateJobInput) =>
  requestJson("/video/jobs", {
    method: "POST",
    body: input,
    decode: Schema.decodeUnknownSync(UnoVideoCreateJobResult),
  });

export const getUnoVideoJob = (input: UnoVideoGetJobInput) =>
  requestJson(`/video/jobs/${encodeURIComponent(input.jobId)}`, {
    method: "GET",
    decode: Schema.decodeUnknownSync(UnoVideoJobResult),
  });

export const cancelUnoVideoJob = (input: UnoVideoCancelJobInput) =>
  requestJson(`/video/jobs/${encodeURIComponent(input.jobId)}/cancel`, {
    method: "POST",
    decode: Schema.decodeUnknownSync(UnoVideoCancelJobResult),
  });

export const getUnoVideoDigest = (input: UnoVideoGetDigestInput) =>
  requestJson(`/video/digests/${encodeURIComponent(input.digestId)}`, {
    method: "GET",
    decode: Schema.decodeUnknownSync(VideoDigest),
  });

export const getUnoVideoDigestWithApiKey = (apiKey: string, input: UnoVideoGetDigestInput) =>
  requestJsonWithApiKey(
    `/video/digests/${encodeURIComponent(input.digestId)}`,
    {
      method: "GET",
      decode: Schema.decodeUnknownSync(VideoDigest),
    },
    apiKey,
  );

export const packUnoVideoDigest = (input: VideoContextPackInput) =>
  requestJson(`/video/digests/${encodeURIComponent(input.digestId)}/pack`, {
    method: "POST",
    body: input,
    decode: Schema.decodeUnknownSync(VideoContextPack),
  });

export const packUnoVideoDigestWithApiKey = (apiKey: string, input: VideoContextPackInput) =>
  requestJsonWithApiKey(
    `/video/digests/${encodeURIComponent(input.digestId)}/pack`,
    {
      method: "POST",
      body: input,
      decode: Schema.decodeUnknownSync(VideoContextPack),
    },
    apiKey,
  );

export interface UnoVideoDownloadedArtifact {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

export function downloadUnoVideoArtifact(
  input: UnoVideoDownloadArtifactInput,
): Effect.Effect<UnoVideoDownloadedArtifact, UnoVideoRpcError, ServerSettingsService> {
  return Effect.flatMap(getUnoApiKey, (apiKey) =>
    downloadUnoVideoArtifactWithApiKey(apiKey, input),
  );
}

export function downloadUnoVideoArtifactWithApiKey(
  apiKey: string,
  input: UnoVideoDownloadArtifactInput,
): Effect.Effect<UnoVideoDownloadedArtifact, UnoVideoRpcError> {
  return Effect.gen(function* () {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ARTIFACT_DOWNLOAD_TIMEOUT_MS);
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(videoApiUrl(`/video/artifacts/${encodeURIComponent(input.artifactId)}/download`), {
          method: "GET",
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        }),
      catch: (cause) =>
        new UnoVideoRpcError({
          message:
            cause instanceof Error && cause.name === "AbortError"
              ? "Uno video artifact download timed out."
              : cause instanceof Error
                ? cause.message
                : "Uno video artifact download failed.",
        }),
    }).pipe(Effect.ensuring(Effect.sync(() => clearTimeout(timeout))));

    if (!response.ok) {
      return yield* new UnoVideoRpcError({
        message: `Uno video artifact download failed with HTTP ${response.status}.`,
        status: response.status,
      });
    }

    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    if (contentType.toLowerCase().includes("application/json")) {
      const body = yield* readResponseBody(response);
      const download = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(UnoVideoDownloadArtifactResult)(body),
        catch: () =>
          new UnoVideoRpcError({
            message: "Uno video artifact download response was invalid.",
          }),
      });
      return yield* downloadSignedArtifact(download.downloadUrl);
    }

    const buffer = yield* Effect.tryPromise({
      try: () => response.arrayBuffer(),
      catch: (cause) =>
        new UnoVideoRpcError({
          message: cause instanceof Error ? cause.message : "Unable to read video artifact.",
        }),
    });
    return {
      bytes: new Uint8Array(buffer),
      mimeType: contentType,
    };
  });
}

function downloadSignedArtifact(
  downloadUrl: string,
): Effect.Effect<UnoVideoDownloadedArtifact, UnoVideoRpcError> {
  return Effect.gen(function* () {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ARTIFACT_DOWNLOAD_TIMEOUT_MS);
    const response = yield* Effect.tryPromise({
      try: () => fetch(downloadUrl, { method: "GET", signal: controller.signal }),
      catch: (cause) =>
        new UnoVideoRpcError({
          message:
            cause instanceof Error && cause.name === "AbortError"
              ? "Uno video artifact download timed out."
              : cause instanceof Error
                ? cause.message
                : "Uno video artifact download failed.",
        }),
    }).pipe(Effect.ensuring(Effect.sync(() => clearTimeout(timeout))));

    if (!response.ok) {
      return yield* new UnoVideoRpcError({
        message: `Uno video artifact download failed with HTTP ${response.status}.`,
        status: response.status,
      });
    }
    const buffer = yield* Effect.tryPromise({
      try: () => response.arrayBuffer(),
      catch: (cause) =>
        new UnoVideoRpcError({
          message: cause instanceof Error ? cause.message : "Unable to read video artifact.",
        }),
    });
    return {
      bytes: new Uint8Array(buffer),
      mimeType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  });
}
