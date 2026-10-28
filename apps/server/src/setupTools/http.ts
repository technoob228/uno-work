/**
 * HTTP surface of onboarding v3's "Connect your tools" and "Give it your
 * material" (contract: reports/day_2026-09-25/onboarding-v3/CONTRACT.md, C/D2).
 * Owner sessions only, like the other `/api/manager/*` management routes.
 *
 * - `GET    /api/manager/connectors`                  → {available, reason, connectors}
 * - `POST   /api/manager/connectors/:provider/start`  → {authorizeUrl}
 * - `DELETE /api/manager/connectors/:provider`        → {ok: true}
 * - `GET    /api/manager/github`                      → {available, reason, connected, accounts, permission}
 * - `POST   /api/manager/github/connect`              → {authorizeUrl} (the account's GitHub, for git on every computer)
 * - `GET    /api/manager/mail`                        → {available, reason, mailbox} ("Email for your AI")
 * - `PUT    /api/manager/mail/address` {local}        → {address}; 409/422 {error: sentence, code}
 * - `POST   /api/manager/mcp/probe` {url}             → {ok, toolCount, toolNames, needsAuth, error}
 * - `GET    /api/manager/assistant/mcp?projectId=`    → {servers: [{name, host, enabled}]} (its own MCP servers)
 * - `POST   /api/manager/assistant/mcp` {projectId, url, name?} → {name, servers}; 400 {error: sentence, code}
 * - `DELETE /api/manager/assistant/mcp?projectId=&name=` → {servers}
 * - `POST   /api/manager/materials/read` {projectPath, links} → {jobId}
 * - `GET    /api/manager/materials/read/:jobId`       → the job
 * - `POST   /api/manager/assistant/draft` {phrase, template} → name, emoji, job, schedule, ≤3 questions
 *
 * @module setupTools/http
 */
import { AssistantDraftInput, isAssistantProjectId } from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { AuthError } from "../auth/Services/ServerAuth.ts";
import { ServerConfig } from "../config.ts";
import {
  addAssistantMcpServer,
  readAssistantMcpServers,
  toAssistantMcpView,
  updateAssistantMcpServers,
} from "../mcp/assistantMcpStore.ts";
import { AgentMailService } from "./AgentMailService.ts";
import { authenticateOwnerSession, respondToAuthError } from "../manager/http.ts";
import { isConnectorProvider, type ConnectorsError } from "./connectors.ts";
import { ConnectorsService } from "./ConnectorsService.ts";
import { GithubAccountService } from "./GithubAccountService.ts";
import { MaterialsService } from "./MaterialsService.ts";
import type { MaterialsJobError } from "./materialsJob.ts";
import { probeMcpServer } from "./mcpProbe.ts";
import { AssistantDraftService } from "./AssistantDraftService.ts";

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });

const respondConnectorsError = (error: ConnectorsError) =>
  Effect.succeed(json({ error: error.code, message: error.message }, error.status));

const respondMaterialsError = (error: MaterialsJobError) =>
  Effect.succeed(
    json(
      {
        error: error.code,
        message: error.message,
        ...(error.jobId !== null ? { jobId: error.jobId } : {}),
      },
      error.status,
    ),
  );

const providerParam = Effect.gen(function* () {
  const params = yield* HttpRouter.params;
  const provider = params.provider ?? "";
  if (!isConnectorProvider(provider)) {
    return yield* new AuthError({ message: "Unknown connector.", status: 400 });
  }
  return provider;
});

