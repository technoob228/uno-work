/**
 * The Work machine talking to the console as itself: the machine token the
 * console wrote into `settings.uno.boxToken` (a `uno_agt_` token pinned to
 * `settings.uno.boxId`), `Authorization: Bearer` on
 * `/api/v1/boxes/<boxId>/work/…`.
 *
 * Only a cloud computer has that identity; a laptop or a BYO machine gets
 * `null` from {@link readWorkMachineIdentity} and the channel routes answer
 * `409 not_cloud_computer`.
 *
 * @module manager/workConsole
 */
import { Data, Effect } from "effect";

import { parseSettingsBoxId } from "../unoBoxIdentity.ts";
import { controlPlaneBaseUrl } from "../workspaceRegistry/unoCloudParse.ts";
import { redactConnectorSecrets } from "./channelRelay.ts";

export interface WorkMachineIdentity {
  readonly boxToken: string;
  readonly boxId: number;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The machine identity from server settings, or null off a cloud computer. */
export function readWorkMachineIdentity(
  uno:
    | {
        readonly boxToken?: string | undefined;
        readonly boxId?: number | null | undefined;
      }
    | null
    | undefined,
): WorkMachineIdentity | null {
  const boxToken = uno?.boxToken?.trim() ?? "";
  const boxId = parseSettingsBoxId(uno?.boxId);
  return boxToken.length > 0 && boxId !== null ? { boxToken, boxId } : null;
}

/** The console could not be reached at all (network, timeout). */
export class WorkConsoleUnreachable extends Data.TaggedError("WorkConsoleUnreachable")<{
  readonly message: string;
}> {}

export interface WorkConsoleResponse {
  readonly status: number;
  /** Parsed JSON body; null for an empty (204) or non-JSON body. */
  readonly body: unknown;
}

const CONSOLE_TIMEOUT_MS = 20_000;

/**
 * One call to `/api/v1/boxes/<boxId>/work/<subpath>`. Resolves with the
 * status and parsed body for ANY HTTP answer (callers map console codes onto
 * their own errors); fails only when there is no answer.
 */
export const callWorkConsole = (input: {
  readonly identity: WorkMachineIdentity;
  readonly method: "GET" | "POST" | "DELETE";
  readonly subpath: string;
  readonly body?: unknown;
  readonly fetchImpl?: FetchLike;
}): Effect.Effect<WorkConsoleResponse, WorkConsoleUnreachable> =>
  Effect.tryPromise({
    try: async () => {
      const fetchImpl = input.fetchImpl ?? globalThis.fetch;
      const response = await fetchImpl(
        `${controlPlaneBaseUrl()}/api/v1/boxes/${input.identity.boxId}/work/${input.subpath}`,
        {
          method: input.method,
          headers: {
            authorization: `Bearer ${input.identity.boxToken}`,
            ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
          signal: AbortSignal.timeout(CONSOLE_TIMEOUT_MS),
        },
      );
      const text = await response.text().catch(() => "");
      let body: unknown = null;
      if (text.trim().length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
      return { status: response.status, body } satisfies WorkConsoleResponse;
    },
    catch: (cause) =>
      new WorkConsoleUnreachable({
        message: redactConnectorSecrets(cause instanceof Error ? cause.message : String(cause)),
      }),
  });

/** A string field of a console JSON object, or null. */
export function consoleString(body: unknown, key: string): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function consoleBoolean(body: unknown, key: string): boolean | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : null;
}
