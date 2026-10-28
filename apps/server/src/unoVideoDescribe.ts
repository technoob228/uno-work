/**
 * unoVideoDescribe — Loom Work (28.10): a screen recording made in Work is
 * "watched" by the Uno Gateway's `POST /video/describe` (one multimodal call:
 * a verbatim transcript of the speech + what was on screen).
 *
 * The browser stages a small "agent copy" of the recording on this computer
 * (the same chunked `projects.writeFile` path as chat uploads) and names it
 * here; the daemon reads it from disk and posts it with the account key, so
 * the key never reaches the browser and no 20 MB frame crosses the socket.
 */
import fsPromises from "node:fs/promises";
import nodePath from "node:path";

import {
  UNO_DESCRIBE_VIDEO_MAX_BYTES,
  UNO_DESCRIBE_VIDEO_LONG_MAX_SECONDS,
  UNO_DESCRIBE_VIDEO_MAX_SECONDS,
  type UnoDescribeVideoDrivePart,
  UNO_GATEWAY_BASE_URL,
  type UnoDescribeVideoInput,
  type UnoDescribeVideoResult,
  UnoDescribeVideoError,
} from "@t3tools/contracts";
import { Effect } from "effect";

import { configuredFilesRoot, resolveFilesRoot, resolveInsideRoot } from "./files/filesPaths.ts";
import { readGatewayErrorMessage } from "./manager/telegramTranscription.ts";
import { ServerSettingsService } from "./serverSettings.ts";

export type DescribeFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** `{"speech","visual"}` of `/video/describe`; null when it says nothing at all. */
export function parseDescribeResponse(body: unknown): UnoDescribeVideoResult | null {
  if (typeof body !== "object" || body === null) return null;
  const read = (key: string) => {
    const value = (body as Record<string, unknown>)[key];
    return typeof value === "string" ? value.trim() : "";
  };
  const speech = read("speech");
  const visual = read("visual");
  return speech.length === 0 && visual.length === 0 ? null : { speech, visual };
}

/** `~/x` or an absolute path → an absolute path inside the home (or a typed error). */
export async function resolveRecordingPath(root: string, path: string): Promise<string> {
  const candidate = path.startsWith("~/") ? nodePath.join(root, path.slice(2)) : path;
  return resolveInsideRoot(root, candidate);
}