export const connectorsListRouteLayer = HttpRouter.add(
  "GET",
  "/api/manager/connectors",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const connectors = yield* ConnectorsService;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    // The Setup screen asks again after an OAuth window closes: `?refresh=1` skips the cache.
    const force = url._tag === "Some" && url.value.searchParams.get("refresh") === "1";
    return yield* connectors.list({ force }).pipe(
      Effect.map((list) => json(list)),
      Effect.catch(respondConnectorsError),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const connectorsStartRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/connectors/:provider/start",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const provider = yield* providerParam;
    const connectors = yield* ConnectorsService;
    return yield* connectors.start(provider).pipe(
      Effect.map((result) => json({ authorizeUrl: result.authorizeUrl })),
      Effect.catch(respondConnectorsError),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const connectorsRemoveRouteLayer = HttpRouter.add(
  "DELETE",
  "/api/manager/connectors/:provider",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const provider = yield* providerParam;
    const connectors = yield* ConnectorsService;
    return yield* connectors.remove(provider).pipe(
      Effect.map(() => json({ ok: true })),
      Effect.catch(respondConnectorsError),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/**
 * GitHub of the account (the Uno GitHub App): is it connected, and may this
 * computer use it. Asking also makes sure git on this computer knows where to
 * get its GitHub sign-in (the credential helper).
 */
export const githubAccountStatusRouteLayer = HttpRouter.add(
  "GET",
  "/api/manager/github",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const github = yield* GithubAccountService;
    return json(yield* github.status);
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const githubAccountConnectRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/github/connect",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const github = yield* GithubAccountService;
    return yield* github.connect.pipe(
      Effect.map((result) => json({ authorizeUrl: result.authorizeUrl })),
      Effect.catch(respondConnectorsError),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/** "Email for your AI": the computer's own mailbox, shown in Settings → Connectors. */
export const agentMailStatusRouteLayer = HttpRouter.add(
  "GET",
  "/api/manager/mail",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const mail = yield* AgentMailService;
    return json(yield* mail.status);
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

const AgentMailAddressPayload = Schema.Struct({
  local: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});

/**
 * Rename the mailbox. Errors carry the person's sentence in `error` (what the
 * interface shows as is) and the console's code in `code` ("taken", "invalid").
 */
export const agentMailAddressRouteLayer = HttpRouter.add(
  "PUT",
  "/api/manager/mail/address",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const input = yield* HttpServerRequest.schemaBodyJson(AgentMailAddressPayload).pipe(
      Effect.mapError(() => new AuthError({ message: "Expected {local}.", status: 400 })),
    );
    const mail = yield* AgentMailService;
    return yield* mail.changeAddress(input.local.trim().toLowerCase()).pipe(
      Effect.map((result) => json({ address: result.address })),
      Effect.catch((error: ConnectorsError) =>
        Effect.succeed(json({ error: error.message, code: error.code }, error.status)),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

const ProbePayload = Schema.Struct({ url: Schema.String.check(Schema.isMaxLength(2048)) });

export const mcpProbeRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/mcp/probe",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const input = yield* HttpServerRequest.schemaBodyJson(ProbePayload).pipe(
      Effect.mapError(() => new AuthError({ message: "Expected {url}.", status: 400 })),
    );
    const result = yield* Effect.promise(() => probeMcpServer(input.url));
    return json(result);
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

// ── An assistant's own MCP servers (assistants D, 28.10) ─────────────────

const assistantProjectParam = (raw: string | null | undefined) => {
  const projectId = raw?.trim() ?? "";
  return isAssistantProjectId(projectId)
    ? Effect.succeed(projectId)
    : Effect.fail(
        new AuthError({ message: "projectId must be an assistant project.", status: 400 }),
      );
};

const queryParam = (name: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    return url._tag === "Some" ? url.value.searchParams.get(name) : null;
  });

const ASSISTANT_MCP_PROBLEM: Readonly<Record<string, string>> = {
  invalid_url: "Paste the server’s https:// address, e.g. https://mcp.example.com/mcp",
  duplicate: "This server is already added for this assistant.",
  too_many: "An assistant can have up to 20 servers of its own.",
  invalid_name: "Use a short name: lowercase letters, digits, - and _.",
};

/** `GET /api/manager/assistant/mcp?projectId=` — the servers given to this assistant (hosts only). */
export const assistantMcpListRouteLayer = HttpRouter.add(
  "GET",
  "/api/manager/assistant/mcp",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const projectId = yield* assistantProjectParam(yield* queryParam("projectId"));
    const { stateDir } = yield* ServerConfig;
    const servers = yield* Effect.promise(() => readAssistantMcpServers(stateDir, projectId));
    return json({ servers: servers.map(toAssistantMcpView) });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

const AssistantMcpAddPayload = Schema.Struct({
  projectId: Schema.String.check(Schema.isMaxLength(200)),
  url: Schema.String.check(Schema.isMaxLength(2048)),
  name: Schema.optional(Schema.String.check(Schema.isMaxLength(48))),
});

/**
 * `POST /api/manager/assistant/mcp` {projectId, url, name?} — gives a server
 * to this assistant: its next chats get the tools, in the sandbox too. The
 * address is checked by the client first (`/api/manager/mcp/probe`).
 */
export const assistantMcpAddRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/assistant/mcp",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const input = yield* HttpServerRequest.schemaBodyJson(AssistantMcpAddPayload).pipe(
      Effect.mapError(
        () => new AuthError({ message: "Expected {projectId, url, name?}.", status: 400 }),
      ),
    );
    const projectId = yield* assistantProjectParam(input.projectId);
    const { stateDir } = yield* ServerConfig;
    const outcome = yield* Effect.promise(() =>
      updateAssistantMcpServers(stateDir, projectId, (current) => {
        const result = addAssistantMcpServer(current, { url: input.url, name: input.name });
        return { servers: result.ok ? result.servers : null, result };
      }),
    );
    if (!outcome.ok) {
      return json({ error: ASSISTANT_MCP_PROBLEM[outcome.code], code: outcome.code }, 400);
    }
    return json({ name: outcome.name, servers: outcome.servers.map(toAssistantMcpView) });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/** `DELETE /api/manager/assistant/mcp?projectId=&name=` — takes a server back (already gone is fine). */
export const assistantMcpRemoveRouteLayer = HttpRouter.add(
  "DELETE",
  "/api/manager/assistant/mcp",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const projectId = yield* assistantProjectParam(yield* queryParam("projectId"));
    const name = (yield* queryParam("name"))?.trim() ?? "";
    const { stateDir } = yield* ServerConfig;
    const servers = yield* Effect.promise(() =>
      updateAssistantMcpServers(stateDir, projectId, (current) => {
        const next = current.filter((server) => server.name !== name);
        return { servers: next.length === current.length ? null : next, result: next };
      }),
    );
    return json({ servers: servers.map(toAssistantMcpView) });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

const MaterialsPayload = Schema.Struct({
  projectPath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  links: Schema.optional(Schema.Array(Schema.String.check(Schema.isMaxLength(2048)))),
});

export const materialsReadRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/materials/read",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const input = yield* HttpServerRequest.schemaBodyJson(MaterialsPayload).pipe(
      Effect.mapError(
        () => new AuthError({ message: "Expected {projectPath, links}.", status: 400 }),
      ),
    );
    const materials = yield* MaterialsService;
    return yield* materials
      .start({ projectPath: input.projectPath, links: input.links ?? [] })
      .pipe(
        Effect.map((result) => json(result)),
        Effect.catch(respondMaterialsError),
      );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const materialsReadStatusRouteLayer = HttpRouter.add(
  "GET",
  "/api/manager/materials/read/:jobId",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const params = yield* HttpRouter.params;
    const materials = yield* MaterialsService;
    const job = yield* materials.get(params.jobId ?? "");
    return job === null ? json({ error: "not_found", message: "No such job." }, 404) : json(job);
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/**
 * "New assistant": Uno AI turns the person's sentence into a draft. 503 when
 * this computer has no gateway key, 502 when the AI answered badly — the
 * client then asks its built-in questions for the template.
 */
export const assistantDraftRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/assistant/draft",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const input = yield* HttpServerRequest.schemaBodyJson(AssistantDraftInput).pipe(
      Effect.mapError(
        () => new AuthError({ message: "Expected {phrase, template}.", status: 400 }),
      ),
    );
    const drafts = yield* AssistantDraftService;
    return yield* drafts.draft(input).pipe(
      Effect.map((draft) => json(draft)),
      Effect.catchTag("AssistantDraftError", (error) =>
        Effect.logWarning("assistant draft failed", {
          code: error.code,
          message: error.message,
        }).pipe(
          Effect.as(
            json(
              {
                error: error.code,
                message:
                  error.code === "no_ai" ? error.message : "Uno AI couldn't draft it this time.",
              },
              error.status,
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const setupToolsRouteLayers = [
  connectorsListRouteLayer,
  connectorsStartRouteLayer,
  connectorsRemoveRouteLayer,
  githubAccountStatusRouteLayer,
  githubAccountConnectRouteLayer,
  agentMailStatusRouteLayer,
  agentMailAddressRouteLayer,
  mcpProbeRouteLayer,
  assistantMcpListRouteLayer,
  assistantMcpAddRouteLayer,
  assistantMcpRemoveRouteLayer,
  materialsReadRouteLayer,
  materialsReadStatusRouteLayer,
  assistantDraftRouteLayer,
] as const;
