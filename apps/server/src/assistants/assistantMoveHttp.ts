/**
 * HTTP surface of moving an assistant between computers (owner sessions only,
 * like every `/api/manager/*` route). The app drives a move through both
 * computers' daemons (`@t3tools/shared/assistantMove`); each step is one
 * call here:
 *
 * - `POST /api/manager/assistant/move/export`    {projectId, name?, computerName} → bundle
 * - `POST /api/manager/assistant/move/import`    {bundle, from} → {projectId, ok, problems}
 * - `POST /api/manager/assistant/move/activate`  {projectId, bundle, from} → {relink}
 * - `POST /api/manager/assistant/move/discard`   {projectId} → {ok}
 * - `POST /api/manager/assistant/move/release`   {projectId, to} → {ok}
 * - `POST /api/manager/assistant/move/unrelease` {projectId} → {ok}
 *
 * The bundle carries the assistant's own bot tokens: answers are `no-store`
 * and nothing of it is logged. A refusal answers `{error}` with a status.
 *
 * @module assistants/assistantMoveHttp
 */
import type { AssistantMoveBundle, AssistantMoveComputer } from "@t3tools/shared/assistantMove";
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { authenticateOwnerSession, respondToAuthError } from "../manager/http.ts";
import {
  AssistantMoveOpError,
  makeAssistantMoveOps,
  type AssistantMoveOps,
} from "./assistantMoveOps.ts";

export const ASSISTANT_MOVE_PATH = "/api/manager/assistant/move";

const json = (body: unknown, status = 200) =>
  HttpServerResponse.setHeader(
    HttpServerResponse.jsonUnsafe(body, { status }),
    "Cache-Control",
    "no-store",
  );

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const str = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
};

/** `{name, boxId}` of a computer as the app names it. */
export function readComputer(raw: unknown): AssistantMoveComputer | null {
  const record = asRecord(raw);
  if (record === null) return null;
  const name = str(record, "name");
  const boxId = record["boxId"];
  if (name === null) return null;
  return {
    name: name.slice(0, 80),
    boxId: typeof boxId === "number" && Number.isSafeInteger(boxId) && boxId > 0 ? boxId : null,
  };
}

/** The bundle as far as the route checks it; the ops check the rest (paths, version). */
export function readBundle(raw: unknown): AssistantMoveBundle | null {
  const record = asRecord(raw);
  if (record === null) return null;
  if (typeof record["projectId"] !== "string" || typeof record["title"] !== "string") return null;
  for (const key of ["workspace", "state", "skipped", "connectors", "reminders"]) {
    if (!Array.isArray(record[key])) return null;
  }
  return record as unknown as AssistantMoveBundle;
}

const bad = (message: string) => new AssistantMoveOpError({ message, status: 400 });

const route = (
  step: string,
  handler: (
    ops: AssistantMoveOps,
    body: Record<string, unknown>,
  ) => Effect.Effect<unknown, AssistantMoveOpError>,
) =>
  HttpRouter.add(
    "POST",
    `${ASSISTANT_MOVE_PATH}/${step}`,
    Effect.gen(function* () {
      yield* authenticateOwnerSession;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = asRecord(yield* request.json.pipe(Effect.orElseSucceed(() => null)));
      if (body === null) return json({ error: "Invalid payload." }, 400);
      const ops = yield* makeAssistantMoveOps;
      return yield* handler(ops, body).pipe(
        Effect.map((result) => json(result ?? { ok: true })),
        Effect.catchTag("AssistantMoveOpError", (error) =>
          Effect.succeed(json({ error: error.message }, error.status)),
        ),
      );
    }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
  );

const projectIdOf = (body: Record<string, unknown>) => {
  const projectId = str(body, "projectId");
  return projectId === null
    ? Effect.fail(bad("projectId is required."))
    : Effect.succeed(projectId);
};

export const assistantMoveRouteLayers = [
  route("export", (ops, body) =>
    Effect.gen(function* () {
      const projectId = yield* projectIdOf(body);
      return yield* ops.exportBundle({
        projectId,
        name: str(body, "name") ?? undefined,
        computerName: str(body, "computerName") ?? "the other computer",
      });
    }),
  ),
  route("import", (ops, body) =>
    Effect.gen(function* () {
      const bundle = readBundle(body["bundle"]);
      const from = readComputer(body["from"]);
      if (bundle === null || from === null) return yield* bad("bundle and from are required.");
      return yield* ops.importBundle({ bundle, from });
    }),
  ),
  route("activate", (ops, body) =>
    Effect.gen(function* () {
      const projectId = yield* projectIdOf(body);
      const bundle = readBundle(body["bundle"]);
      const from = readComputer(body["from"]);
      if (bundle === null || from === null) return yield* bad("bundle and from are required.");
      return yield* ops.activate({ projectId, bundle, from });
    }),
  ),
  route("discard", (ops, body) =>
    Effect.gen(function* () {
      yield* ops.discard(yield* projectIdOf(body));
      return { ok: true };
    }),
  ),
  route("release", (ops, body) =>
    Effect.gen(function* () {
      const projectId = yield* projectIdOf(body);
      const to = readComputer(body["to"]);
      if (to === null) return yield* bad("to is required.");
      yield* ops.release({ projectId, to });
      return { ok: true };
    }),
  ),
  route("unrelease", (ops, body) =>
    Effect.gen(function* () {
      yield* ops.unrelease(yield* projectIdOf(body));
      return { ok: true };
    }),
  ),
] as const;
