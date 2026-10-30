/**
 * HTTP surface of Automations for the Uno Work UI (owner sessions only, like
 * the other `/api/manager/*` routes; CONTRACT.md "HTTP демона"):
 *
 * - `GET    /api/manager/automations`                → AutomationListResult
 * - `POST   /api/manager/automations`                AutomationCreateInput → Automation
 * - `PATCH  /api/manager/automations/:id`            AutomationUpdateInput → Automation
 * - `DELETE /api/manager/automations/:id`            → {deleted}
 * - `POST   /api/manager/automations/:id/run`        → {run}
 * - `GET    /api/manager/automations/:id/runs`       → AutomationRunsResult
 * - `GET    /api/manager/automations/github/repos?q=` → AutomationGithubReposResult
 * - `GET    /api/manager/automations/:id/hook`       → AutomationHook (a webhook's URL)
 * - `POST   /api/manager/automations/:id/hook/rotate` → AutomationHook (a new URL)
 *
 * A refusal answers `{error: {code, message, manageUrl?, connectUrl?}}` with
 * the console's status (502 when it didn't answer, 409 NOT_CLOUD_COMPUTER on
 * a laptop).
 *
 * @module automations/http
 */
import { Effect, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { AuthError } from "../auth/Services/ServerAuth.ts";
import { authenticateOwnerSession, respondToAuthError } from "../manager/http.ts";
import { AutomationsService, type AutomationsServiceShape } from "./AutomationsService.ts";
import { automationErrorBody, type AutomationClientError } from "./consoleClient.ts";

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });

/** A webhook's URL and signing secret: no cache keeps them. */
const secretJson = (body: unknown) =>
  HttpServerResponse.setHeader(json(body), "Cache-Control", "no-store");

const refused = (error: AutomationClientError) => json(automationErrorBody(error), error.status);

const readJson = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  return yield* request.json.pipe(Effect.orElseSucceed(() => null));
});

/** `:id` of the path, a positive integer. */
const automationId = Effect.gen(function* () {
  const params = yield* HttpRouter.params;
  const raw = params.id ?? "";
  const id = /^\d{1,12}$/.test(raw) ? Number(raw) : 0;
  if (!(id > 0)) {
    return yield* new AuthError({ message: "Unknown automation.", status: 400 });
  }
  return id;
});

const route = <R>(
  handler: (
    automations: AutomationsServiceShape,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, AuthError, R>,
) =>
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const automations = yield* Effect.serviceOption(AutomationsService);
    if (Option.isNone(automations)) {
      return json(
        {
          error: { code: "AUTOMATIONS_DISABLED", message: "Automations aren't in this Uno Work." },
        },
        404,
      );
    }
    return yield* handler(automations.value);
  }).pipe(Effect.catchTag("AuthError", respondToAuthError));

export const automationsListRouteLayer = HttpRouter.add(
  "GET",
  "/api/manager/automations",
  route((automations) => automations.list.pipe(Effect.map((result) => json(result)))),
);

export const automationsCreateRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/automations",
  route((automations) =>
    Effect.gen(function* () {
      const body = yield* readJson;
      return yield* automations.create(body).pipe(
        Effect.map((automation) => json(automation, 201)),
        Effect.catch((error) => Effect.succeed(refused(error))),
      );
    }),
  ),
);

export const automationsReposRouteLayer = HttpRouter.add(
  "GET",
  "/api/manager/automations/github/repos",
  route((automations) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = HttpServerRequest.toURL(request);
      const query = Option.isSome(url) ? (url.value.searchParams.get("q") ?? "") : "";
      return yield* automations.repos(query).pipe(
        Effect.map((result) => json(result)),
        Effect.catch((error) => Effect.succeed(refused(error))),
      );
    }),
  ),
);

export const automationsUpdateRouteLayer = HttpRouter.add(
  "PATCH",
  "/api/manager/automations/:id",
  route((automations) =>
    Effect.gen(function* () {
      const id = yield* automationId;
      const body = yield* readJson;
      return yield* automations.update(id, body).pipe(
        Effect.map((automation) => json(automation)),
        Effect.catch((error) => Effect.succeed(refused(error))),
      );
    }),
  ),
);

export const automationsDeleteRouteLayer = HttpRouter.add(
  "DELETE",
  "/api/manager/automations/:id",
  route((automations) =>
    Effect.gen(function* () {
      const id = yield* automationId;
      return yield* automations.remove(id).pipe(
        Effect.map((result) => json(result)),
        Effect.catch((error) => Effect.succeed(refused(error))),
      );
    }),
  ),
);

export const automationsRunRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/automations/:id/run",
  route((automations) =>
    Effect.gen(function* () {
      const id = yield* automationId;
      return yield* automations.runNow(id).pipe(
        Effect.map((run) => json({ run }, 202)),
        Effect.catch((error) => Effect.succeed(refused(error))),
      );
    }),
  ),
);

export const automationsRunsRouteLayer = HttpRouter.add(
  "GET",
  "/api/manager/automations/:id/runs",
  route((automations) =>
    Effect.gen(function* () {
      const id = yield* automationId;
      return yield* automations.runs(id).pipe(
        Effect.map((result) => json(result)),
        Effect.catch((error) => Effect.succeed(refused(error))),
      );
    }),
  ),
);

export const automationsHookRouteLayer = HttpRouter.add(
  "GET",
  "/api/manager/automations/:id/hook",
  route((automations) =>
    Effect.gen(function* () {
      const id = yield* automationId;
      return yield* automations.hook(id).pipe(
        Effect.map((hook) => secretJson(hook)),
        Effect.catch((error) => Effect.succeed(refused(error))),
      );
    }),
  ),
);

export const automationsHookRotateRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/automations/:id/hook/rotate",
  route((automations) =>
    Effect.gen(function* () {
      const id = yield* automationId;
      return yield* automations.rotateHook(id).pipe(
        Effect.map((hook) => secretJson(hook)),
        Effect.catch((error) => Effect.succeed(refused(error))),
      );
    }),
  ),
);

export const automationsRouteLayers = [
  automationsListRouteLayer,
  automationsCreateRouteLayer,
  // Before `/:id` routes: "github" is not an id.
  automationsReposRouteLayer,
  automationsUpdateRouteLayer,
  automationsDeleteRouteLayer,
  automationsRunRouteLayer,
  automationsRunsRouteLayer,
  automationsHookRouteLayer,
  automationsHookRotateRouteLayer,
] as const;
