/**
 * Uno Work updating itself on a cloud computer (see selfUpdate.ts):
 *
 *   GET  /api/self-update/status   any signed-in session — is there an update,
 *                                  how the running one is going;
 *   POST /api/self-update/start    OWNER session only, body `{"confirm":"update"}`;
 *   POST /api/self-update/later    OWNER session only, body
 *                                  `{"confirm":"later","notBefore":"<ISO time>"}` —
 *                                  "This evening" (selfUpdateLater.ts).
 *
 * There is no other way to ask for an update: no WS method, no agent tool, no
 * bridge-token route. The POSTs want a JSON body, so a page on another origin
 * cannot send it without a CORS preflight (which only our origins pass).
 */
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import packageJson from "../package.json" with { type: "json" };
import { respondToAuthError } from "./auth/http.ts";
import { AuthError, ServerAuth } from "./auth/Services/ServerAuth.ts";
import { ServerConfig } from "./config.ts";
import { readWorkMachineIdentity } from "./manager/workConsole.ts";
import {
  makeSelfUpdateController,
  selfUpdatePathsFromEnv,
  SelfUpdateUnavailableError,
  type SelfUpdateController,
} from "./selfUpdate.ts";
import {
  noteSelfUpdateIntent,
  reportSelfUpdate,
  reportSelfUpdateAfterStart,
} from "./selfUpdateJournal.ts";
import {
  clampNotBefore,
  clearUpdateLater,
  economySignalsFor,
  readUpdateLater,
  setUpdateLaterEconomySignals,
  statusWithLater,
  writeUpdateLater,
} from "./selfUpdateLater.ts";
import { ServerSettingsService } from "./serverSettings.ts";
import { controlPlaneBaseUrl } from "./workspaceRegistry/unoCloudParse.ts";

let controller: SelfUpdateController | null = null;

export function selfUpdateController(): SelfUpdateController {
  controller ??= makeSelfUpdateController({
    paths: selfUpdatePathsFromEnv(),
    currentVersion: packageJson.version,
  });
  return controller;
}

const reportWith = (report: typeof reportSelfUpdate) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const settings = yield* ServerSettingsService;
    const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    const update = selfUpdateController();
    yield* Effect.promise(() =>
      report({
        stateDir: config.stateDir,
        lastRun: update.lastRun,
        identity: readWorkMachineIdentity(current?.uno),
        consoleBaseUrl: controlPlaneBaseUrl(),
      }),
    );
  });

/** Tell the console about a finished update (Security journal). Never fails. */
export const reportSelfUpdateToConsole = reportWith(reportSelfUpdate);

/**
 * The same at daemon start: waits while the updater that started this daemon
 * is still checking it (selfUpdateJournal.ts). Never fails; run it forked.
 */
export const reportSelfUpdateAfterStartToConsole = reportWith(reportSelfUpdateAfterStart);

const NO_STORE = { "Cache-Control": "no-store" } as const;

