/**
 * Uno Work updating itself on a cloud computer (see selfUpdate.ts):
 *
 *   GET  /api/self-update/status   any signed-in session — is there an update,
 *                                  how the running one is going, how many
 *                                  agents work right now, whether an update
 *                                  waits for them;
 *   GET  /api/self-update/agents   any signed-in session — which of Claude,
 *                                  Codex and OpenCode are behind (read-only: the
 *                                  update itself is the harness install job);
 *   POST /api/self-update/start    OWNER session only, body
 *                                  `{"confirm":"update"}` (now) or
 *                                  `{"confirm":"update","when":"after-agents"}`
 *                                  (once the agents finish, selfUpdateTurns.ts);
 *   POST /api/self-update/cancel   OWNER session only, body `{"confirm":"cancel"}`:
 *                                  drop the update that waits for the agents.
 *
 * There is no other way to ask for an update: no WS method, no agent tool, no
 * bridge-token route. The POSTs want a JSON body, so a page on another origin
 * cannot send them without a CORS preflight (which only our origins pass).
 */
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { agentUpdateStatuses, findInstalledBin, latestNpmVersion } from "./agentUpdates.ts";
import { respondToAuthError } from "./auth/http.ts";
import { AuthError, ServerAuth } from "./auth/Services/ServerAuth.ts";
import { ServerConfig } from "./config.ts";
import { readWorkMachineIdentity } from "./manager/workConsole.ts";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry.ts";
import { SelfUpdateUnavailableError, type SelfUpdateStatus } from "./selfUpdate.ts";
import { selfUpdateController } from "./selfUpdateController.ts";
import { reportSelfUpdate, reportSelfUpdateAfterStart } from "./selfUpdateJournal.ts";
import {
  clearDeferredUpdate,
  deferredUpdateFor,
  readDeferredUpdate,
  writeDeferredUpdate,
  type DeferredUpdate,
} from "./selfUpdateTurns.ts";
import { requestSelfUpdateNow, workingTurnsNow } from "./selfUpdateTurnsRuntime.ts";
import { ServerSettingsService } from "./serverSettings.ts";
import { controlPlaneBaseUrl } from "./workspaceRegistry/unoCloudParse.ts";

export { selfUpdateController } from "./selfUpdateController.ts";

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

/** What `GET /api/self-update/status` answers: the controller's status and the agents. */
export interface SelfUpdateStatusWithAgents extends SelfUpdateStatus {
  /** Agents working right now (0 when there is no update to ask about). */
  readonly workingAgents: number;
  /** "Update when they finish" is waiting; null otherwise. */
  readonly waiting: DeferredUpdate | null;
}

const withAgents = (status: SelfUpdateStatus) =>
  Effect.gen(function* () {
    if (!status.supported) {
      return { ...status, workingAgents: 0, waiting: null } satisfies SelfUpdateStatusWithAgents;
    }
    const config = yield* ServerConfig;
    const waiting =
      status.state === "updating"
        ? null
        : yield* Effect.promise(() => readDeferredUpdate(config.stateDir));
    // The count is for the question "update now?": not needed while it runs.
    const workingAgents =
      status.state !== "updating" && (status.available || waiting !== null)
        ? (yield* workingTurnsNow.pipe(Effect.orElseSucceed(() => []))).length
        : 0;
    return { ...status, workingAgents, waiting } satisfies SelfUpdateStatusWithAgents;
  });

export const selfUpdateStatusRouteLayer = HttpRouter.add(
  "GET",
  "/api/self-update/status",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    const refresh = (request.url.split("?")[1] ?? "").split("&").includes("refresh=1");
    const status = yield* Effect.promise(() =>
      selfUpdateController().status({ canUpdate: session.role === "owner", refresh }),
    );
    // A finished run the console has not heard about yet: tell it in the background.
    if (status.supported && (status.state === "done" || status.state === "failed")) {
      yield* reportSelfUpdateToConsole.pipe(Effect.ignore, Effect.forkDetach);
    }
    return HttpServerResponse.jsonUnsafe(yield* withAgents(status), { headers: NO_STORE });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const selfUpdateAgentsRouteLayer = HttpRouter.add(
  "GET",
  "/api/self-update/agents",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    yield* serverAuth.authenticateHttpRequest(request);
    const registry = yield* ProviderRegistry;
    const providers = yield* registry.getProviders;
    const agents = yield* Effect.promise(() =>
      agentUpdateStatuses(providers, { latest: latestNpmVersion, binPath: findInstalledBin }),
    );
    return HttpServerResponse.jsonUnsafe({ agents }, { headers: NO_STORE });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/** The owner's session and the JSON body `{"confirm": <word>, ...}`, or the answer to send instead. */
const ownerConfirmed = (word: string) =>
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
    const record =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
    const confirmed =
      contentType.toLowerCase().startsWith("application/json") && record?.["confirm"] === word;
    return confirmed ? { ok: true as const, body: record! } : { ok: false as const };
  });

