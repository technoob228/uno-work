/**
 * HTTP surface of the manager tool layer:
 *
 * - `POST /api/manager/mcp` — stateless MCP endpoint for the manager brain.
 *   Authenticated with a manager capability token (`Authorization: Bearer`),
 *   never with user sessions. This is the ONLY route a manager token opens.
 * - `/api/manager/proposals*`, `/api/manager/tokens*` — owner-session-only
 *   management: list/resolve proposals, issue/list/revoke tokens.
 */
import {
  AssistantEditableFileName,
  assistantTokenLabel,
  ManagerAssistantAccessInput,
  ManagerCreateAssistantInput,
  ManagerCreateTokenInput,
  ManagerOwnerResolveProposalInput,
  ManagerProposalStatus,
  ManagerConnectorAddressingConfig,
  ManagerSlackConnectorConfig,
  ManagerTelegramConnectorConfig,
  ManagerTokenId,
  ModelSelection,
  ProjectId,
} from "@t3tools/contracts";
import { Effect, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ServerAuth, AuthError } from "../auth/Services/ServerAuth.ts";
import { ManagerCapabilityTokenRepository } from "../persistence/Services/ManagerCapabilityTokens.ts";
import { ManagerConnectorRepository } from "../persistence/Services/ManagerConnectors.ts";
import { ManagerAssistantService } from "./Services/AssistantService.ts";
import { handleManagerMcpMessage } from "./mcp.ts";
import { ManagerApprovalService } from "./Services/ManagerApprovalService.ts";
import { ManagerTokenAuthService } from "./Services/ManagerTokenAuth.ts";
import { ManagerToolService } from "./Services/ManagerToolService.ts";

const respondToAuthError = (error: AuthError) =>
  Effect.succeed(
    HttpServerResponse.jsonUnsafe({ error: error.message }, { status: error.status ?? 401 }),
  );

const respondUnauthorized = Effect.succeed(
  HttpServerResponse.jsonUnsafe({ error: "Unauthorized" }, { status: 401 }),
);

const respondServerError = (context: string) => (cause: unknown) =>
  Effect.logError(`manager http route failed: ${context}`, { cause }).pipe(
    Effect.as(HttpServerResponse.jsonUnsafe({ error: "Internal server error." }, { status: 500 })),
  );

const authenticateOwnerSession = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request);
  if (session.role !== "owner") {
    return yield* new AuthError({
      message: "Only owner sessions can manage the manager agent.",
      status: 403,
    });
  }
  return session;
});

export const managerMcpRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/mcp",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const tokenAuth = yield* ManagerTokenAuthService;
    const toolService = yield* ManagerToolService;

    const authOutcome = yield* tokenAuth.authenticate(request.headers["authorization"]).pipe(
      Effect.map((caller) => ({ kind: "caller" as const, caller })),
      Effect.catchTag("ManagerAuthError", () =>
        respondUnauthorized.pipe(
          Effect.map((response) => ({ kind: "response" as const, response })),
        ),
      ),
      Effect.catch((cause) =>
        respondServerError("mcp:authenticate")(cause).pipe(
          Effect.map((response) => ({ kind: "response" as const, response })),
        ),
      ),
    );
    if (authOutcome.kind === "response") {
      return authOutcome.response;
    }
    const caller = authOutcome.caller;

    const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    if (body === null) {
      return HttpServerResponse.jsonUnsafe(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
        { status: 400 },
      );
    }

    const outcome = yield* handleManagerMcpMessage(toolService, caller, body);
    if (outcome.kind === "accepted") {
      return HttpServerResponse.empty({ status: 202 });
    }
    return HttpServerResponse.jsonUnsafe(outcome.body, { status: 200 });
  }),
);

/**
 * Streamable-HTTP MCP clients may probe with GET (SSE) or DELETE (session
 * teardown). We serve JSON-only stateless responses, so both get a proper
 * 405 instead of falling through to the static-HTML catch-all — MCP clients
 * treat 405 as "no SSE offered" and proceed with plain POSTs.
 */
export const managerMcpGetRouteLayer = HttpRouter.add(
  "GET",
  "/api/manager/mcp",
  Effect.succeed(
    HttpServerResponse.jsonUnsafe(
      { error: "Method not allowed. POST JSON-RPC messages." },
      { status: 405, headers: { allow: "POST" } },
    ),
  ),
);

export const managerMcpDeleteRouteLayer = HttpRouter.add(
  "DELETE",
  "/api/manager/mcp",
  Effect.succeed(
    HttpServerResponse.jsonUnsafe(
      { error: "Stateless server: no session to delete." },
      { status: 405, headers: { allow: "POST" } },
    ),
  ),
);