/** The gateway call itself (pure enough for tests: bytes in, text out). */
export async function postDescribe(input: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mimeType: string;
  readonly durationSec: number;
  readonly fetchImpl?: DescribeFetch;
}): Promise<UnoDescribeVideoResult> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }),
    input.fileName,
  );
  form.append("duration_sec", String(Math.max(1, Math.round(input.durationSec))));
  const response = await (input.fetchImpl ?? fetch)(
    `${input.baseUrl.replace(/\/$/, "")}/video/describe`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${input.apiKey}` },
      body: form,
    },
  );
  if (!response.ok) {
    const errorBody: unknown = await response.json().catch(() => null);
    const said = readGatewayErrorMessage(errorBody);
    throw new UnoDescribeVideoError({
      message:
        said ??
        (response.status === 404 || response.status === 405
          ? "Your Uno account can't watch videos yet."
          : `Watching the recording failed (HTTP ${response.status}).`),
      reason: response.status === 404 || response.status === 405 ? "unsupported" : "gateway",
    });
  }
  const parsed = parseDescribeResponse(await response.json().catch(() => null));
  if (!parsed) {
    throw new UnoDescribeVideoError({
      message: "The recording came back without any speech or picture.",
      reason: "gateway",
    });
  }
  return parsed;
}

/** The gateway reads the parts of a long recording from Uno Drive and glues them. */
export async function postDescribeDrive(input: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly parts: ReadonlyArray<UnoDescribeVideoDrivePart>;
  readonly fetchImpl?: DescribeFetch;
}): Promise<UnoDescribeVideoResult> {
  const response = await (input.fetchImpl ?? fetch)(
    `${input.baseUrl.replace(/\/$/, "")}/video/describe/drive`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        parts: input.parts.map((part) => ({
          key: part.key,
          duration_sec: Math.max(1, Math.round(part.durationSec)),
        })),
      }),
    },
  );
  if (!response.ok) {
    const errorBody: unknown = await response.json().catch(() => null);
    const said = readGatewayErrorMessage(errorBody);
    // An older console has no long describe: the route is unknown there.
    const unsupported = response.status === 405 || (response.status === 404 && said === null);
    throw new UnoDescribeVideoError({
      message:
        said ??
        (unsupported
          ? "Your Uno account can't watch recordings longer than 10 minutes yet."
          : `Watching the recording failed (HTTP ${response.status}).`),
      reason: unsupported ? "unsupported" : "gateway",
    });
  }
  const parsed = parseDescribeResponse(await response.json().catch(() => null));
  if (!parsed) {
    throw new UnoDescribeVideoError({
      message: "The recording came back without any speech or picture.",
      reason: "gateway",
    });
  }
  return parsed;
}

export const describeUnoVideo = (
  input: UnoDescribeVideoInput,
  options: { readonly fetchImpl?: DescribeFetch; readonly root?: string } = {},
): Effect.Effect<UnoDescribeVideoResult, UnoDescribeVideoError, ServerSettingsService> =>
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        () =>
          new UnoDescribeVideoError({
            message: "Unable to read Uno settings.",
            reason: "missing-api-key",
          }),
      ),
    );
    const apiKey = settings.uno.apiKey.trim();
    if (apiKey.length === 0) {
      return yield* new UnoDescribeVideoError({
        message: "Connect your Uno account (Settings → Uno API key) so the agent can watch it.",
        reason: "missing-api-key",
      });
    }
    const gatewayError = (cause: unknown) =>
      cause instanceof UnoDescribeVideoError
        ? cause
        : new UnoDescribeVideoError({
            message: `Watching the recording failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            reason: "gateway",
          });
    if (input.driveParts && input.driveParts.length > 0) {
      if (input.durationSec > UNO_DESCRIBE_VIDEO_LONG_MAX_SECONDS + 5) {
        return yield* new UnoDescribeVideoError({
          message: "Recordings up to 60 minutes can be watched.",
          reason: "too-large",
        });
      }
      const parts = input.driveParts;
      return yield* Effect.tryPromise({
        try: () =>
          postDescribeDrive({
            baseUrl: UNO_GATEWAY_BASE_URL,
            apiKey,
            parts,
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          }),
        catch: gatewayError,
      });
    }
    if (!input.path) {
      return yield* new UnoDescribeVideoError({
        message: "Name the recording: a file on this computer or its parts in Uno Drive.",
        reason: "invalid-path",
      });
    }
    const path = input.path;
    if (input.durationSec > UNO_DESCRIBE_VIDEO_MAX_SECONDS + 5) {
      return yield* new UnoDescribeVideoError({
        message: "One file up to 10 minutes can be watched; longer ones go part by part.",
        reason: "too-large",
      });
    }
    const bytes = yield* Effect.tryPromise({
      try: async () => {
        const root = options.root ?? (await resolveFilesRoot(configuredFilesRoot()));
        const file = await resolveRecordingPath(root, path);
        const stat = await fsPromises.stat(file);
        if (stat.size > UNO_DESCRIBE_VIDEO_MAX_BYTES) {
          throw new UnoDescribeVideoError({
            message: "This recording is too big to watch (25 MB at most).",
            reason: "too-large",
          });
        }
        return {
          data: new Uint8Array(await fsPromises.readFile(file)),
          name: nodePath.basename(file),
        };
      },
      catch: (cause) =>
        cause instanceof UnoDescribeVideoError
          ? cause
          : new UnoDescribeVideoError({
              message: "The recording isn't on this computer.",
              reason: "invalid-path",
            }),
    });
    return yield* Effect.tryPromise({
      try: () =>
        postDescribe({
          baseUrl: UNO_GATEWAY_BASE_URL,
          apiKey,
          bytes: bytes.data,
          fileName: bytes.name,
          mimeType: input.mimeType.split(";")[0] ?? input.mimeType,
          durationSec: input.durationSec,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        }),
      catch: gatewayError,
    });
  });