const badBody = (word: string) =>
  HttpServerResponse.jsonUnsafe(
    { error: `Expected the JSON body {"confirm":"${word}"}.` },
    { status: 400, headers: NO_STORE },
  );

export const selfUpdateStartRouteLayer = HttpRouter.add(
  "POST",
  "/api/self-update/start",
  Effect.gen(function* () {
    const confirmed = yield* ownerConfirmed("update");
    if (!confirmed.ok) return badBody("update");
    const afterAgents = confirmed.body["when"] === "after-agents";
    const config = yield* ServerConfig;
    const update = selfUpdateController();
    const turns = yield* workingTurnsNow.pipe(Effect.orElseSucceed(() => []));

    if (afterAgents && turns.length > 0) {
      const current = yield* Effect.promise(() =>
        update.status({ canUpdate: true, refresh: true }),
      );
      if (current.state !== "updating") {
        if (!current.supported || !current.available) {
          return HttpServerResponse.jsonUnsafe(
            {
              error: current.supported
                ? "Uno Work is already up to date."
                : "This computer can't update Uno Work by itself.",
            },
            { status: 409, headers: NO_STORE },
          );
        }
        // An earlier wait keeps its deadline: asking again must not push it back.
        const waiting = yield* Effect.promise(async () => {
          const existing = await readDeferredUpdate(config.stateDir);
          if (existing) return existing;
          const next = deferredUpdateFor(Date.now());
          await writeDeferredUpdate(config.stateDir, next);
          return next;
        }).pipe(Effect.option);
        if (waiting._tag === "None") {
          yield* Effect.logError("self-update: could not save the waiting update");
          return HttpServerResponse.jsonUnsafe(
            { error: "Couldn't start the update. Try again in a minute." },
            { status: 500, headers: NO_STORE },
          );
        }
        yield* Effect.logInfo("self-update: the owner asked to update after the agents finish", {
          workingAgents: turns.length,
          deadlineAt: waiting.value.deadlineAt,
        });
        return HttpServerResponse.jsonUnsafe(
          {
            ...current,
            workingAgents: turns.length,
            waiting: waiting.value,
          } satisfies SelfUpdateStatusWithAgents,
          { status: 202, headers: NO_STORE },
        );
      }
    }

    const started = yield* Effect.promise(async () => {
      try {
        const status = await requestSelfUpdateNow({
          stateDir: config.stateDir,
          controller: update,
          turns,
        });
        // "Update now" replaces a waiting "when they finish".
        await clearDeferredUpdate(config.stateDir).catch(() => undefined);
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
      workingAgents: turns.length,
    });
    return HttpServerResponse.jsonUnsafe(
      {
        ...started.status,
        workingAgents: 0,
        waiting: null,
      } satisfies SelfUpdateStatusWithAgents,
      { status: 202, headers: NO_STORE },
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const selfUpdateCancelRouteLayer = HttpRouter.add(
  "POST",
  "/api/self-update/cancel",
  Effect.gen(function* () {
    const confirmed = yield* ownerConfirmed("cancel");
    if (!confirmed.ok) return badBody("cancel");
    const config = yield* ServerConfig;
    yield* Effect.promise(() => clearDeferredUpdate(config.stateDir).catch(() => undefined));
    yield* Effect.logInfo("self-update: the owner called off the waiting update");
    const status = yield* Effect.promise(() => selfUpdateController().status({ canUpdate: true }));
    return HttpServerResponse.jsonUnsafe(yield* withAgents(status), { headers: NO_STORE });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);