export const managerProposalsRouteLayer = HttpRouter.add(
  "GET",
  "/api/manager/proposals",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const approvalService = yield* ManagerApprovalService;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const rawStatus =
      url._tag === "Some" ? (url.value.searchParams.get("status") ?? undefined) : undefined;
    const status =
      rawStatus === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(ManagerProposalStatus)(rawStatus).pipe(
            Effect.mapError(
              () => new AuthError({ message: "Invalid status filter.", status: 400 }),
            ),
          );
    return yield* approvalService.listAll({ status }).pipe(
      Effect.map((proposals) => HttpServerResponse.jsonUnsafe({ proposals }, { status: 200 })),
      Effect.catch(respondServerError("proposals:list")),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const managerProposalResolveRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/proposals/resolve",
  Effect.gen(function* () {
    const session = yield* authenticateOwnerSession;
    const approvalService = yield* ManagerApprovalService;
    const input = yield* HttpServerRequest.schemaBodyJson(ManagerOwnerResolveProposalInput).pipe(
      Effect.mapError(
        () => new AuthError({ message: "Invalid proposal resolution payload.", status: 400 }),
      ),
    );
    return yield* approvalService
      .resolve({
        proposalId: input.proposalId,
        decision: input.decision,
        resolvedBy: `owner:${session.sessionId}`,
      })
      .pipe(
        Effect.map((proposal) => HttpServerResponse.jsonUnsafe({ proposal }, { status: 200 })),
        Effect.catchTags({
          ManagerNotFoundError: (error) =>
            Effect.succeed(
              HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 404 }),
            ),
          ManagerProposalResolutionError: (error) =>
            Effect.succeed(
              HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 409 }),
            ),
          ManagerExecutionError: (error) =>
            Effect.succeed(
              HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 502 }),
            ),
        }),
        Effect.catch(respondServerError("proposals:resolve")),
      );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const managerAssistantsListRouteLayer = HttpRouter.add(
  "GET",
  "/api/manager/assistants",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const assistants = yield* ManagerAssistantService;
    return yield* assistants.listAssistants().pipe(
      Effect.map((list) => HttpServerResponse.jsonUnsafe({ assistants: list }, { status: 200 })),
      Effect.catch(respondServerError("assistants:list")),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const managerAssistantsCreateRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/assistants",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const assistants = yield* ManagerAssistantService;
    const input = yield* HttpServerRequest.schemaBodyJson(ManagerCreateAssistantInput).pipe(
      Effect.mapError(() => new AuthError({ message: "Invalid assistant payload.", status: 400 })),
    );
    return yield* assistants.createAssistant({ name: input.name }).pipe(
      Effect.map((result) => HttpServerResponse.jsonUnsafe(result, { status: 201 })),
      Effect.catch(respondServerError("assistants:create")),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

const assistantProjectIdFromQuery = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  const raw = url._tag === "Some" ? url.value.searchParams.get("projectId") : null;
  const trimmed = raw?.trim() ?? "";
  if (trimmed.length === 0) {
    return yield* new AuthError({ message: "projectId query param is required.", status: 400 });
  }
  return ProjectId.make(trimmed);
});

export const managerAssistantOverviewRouteLayer = HttpRouter.add(
  "GET",
  "/api/manager/assistant",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const assistants = yield* ManagerAssistantService;
    const projectId = yield* assistantProjectIdFromQuery;
    return yield* assistants.getAssistant(projectId).pipe(
      Effect.map((assistant) => HttpServerResponse.jsonUnsafe(assistant, { status: 200 })),
      Effect.catch(respondServerError("assistant:overview")),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

const AccessPayload = Schema.Struct({
  projectId: ProjectId,
  projectAllowlist: ManagerAssistantAccessInput.fields.projectAllowlist,
  scopes: ManagerAssistantAccessInput.fields.scopes,
  autoApprove: ManagerAssistantAccessInput.fields.autoApprove,
});

export const managerAssistantAccessRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/assistant/access",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const tokenRepository = yield* ManagerCapabilityTokenRepository;
    const input = yield* HttpServerRequest.schemaBodyJson(AccessPayload).pipe(
      Effect.mapError(() => new AuthError({ message: "Invalid access payload.", status: 400 })),
    );
    return yield* Effect.gen(function* () {
      const label = assistantTokenLabel(input.projectId);
      const token = yield* tokenRepository.getActiveByLabel(label);
      if (Option.isNone(token)) {
        return HttpServerResponse.jsonUnsafe(
          { error: "Assistant token is not bootstrapped yet; restart the environment." },
          { status: 409 },
        );
      }
      yield* tokenRepository.updateAccess({
        tokenId: token.value.tokenId,
        scopes: input.scopes ?? token.value.scopes,
        projectAllowlist: input.projectAllowlist,
        autoApprove: input.autoApprove ?? token.value.autoApprove,
      });
      const updated = yield* tokenRepository.getActiveByLabel(label);
      return HttpServerResponse.jsonUnsafe({ token: Option.getOrNull(updated) }, { status: 200 });
    }).pipe(Effect.catch(respondServerError("assistant:access")));
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

const TelegramConfigPayload = Schema.Struct({
  projectId: ProjectId,
  botToken: Schema.optional(Schema.String),
  allowedChatIds: Schema.Array(Schema.String),
  enabled: Schema.Boolean,
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  addressing: Schema.optional(ManagerConnectorAddressingConfig),
});

export const managerAssistantTelegramRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/assistant/telegram",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const connectorRepository = yield* ManagerConnectorRepository;
    const assistants = yield* ManagerAssistantService;
    const input = yield* HttpServerRequest.schemaBodyJson(TelegramConfigPayload).pipe(
      Effect.mapError(() => new AuthError({ message: "Invalid Telegram payload.", status: 400 })),
    );
    return yield* Effect.gen(function* () {
      const existing = yield* connectorRepository.get({
        projectId: input.projectId,
        kind: "telegram",
      });
      const existingConfig = Option.isSome(existing)
        ? Schema.decodeUnknownExit(ManagerTelegramConnectorConfig)(existing.value.config)
        : null;
      const previousToken =
        existingConfig !== null && existingConfig._tag === "Success"
          ? existingConfig.value.botToken
          : undefined;
      const botToken = input.botToken?.trim() || previousToken;
      if (botToken === undefined || botToken.length === 0) {
        return HttpServerResponse.jsonUnsafe(
          { error: "Bot token is required for the first setup." },
          { status: 400 },
        );
      }
      const previousModelSelection =
        existingConfig !== null && existingConfig._tag === "Success"
          ? (existingConfig.value.defaultModelSelection ?? null)
          : null;
      // Preserve the addressing block across saves that don't touch it (the
      // settings UI may PUT before it learns to send this field).
      const previousAddressing =
        existingConfig !== null && existingConfig._tag === "Success"
          ? existingConfig.value.addressing
          : undefined;
      const mergedAddressing = input.addressing ?? previousAddressing;
      const config = {
        botToken,
        allowedChatIds: input.allowedChatIds
          .map((chatId) => chatId.trim())
          .filter((chatId) => chatId.length > 0),
        enabled: input.enabled,
        defaultModelSelection:
          input.defaultModelSelection !== undefined
            ? input.defaultModelSelection
            : previousModelSelection,
        ...(mergedAddressing !== undefined ? { addressing: mergedAddressing } : {}),
      } satisfies ManagerTelegramConnectorConfig;
      yield* connectorRepository.upsert({
        projectId: input.projectId,
        kind: "telegram",
        config,
        updatedAt: new Date().toISOString(),
      });
      const assistant = yield* assistants.getAssistant(input.projectId);
      return HttpServerResponse.jsonUnsafe({ telegram: assistant.telegram }, { status: 200 });
    }).pipe(Effect.catch(respondServerError("assistant:telegram")));
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

const SlackConfigPayload = Schema.Struct({
  projectId: ProjectId,
  botToken: Schema.optional(Schema.String),
  appToken: Schema.optional(Schema.String),
  allowedChannelIds: Schema.Array(Schema.String),
  enabled: Schema.Boolean,
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  addressing: Schema.optional(ManagerConnectorAddressingConfig),
});

export const managerAssistantSlackRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/assistant/slack",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const connectorRepository = yield* ManagerConnectorRepository;
    const assistants = yield* ManagerAssistantService;
    const input = yield* HttpServerRequest.schemaBodyJson(SlackConfigPayload).pipe(
      Effect.mapError(() => new AuthError({ message: "Invalid Slack payload.", status: 400 })),
    );
    return yield* Effect.gen(function* () {
      const existing = yield* connectorRepository.get({
        projectId: input.projectId,
        kind: "slack",
      });
      const existingDecoded = Option.isSome(existing)
        ? Schema.decodeUnknownExit(ManagerSlackConnectorConfig)(existing.value.config)
        : null;
      const existingConfig =
        existingDecoded !== null && existingDecoded._tag === "Success"
          ? existingDecoded.value
          : null;
      // Both tokens are optional on update (keep the stored ones), required first time.
      const botToken = input.botToken?.trim() || existingConfig?.botToken;
      const appToken = input.appToken?.trim() || existingConfig?.appToken;
      if (
        botToken === undefined ||
        botToken.length === 0 ||
        appToken === undefined ||
        appToken.length === 0
      ) {
        return HttpServerResponse.jsonUnsafe(
          { error: "Both a bot token (xoxb-…) and an app token (xapp-…) are required for setup." },
          { status: 400 },
        );
      }
      const mergedAddressing = input.addressing ?? existingConfig?.addressing;
      const config = {
        botToken,
        appToken,
        allowedChannelIds: input.allowedChannelIds
          .map((channelId) => channelId.trim())
          .filter((channelId) => channelId.length > 0),
        enabled: input.enabled,
        defaultModelSelection:
          input.defaultModelSelection !== undefined
            ? input.defaultModelSelection
            : (existingConfig?.defaultModelSelection ?? null),
        ...(mergedAddressing !== undefined ? { addressing: mergedAddressing } : {}),
      } satisfies ManagerSlackConnectorConfig;
      yield* connectorRepository.upsert({
        projectId: input.projectId,
        kind: "slack",
        config,
        updatedAt: new Date().toISOString(),
      });
      const assistant = yield* assistants.getAssistant(input.projectId);
      return HttpServerResponse.jsonUnsafe({ slack: assistant.slack }, { status: 200 });
    }).pipe(Effect.catch(respondServerError("assistant:slack")));
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

const FilePayload = Schema.Struct({
  projectId: ProjectId,
  name: AssistantEditableFileName,
  content: Schema.String,
});

export const managerAssistantFileReadRouteLayer = HttpRouter.add(
  "GET",
  "/api/manager/assistant/file",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const assistants = yield* ManagerAssistantService;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const projectId = yield* assistantProjectIdFromQuery;
    const url = HttpServerRequest.toURL(request);
    const rawName = url._tag === "Some" ? (url.value.searchParams.get("name") ?? "") : "";
    const name = yield* Schema.decodeUnknownEffect(AssistantEditableFileName)(rawName).pipe(
      Effect.mapError(() => new AuthError({ message: "Unsupported file name.", status: 400 })),
    );
    return yield* assistants.readWorkspaceFile({ projectId, name }).pipe(
      Effect.map((result) => HttpServerResponse.jsonUnsafe(result, { status: 200 })),
      Effect.catch(respondServerError("assistant:file-read")),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const managerAssistantFileWriteRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/assistant/file",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const assistants = yield* ManagerAssistantService;
    const input = yield* HttpServerRequest.schemaBodyJson(FilePayload).pipe(
      Effect.mapError(() => new AuthError({ message: "Invalid file payload.", status: 400 })),
    );
    return yield* assistants.writeWorkspaceFile(input).pipe(
      Effect.map(() => HttpServerResponse.jsonUnsafe({ saved: true }, { status: 200 })),
      Effect.catch(respondServerError("assistant:file-write")),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const managerTokensListRouteLayer = HttpRouter.add(
  "GET",
  "/api/manager/tokens",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const tokenAuth = yield* ManagerTokenAuthService;
    return yield* tokenAuth.listTokens().pipe(
      Effect.map((tokens) => HttpServerResponse.jsonUnsafe({ tokens }, { status: 200 })),
      Effect.catch(respondServerError("tokens:list")),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const managerTokensCreateRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/tokens",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const tokenAuth = yield* ManagerTokenAuthService;
    const input = yield* HttpServerRequest.schemaBodyJson(ManagerCreateTokenInput).pipe(
      Effect.mapError(() => new AuthError({ message: "Invalid token payload.", status: 400 })),
    );
    // The plaintext token is returned exactly once, here.
    return yield* tokenAuth.issueToken(input).pipe(
      Effect.map((result) => HttpServerResponse.jsonUnsafe(result, { status: 201 })),
      Effect.catch(respondServerError("tokens:create")),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const managerTokensRevokeRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/tokens/revoke",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const tokenAuth = yield* ManagerTokenAuthService;
    const input = yield* HttpServerRequest.schemaBodyJson(
      Schema.Struct({ tokenId: ManagerTokenId }),
    ).pipe(
      Effect.mapError(() => new AuthError({ message: "Invalid revoke payload.", status: 400 })),
    );
    return yield* tokenAuth.revokeToken(input.tokenId).pipe(
      Effect.map((revoked) =>
        revoked
          ? HttpServerResponse.jsonUnsafe({ revoked: true }, { status: 200 })
          : HttpServerResponse.jsonUnsafe(
              { error: "Unknown or already revoked token." },
              {
                status: 404,
              },
            ),
      ),
      Effect.catch(respondServerError("tokens:revoke")),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);