export const selfUpdateStatusRouteLayer = HttpRouter.add(
  "GET",
  "/api/self-update/status",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    const refresh = (request.url.split("?")[1] ?? "").split("&").includes("refresh=1");
    const config = yield* ServerConfig;
    const status = yield* Effect.promise(async () =>
      statusWithLater(
        await selfUpdateController().status({ canUpdate: session.role === "owner", refresh }),
        await readUpdateLater(config.stateDir),
      ),
    );
    // A finished run the console has not heard about yet: tell it in the background.
    if (status.supported && (status.state === "done" || status.state === "failed")) {
      yield* reportSelfUpdateToConsole.pipe(Effect.ignore, Effect.forkDetach);
    }
    return HttpServerResponse.jsonUnsafe(status, { headers: NO_STORE });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const selfUpdateStartRouteLayer = HttpRouter.add(
  "POST",
  "/api/self-update/start",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    if (session.role !== "owner") {
      return yield* new AuthError({
        message: "Only the owner of this computer can update Uno Work.",
        status: 403,
      });
    }
    const contentType = request.headers["content-type"] ?? "";
    const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    const confirmed =
      contentType.toLowerCase().startsWith("application/json") &&
      typeof body === "object" &&
      body !== null &&
      (body as Record<string, unknown>)["confirm"] === "update";
    if (!confirmed) {
      return HttpServerResponse.jsonUnsafe(
        { error: 'Expected the JSON body {"confirm":"update"}.' },
        { status: 400, headers: NO_STORE },
      );
    }
    const config = yield* ServerConfig;
    const update = selfUpdateController();
    const started = yield* Effect.promise(async () => {
      try {
        // The note first: the updater may start before `start()` returns.
        await noteSelfUpdateIntent(config.stateDir).catch(() => undefined);
        const status = await update.start();
        // "Now" replaces an earlier "This evening".
        await clearUpdateLater(config.stateDir);
        setUpdateLaterEconomySignals(economySignalsFor(null, null, Date.now()));
        return { ok: true as const, status };
      } catch (cause) {
        const conflict = cause instanceof SelfUpdateUnavailableError;
        return {
          ok: false as const,
          message: conflict ? cause.message : "Couldn't start the update. Try again in a minute.",
          conflict,
        };
      }
    });
    if (!started.ok) {
      if (!started.conflict) {
        yield* Effect.logError("self-update: could not write the request");
      }
      return HttpServerResponse.jsonUnsafe(
        { error: started.message },
        { status: started.conflict ? 409 : 500, headers: NO_STORE },
      );
    }
    yield* Effect.logInfo("self-update: requested by the owner", {
      from: started.status.currentVersion,
      to: started.status.latestVersion,
    });
    return HttpServerResponse.jsonUnsafe(started.status, { status: 202, headers: NO_STORE });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const selfUpdateLaterRouteLayer = HttpRouter.add(
  "POST",
  "/api/self-update/later",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    if (session.role !== "owner") {
      return yield* new AuthError({
        message: "Only the owner of this computer can update Uno Work.",
        status: 403,
      });
    }
    const contentType = request.headers["content-type"] ?? "";
    const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    const now = Date.now();
    const record =
      contentType.toLowerCase().startsWith("application/json") &&
      typeof body === "object" &&
      body !== null
        ? (body as Record<string, unknown>)
        : null;
    const notBefore =
      record?.["confirm"] === "later" ? clampNotBefore(record["notBefore"], now) : null;
    if (notBefore === null) {
      return HttpServerResponse.jsonUnsafe(
        { error: 'Expected the JSON body {"confirm":"later","notBefore":"<ISO time>"}.' },
        { status: 400, headers: NO_STORE },
      );
    }
    const config = yield* ServerConfig;
    const update = selfUpdateController();
    const current = yield* Effect.promise(async () =>
      statusWithLater(await update.status({ canUpdate: true, refresh: true }), null),
    );
    if (current.state === "updating") {
      // Already on its way: nothing to book.
      return HttpServerResponse.jsonUnsafe(current, { status: 200, headers: NO_STORE });
    }
    if (!current.supported || !current.laterAvailable || !current.latestVersion) {
      const message = !current.supported
        ? "This computer can't update Uno Work by itself."
        : current.available
          ? "This version didn't start on this computer. Use Update to try it again."
          : "Uno Work is already up to date.";
      return HttpServerResponse.jsonUnsafe({ error: message }, { status: 409, headers: NO_STORE });
    }
    const later = { version: current.latestVersion, notBefore };
    const saved = yield* Effect.promise(() =>
      writeUpdateLater(config.stateDir, later).then(
        () => true,
        () => false,
      ),
    );
    if (!saved) {
      yield* Effect.logError("self-update: could not keep 'this evening'");
      return HttpServerResponse.jsonUnsafe(
        { error: "Couldn't start the update. Try again in a minute." },
        { status: 500, headers: NO_STORE },
      );
    }
    // The alarm goes to the console with the next economy report (≤ 10 s).
    setUpdateLaterEconomySignals(economySignalsFor(later, null, now));
    yield* Effect.logInfo("self-update: the owner said 'this evening'", {
      from: current.currentVersion,
      to: later.version,
      notBefore,
    });
    return HttpServerResponse.jsonUnsafe(statusWithLater(current, later), {
      status: 200,
      headers: NO_STORE,
    });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);
