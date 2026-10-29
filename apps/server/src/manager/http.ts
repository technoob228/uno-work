/**
 * HTTP surface of the manager tool layer:
 *
 * - `POST /api/manager/mcp` — stateless MCP endpoint for the manager brain.
 *   Authenticated with a manager capability token (`Authorization: Bearer`),
 *   never with user sessions. This is the ONLY route a manager token opens.
 * - `/api/manager/proposals*`, `/api/manager/tokens*` — owner-session-only
 *   management: list/resolve proposals, issue/list/revoke tokens.
 * - `/api/manager/connector-bindings*` — owner-session-only: which chat of
 *   an assistant's connector talks to which target (ADR 2026-09-11).
 * - `/api/manager/assistant/telegram/shared`, `/api/manager/assistant/slack/install`
 *   — owner-session-only: Uno's shared Telegram bot / Slack app on a cloud
 *   computer (onboarding v3, `channelSetup.ts`).
 * - `POST /api/channels/notify` — outbound message to the chats bound to a
 *   thread / project. Authenticated with the browser-bridge token every
 *   harness process holds (a thread-scoped token implies the thread).
 */
import {
  UNO_GATEWAY_BASE_URL,
  ASSISTANT_PROJECT_ID,
  AssistantAppAccessInput,
  AssistantAvatarGenerateInput,
  AssistantAvatarSetInput,
  AssistantEditableFileName,
  AssistantInstructionsResolveInput,
  AssistantPresetInput,
  AssistantRevokeInput,
  AssistantTeamUpdateInput,
  assistantTokenLabel,
  CHANNEL_NOTIFY_PATH,
  ChannelNotifyInput,
  isAssistantProjectId,
  ManagerAssistantAccessInput,
  ManagerAssistantTurnInput,
  MANAGER_CALLER_THREAD_HEADER,
  ManagerConnectorBindingRemoveInput,
  ManagerConnectorBindingUpsertInput,
  ManagerCreateAssistantInput,
  type ManagerAssistantsList,
  ManagerCreateTokenInput,
  ManagerOwnerResolveProposalInput,
  ManagerProposalStatus,
  ManagerConnectorAddressingConfig,
  ManagerConnectorGroupMembersPolicy,
  ManagerSlackConnectorConfig,
  ManagerTelegramConnectorConfig,
  ManagerTokenId,
  ModelSelection,
  ProjectId,
  ThreadId,
  type ManagerConnectorBinding,
  type ManagerConnectorBindingView,
} from "@t3tools/contracts";
import { Data, Effect, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";

import { isDirectLocalRequest } from "../auth/loopbackPeer.ts";
import { ServerAuth, AuthError } from "../auth/Services/ServerAuth.ts";
import {
  authorizeLocalBridgeRequest,
  BrowserBridge,
  requireBridgeThread,
} from "../browserBridge.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagerCapabilityTokenRepository } from "../persistence/Services/ManagerCapabilityTokens.ts";
import { ManagerConnectorBindingRepository } from "../persistence/Services/ManagerConnectorBindings.ts";
import { ManagerConnectorRepository } from "../persistence/Services/ManagerConnectors.ts";
import { bindingTargetLabel } from "./connectorBindings.ts";
import { resolveConnectorOutgoingFile } from "./connectorOutgoingFiles.ts";
import { queueOutgoingFile } from "./outgoingFileQueue.ts";
import { AssistantPushService } from "./Services/AssistantPush.ts";
import { capToolResultBody } from "../mcp/capToolResult.ts";
import { makeThreadSendableRoots } from "./threadSendableRoots.ts";
import { TELEGRAM_BOT_UPLOAD_LIMIT_BYTES } from "./telegramMedia.ts";
import { assistantAccessDepsOption } from "../assistants/assistantAccess.ts";
import { resolveNotifyThreadId } from "./connectorNotify.ts";
import { ManagerAssistantError, ManagerAssistantService } from "./Services/AssistantService.ts";
import { ManagerTelegramService } from "./Layers/TelegramConnector.ts";
import { ManagerSlackService } from "./Layers/SlackConnector.ts";
import { telegramPairingLink } from "./telegramPairing.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { isRelayCredential, isRouteCredential } from "./channelRelay.ts";
import {
  afterTelegramConfigSaved,
  connectSharedTelegram,
  readSlackInstall,
  assignSlackChannelsFor,
  isRoutedSlack,
  routeSlackThroughHolder,
  slackRelayHolderFor,
  startSlackInstall,
  verifyTelegramBotToken,
  uninstallSlack,
  type ChannelSetupOutcome,
} from "./channelSetup.ts";
import { readWorkMachineIdentity } from "./workConsole.ts";
import { ConnectorNotifyService } from "./Services/ConnectorNotify.ts";
import { AssistantScheduledTurns } from "../assistants/scheduledTurn.ts";
import {
  readAppAccess,
  readStartedChats,
  writeAppAccess,
} from "../assistants/localAssistantStore.ts";
import { applyAssistantAccess } from "../assistants/assistantAccess.ts";
import { realignAssistantThreadModes } from "../assistants/assistantThreadModes.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  assistantSandboxAvailable,
  requireAssistantSandboxForProjects,
} from "../assistants/assistantSandboxPolicy.ts";
import {
  assistantOwnRuntimeMode,
  presetTokenAccess,
  withOwnWorkspace,
} from "@t3tools/shared/assistantPreset";
import { assistantsMvpEnabled } from "../assistants/assistantsFeature.ts";
import {
  AVATAR_CONTENT_TYPE,
  avatarFormat,
  checkAvatarImage,
  clearAvatar,
  personaPrompt,
  readAvatar,
  saveAvatar,
} from "../assistants/assistantAvatar.ts";
import { requestGatewayImage } from "../assistants/imageGenerate.ts";
import { ServerConfig } from "../config.ts";
import { assistantMailView } from "../assistants/assistantMailView.ts";
import { readMailLedger } from "../assistants/mailLedger.ts";
import { readTeam } from "../assistants/teamStore.ts";
import { AgentMailService } from "../setupTools/AgentMailService.ts";
import { UnoCloudService } from "../workspaceRegistry/UnoCloudService.ts";
import { AssistantSchedules, assistantProjectOfCaller } from "../assistants/schedules.ts";
import { AutomationsService } from "../automations/AutomationsService.ts";
import {
  AssistantTeam,
  type AssistantTeamError,
  type AssistantTeamShape,
} from "../assistants/assistantTeam.ts";
import {
  buildAssistantChats,
  fetchGatewayThreadUsage,
  selectAssistantChats,
  tokensFromActivities,
} from "../assistants/assistantChats.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { UnoGatewayKey } from "../unoGatewayKey.ts";
import { handleManagerMcpMessage } from "./mcp.ts";
import { ManagerApprovalService } from "./Services/ManagerApprovalService.ts";
import { ManagerTokenAuthService } from "./Services/ManagerTokenAuth.ts";
import { ManagerToolService, type ManagerCaller } from "./Services/ManagerToolService.ts";
import { isAssistantConversationThread } from "./assistantPush.ts";

export const respondToAuthError = (error: AuthError) =>
  Effect.succeed(
    HttpServerResponse.jsonUnsafe({ error: error.message }, { status: error.status ?? 401 }),
  );

const respondUnauthorized = Effect.succeed(
  HttpServerResponse.jsonUnsafe({ error: "Unauthorized" }, { status: 401 }),
);

export const respondServerError = (context: string) => (cause: unknown) =>
  Effect.logError(`manager http route failed: ${context}`, { cause }).pipe(
    Effect.as(HttpServerResponse.jsonUnsafe({ error: "Internal server error." }, { status: 500 })),
  );

export const authenticateOwnerSession = Effect.gen(function* () {
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

/** The header's thread when it is a conversation of the caller's own assistant. */
const resolveCallerConversation = (caller: ManagerCaller, header: string | undefined) =>
  Effect.gen(function* () {
    const assistant = assistantProjectOfCaller(caller);
    const raw = header?.trim() ?? "";
    if (assistant === null || raw.length === 0 || raw.length > 128) return null;
    const projections = yield* ProjectionSnapshotQuery;
    const shell = yield* projections
      .getThreadShellById(ThreadId.make(raw))
      .pipe(Effect.orElseSucceed(() => Option.none()));
    return Option.isSome(shell) &&
      shell.value.projectId === assistant &&
      isAssistantConversationThread(shell.value)
      ? shell.value.id
      : null;
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
    // An assistant's own token serves only the agents on this machine
    // (.mcp.json points them at 127.0.0.1). Every Work machine cloned from
    // one memory snapshot started with the same assistant token (16.10): over
    // the machine's public address it opened create_thread/send_turn on
    // someone else's computer. External tokens (Settings) stay reachable.
    if (caller.label?.startsWith(assistantTokenLabel("")) && !isDirectLocalRequest(request)) {
      return yield* respondUnauthorized;
    }
    // Which of the assistant's conversations calls (HermesAdapter adds the
    // header): only one of its own counts, anything else is ignored.
    const callerThreadId = yield* resolveCallerConversation(
      caller,
      request.headers[MANAGER_CALLER_THREAD_HEADER],
    );
    const callerWithThread = callerThreadId === null ? caller : { ...caller, callerThreadId };

    const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    if (body === null) {
      return HttpServerResponse.jsonUnsafe(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
        { status: 400 },
      );
    }

    const schedules = Option.getOrUndefined(yield* Effect.serviceOption(AssistantSchedules));
    // Schedules live in the console's assistants: offered only where the
    // account has them (unit wiring without settings: offered).
    const settingsService = Option.getOrUndefined(
      yield* Effect.serviceOption(ServerSettingsService),
    );
    const assistantsEnabled = settingsService
      ? yield* settingsService.getSettings.pipe(
          Effect.flatMap((settings) => Effect.promise(() => assistantsMvpEnabled(settings))),
          Effect.orElseSucceed(() => false),
        )
      : true;
    const team = Option.getOrUndefined(yield* Effect.serviceOption(AssistantTeam));
    const automations = Option.getOrUndefined(yield* Effect.serviceOption(AutomationsService));
    const projections = yield* ProjectionSnapshotQuery;
    // The notes_* tools: the folder of the token's own assistant, never one
    // the model names.
    const assistantWorkspace = (who: ManagerCaller) => {
      const projectId = assistantProjectOfCaller(who);
      if (projectId === null) return Effect.succeed(null);
      return projections.getProjectShellById(projectId).pipe(
        Effect.map((shell) => (Option.isSome(shell) ? shell.value.workspaceRoot : null)),
        Effect.orElseSucceed(() => null),
      );
    };
    // send_file: to the Telegram / Slack chat the caller's current turn
    // answers, from the folders that conversation may send from.
    const push = Option.getOrUndefined(yield* Effect.serviceOption(AssistantPushService));
    const sendableRootsOf = makeThreadSendableRoots({
      projections,
      home: os.homedir(),
      access: yield* assistantAccessDepsOption,
    });
    const sendFile = (who: ManagerCaller, rawPath: string) =>
      Effect.gen(function* () {
        const conversation = who.callerThreadId;
        if (conversation === undefined || push === undefined) {
          return { ok: false as const, error: SEND_FILE_NO_CHAT };
        }
        const chat = yield* push.chatOf(ThreadId.make(conversation));
        if (chat === null) return { ok: false as const, error: SEND_FILE_NO_CHAT };
        const roots = yield* sendableRootsOf(ThreadId.make(conversation));
        const resolved = yield* Effect.promise(() =>
          resolveConnectorOutgoingFile(rawPath, roots, os.homedir()),
        );
        if (!resolved.ok) return { ok: false as const, error: `Not sent: ${resolved.reason}.` };
        const size = yield* Effect.promise(() =>
          fsPromises.stat(resolved.path).then(
            (stat) => stat.size,
            () => 0,
          ),
        );
        const limit =
          chat.kind === "telegram" ? TELEGRAM_BOT_UPLOAD_LIMIT_BYTES : SLACK_UPLOAD_LIMIT_BYTES;
        if (size > limit) {
          return {
            ok: false as const,
            error: `Not sent: ${Math.round(size / 1024 / 1024)} MB is over ${chat.kind === "telegram" ? "Telegram's 50 MB bot limit" : "the upload limit"} — give the person a link instead (file_share_link in a chat, or Uno Drive).`,
          };
        }
        if (!queueOutgoingFile(conversation, resolved.path)) {
          return { ok: false as const, error: "Not sent: too many files wait already." };
        }
        return {
          ok: true as const,
          value: {
            queued: nodePath.basename(resolved.path),
            to: chat.kind,
            note: "It goes with your answer of this turn. Say in one short line what it is.",
          },
        };
      });
    const outcome = yield* handleManagerMcpMessage(
      toolService,
      callerWithThread,
      body,
      {
        ...(schedules ? { schedules } : {}),
        ...(team ? { team } : {}),
        ...(automations ? { automations } : {}),
        assistantWorkspace,
        sendFile,
      },
      { assistantsEnabled },
    );
    if (outcome.kind === "accepted") {
      return HttpServerResponse.empty({ status: 202 });
    }
    // The Uno dispatcher keeps every result in its context: long ones cut.
    const dispatcher = assistantProjectOfCaller(callerWithThread) === ASSISTANT_PROJECT_ID;
    return HttpServerResponse.jsonUnsafe(
      dispatcher ? capToolResultBody(outcome.body) : outcome.body,
      { status: 200 },
    );
  }),
);

const SEND_FILE_NO_CHAT =
  "The person isn't writing from Telegram or Slack in this turn: give them the file's path (it opens in Uno Work) instead.";
/** Slack's own cap is 1 GB; above this a link is kinder. */
const SLACK_UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024;

/**
 * `uno-work assistant-turn` (the CLI a console schedule runs after waking the
 * computer): one turn of the token's assistant, answered to its chats. The
 * assistant comes from the token (`assistant:<projectId>`), never the body.
 * Blocks until the answer (or the timeout): the console puts the computer
 * back to sleep as soon as the command exits.
 */
export const managerAssistantScheduledTurnRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/assistant/scheduled-turn",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    // Only an assistant's own token runs a turn, and that token serves only
    // the CLI on this machine (127.0.0.1 from the assistant's .mcp.json). From
    // the internet a matching token proves nothing: snapshot clones before
    // 0.0.139 shared one (16.10), and this route is not behind the edge block.
    if (!isDirectLocalRequest(request)) {
      return yield* respondUnauthorized;
    }
    const tokenAuth = yield* ManagerTokenAuthService;
    const caller = yield* tokenAuth
      .authenticate(request.headers["authorization"])
      .pipe(Effect.option);
    if (Option.isNone(caller)) {
      return yield* respondUnauthorized;
    }
    const turns = yield* Effect.serviceOption(AssistantScheduledTurns);
    if (Option.isNone(turns)) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Scheduled turns are not available in this Uno Work." },
        { status: 501 },
      );
    }
    const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    const input = Schema.decodeUnknownOption(ManagerAssistantTurnInput)(body);
    if (Option.isNone(input)) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Expected {prompt, name?, timeoutSec?}." },
        { status: 400 },
      );
    }
    return yield* turns.value.run(caller.value, input.value).pipe(
      Effect.map((result) => HttpServerResponse.jsonUnsafe(result, { status: 200 })),
      Effect.catch((error) =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({ error: error.message }, { status: error.status }),
        ),
      ),
    );
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
    const team = yield* Effect.serviceOption(AssistantTeam);
    return yield* assistants.listAssistants().pipe(
      // Who each one is on the team (face, role, setup, who set it up, app levels).
      Effect.flatMap((list) =>
        Option.isNone(team)
          ? Effect.succeed(list)
          : team.value.views(list.map((item) => item.projectId)).pipe(
              Effect.map((views) =>
                list.map((item) => {
                  const view = views.get(item.projectId);
                  return view === undefined ? item : { ...item, team: view };
                }),
              ),
            ),
      ),
      // Whether "Only selected projects" can be held here (the assistant sandbox).
      Effect.flatMap((list) =>
        Effect.gen(function* () {
          const assistantSandbox = yield* assistantSandboxAvailable;
          // Whether the account has assistants, by this computer's own key.
          const settings = yield* Effect.serviceOption(ServerSettingsService);
          const assistantsEnabled = Option.isSome(settings)
            ? yield* settings.value.getSettings.pipe(
                Effect.flatMap((current) => Effect.promise(() => assistantsMvpEnabled(current))),
                Effect.orElseSucceed(() => false),
              )
            : false;
          return HttpServerResponse.jsonUnsafe(
            {
              assistants: list,
              assistantSandbox,
              assistantsEnabled,
            } satisfies ManagerAssistantsList,
            { status: 200 },
          );
        }),
      ),
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
    yield* requireAssistantSandboxForProjects(
      input.access?.projects ?? "all",
      (message) => new AuthError({ message, status: 403 }),
    );
    return yield* assistants
      .createAssistant({
        name: input.name,
        ...(input.emoji !== undefined ? { emoji: input.emoji } : {}),
        ...(input.template !== undefined ? { template: input.template } : {}),
        ...(input.access !== undefined ? { access: input.access } : {}),
      })
      .pipe(
        Effect.map((result) => HttpServerResponse.jsonUnsafe(result, { status: 201 })),
        Effect.catch(respondServerError("assistants:create")),
      );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/**
 * THE assistant chat ("Uno"): found, or set up now (the same migration the
 * daemon runs on start). Clients call it when the pinned chat is missing.
 */
const AssistantChatPayload = Schema.Struct({ projectId: Schema.optional(ProjectId) });

export const managerAssistantChatRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/assistant/chat",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const assistants = yield* ManagerAssistantService;
    const input = yield* HttpServerRequest.schemaBodyJson(AssistantChatPayload).pipe(
      Effect.orElseSucceed(() => ({ projectId: undefined })),
    );
    // Another assistant of this computer: its latest conversation (0.0.106).
    if (input.projectId !== undefined && input.projectId !== ASSISTANT_PROJECT_ID) {
      return yield* assistants.ensureConversation(input.projectId).pipe(
        Effect.map((result) => HttpServerResponse.jsonUnsafe(result, { status: 200 })),
        Effect.catch((cause) =>
          Schema.is(ManagerAssistantError)(cause)
            ? Effect.succeed(
                HttpServerResponse.jsonUnsafe({ error: cause.detail }, { status: 404 }),
              )
            : respondServerError("assistants:chat")(cause),
        ),
      );
    }
    return yield* assistants.ensureAssistantChat().pipe(
      Effect.map((result) => HttpServerResponse.jsonUnsafe(result, { status: 200 })),
      Effect.catch(respondServerError("assistants:chat")),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

const ConversationCreatePayload = Schema.Struct({
  title: Schema.optional(Schema.String),
  projectId: Schema.optional(ProjectId),
});

/**
 * `POST /api/manager/assistant/conversations` — "New conversation" with Uno
 * (0.0.85): another chat in the assistant's workspace, on its engine.
 */
export const managerAssistantConversationCreateRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/assistant/conversations",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const assistants = yield* ManagerAssistantService;
    const input = yield* HttpServerRequest.schemaBodyJson(ConversationCreatePayload).pipe(
      Effect.orElseSucceed(() => ({ title: undefined, projectId: undefined })),
    );
    return yield* assistants
      .createConversation({ title: input.title, projectId: input.projectId })
      .pipe(
        Effect.map((result) => HttpServerResponse.jsonUnsafe(result, { status: 200 })),
        Effect.catch((cause) =>
          Schema.is(ManagerAssistantError)(cause)
            ? Effect.succeed(
                HttpServerResponse.jsonUnsafe({ error: cause.detail }, { status: 409 }),
              )
            : respondServerError("assistant:conversation")(cause),
        ),
      );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

const TelegramProjectPayload = Schema.Struct({ projectId: ProjectId });

/**
 * `POST /api/manager/assistant/telegram/pair` — a one-time code for the
 * bot's deep link (`https://t.me/<bot>?start=<code>`, telegramPairing.ts).
 */
export const managerAssistantTelegramPairRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/assistant/telegram/pair",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const telegram = yield* ManagerTelegramService;
    const input = yield* HttpServerRequest.schemaBodyJson(TelegramProjectPayload).pipe(
      Effect.mapError(() => new AuthError({ message: "Invalid pairing payload.", status: 400 })),
    );
    if (!isAssistantProjectId(input.projectId)) {
      return HttpServerResponse.jsonUnsafe(
        { error: "projectId must be an assistant project." },
        { status: 400 },
      );
    }
    return yield* telegram.startPairing(input.projectId).pipe(
      Effect.map((pairing) =>
        HttpServerResponse.jsonUnsafe(
          { ...pairing, link: telegramPairingLink(pairing.botUsername, pairing.code) },
          { status: 200 },
        ),
      ),
      // Shared-bot connector whose code the console did not take.
      Effect.catchTag("TelegramPairingError", (error) =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { error: "console_error", message: error.message },
            { status: 502 },
          ),
        ),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/** This machine's console identity (machine token + box id), or null off a cloud computer. */
const currentWorkMachineIdentity = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
  return readWorkMachineIdentity(current?.uno);
});

const respondChannelSetup = <A>(outcome: ChannelSetupOutcome<A>) =>
  outcome.ok
    ? HttpServerResponse.jsonUnsafe(outcome.value, { status: 200 })
    : HttpServerResponse.jsonUnsafe(
        { error: outcome.failure.error, message: outcome.failure.message },
        { status: outcome.failure.status },
      );

const requireAssistantProject = (projectId: ProjectId) =>
  isAssistantProjectId(projectId)
    ? Effect.void
    : Effect.fail(
        new AuthError({ message: "projectId must be an assistant project.", status: 400 }),
      );

/**
 * `POST /api/manager/assistant/telegram/shared` {projectId} → {code,
 * expiresAt, botUsername, link}: switch the assistant's Telegram to Uno's
 * shared bot (a console relay) and issue a link code. 409
 * `not_cloud_computer` without a machine token, 409 `shared_bot_uno_only`
 * for an assistant other than Uno that is not on Uno's bot yet, 503
 * `shared_bot_unavailable`, 502 when the console fails.
 */
export const managerAssistantTelegramSharedRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/assistant/telegram/shared",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const input = yield* HttpServerRequest.schemaBodyJson(TelegramProjectPayload).pipe(
      Effect.mapError(() => new AuthError({ message: "Invalid payload.", status: 400 })),
    );
    yield* requireAssistantProject(input.projectId);
    const identity = yield* currentWorkMachineIdentity;
    return yield* connectSharedTelegram({ projectId: input.projectId, identity }).pipe(
      Effect.map(respondChannelSetup),
      Effect.catch(respondServerError("assistant:telegram-shared")),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

const SlackInstallPayload = Schema.Struct({ projectId: ProjectId });

/**
 * `POST /api/manager/assistant/slack/install` {projectId} → {available,
 * authorizeUrl}: where to send the person to add Uno's Slack app.
 */
export const managerAssistantSlackInstallStartRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/assistant/slack/install",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const input = yield* HttpServerRequest.schemaBodyJson(SlackInstallPayload).pipe(
      Effect.mapError(() => new AuthError({ message: "Invalid payload.", status: 400 })),
    );
    yield* requireAssistantProject(input.projectId);
    // One Uno app per workspace: a second assistant writes through it.
    const holder = yield* slackRelayHolderFor(input.projectId);
    if (holder !== null) {
      return yield* routeSlackThroughHolder({ projectId: input.projectId, holder }).pipe(
        Effect.map(() =>
          respondChannelSetup({ ok: true, value: { available: true, authorizeUrl: null } }),
        ),
        Effect.catch(respondServerError("assistant:slack-install")),
      );
    }
    const identity = yield* currentWorkMachineIdentity;
    return respondChannelSetup(yield* startSlackInstall({ identity }));
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/**
 * `GET /api/manager/assistant/slack/install?projectId=` → {available,
 * installed, teamName, botUserName, connected}. Once installed, switches the
 * assistant's Slack connector to the console relay.
 */
export const managerAssistantSlackInstallStatusRouteLayer = HttpRouter.add(
  "GET",
  "/api/manager/assistant/slack/install",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const projectId = yield* assistantProjectIdFromQuery;
    yield* requireAssistantProject(projectId);
    // Reading mints the relay: a second assistant of this computer routes
    // through the holder and sees the holder's installation.
    const holder = yield* slackRelayHolderFor(projectId);
    const identity = yield* currentWorkMachineIdentity;
    if (holder !== null) {
      return yield* routeSlackThroughHolder({ projectId, holder }).pipe(
        Effect.andThen(readSlackInstall({ projectId: holder, identity })),
        Effect.map(respondChannelSetup),
        Effect.catch(respondServerError("assistant:slack-install")),
      );
    }
    return yield* readSlackInstall({ projectId, identity }).pipe(
      Effect.map(respondChannelSetup),
      Effect.catch(respondServerError("assistant:slack-install")),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/**
 * `DELETE /api/manager/assistant/slack/install?projectId=` → {ok: true}:
 * remove Uno's app from the workspace and forget the relay-mode row.
 */
export const managerAssistantSlackInstallDeleteRouteLayer = HttpRouter.add(
  "DELETE",
  "/api/manager/assistant/slack/install",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const projectId = yield* assistantProjectIdFromQuery;
    yield* requireAssistantProject(projectId);
    // A routed assistant leaves Slack; the app stays for the others.
    if (yield* isRoutedSlack(projectId)) {
      const repository = yield* ManagerConnectorRepository;
      return yield* repository.remove({ projectId, kind: "slack" }).pipe(
        Effect.map(() => HttpServerResponse.jsonUnsafe({ ok: true }, { status: 200 })),
        Effect.catch(respondServerError("assistant:slack-uninstall")),
      );
    }
    const identity = yield* currentWorkMachineIdentity;
    return yield* uninstallSlack({ projectId, identity }).pipe(
      Effect.map(respondChannelSetup),
      Effect.catch(respondServerError("assistant:slack-uninstall")),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/** Text of the Settings / wizard "Send test message" button. */
export const TELEGRAM_TEST_MESSAGE =
  "Test message from Uno Work. If you see this, Telegram is connected: write here and Uno answers.";

/** `POST /api/manager/assistant/telegram/test` — a test message to every linked chat. */
export const managerAssistantTelegramTestRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/assistant/telegram/test",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const telegram = yield* ManagerTelegramService;
    const input = yield* HttpServerRequest.schemaBodyJson(TelegramProjectPayload).pipe(
      Effect.mapError(() => new AuthError({ message: "Invalid test payload.", status: 400 })),
    );
    if (!isAssistantProjectId(input.projectId)) {
      return HttpServerResponse.jsonUnsafe(
        { error: "projectId must be an assistant project." },
        { status: 400 },
      );
    }
    const results = yield* telegram.sendTestMessage({
      projectId: input.projectId,
      text: TELEGRAM_TEST_MESSAGE,
    });
    return HttpServerResponse.jsonUnsafe({ results }, { status: 200 });
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
    yield* requireAssistantSandboxForProjects(
      input.projectAllowlist,
      (message) => new AuthError({ message, status: 403 }),
    );
    const config = yield* ServerConfig;
    return yield* Effect.gen(function* () {
      const label = assistantTokenLabel(input.projectId);
      const token = yield* tokenRepository.getActiveByLabel(label);
      if (Option.isNone(token)) {
        return HttpServerResponse.jsonUnsafe(
          { error: "Assistant token is not bootstrapped yet; restart the environment." },
          { status: 409 },
        );
      }
      // Kept by the daemon too, so a re-issued token keeps it.
      const updated = yield* applyAssistantAccess(
        { tokens: tokenRepository, stateDir: config.stateDir },
        input.projectId,
        {
          scopes: input.scopes ?? token.value.scopes,
          // "Only these projects" never locks the assistant out of its own
          // workspace (its conversations, notes and skills live there).
          projectAllowlist: withOwnWorkspace(input.projectAllowlist, input.projectId),
          autoApprove: input.autoApprove ?? token.value.autoApprove,
        },
      );
      return HttpServerResponse.jsonUnsafe({ token: Option.getOrNull(updated) }, { status: 200 });
    }).pipe(Effect.catch(respondServerError("assistant:access")));
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/**
 * `POST /api/manager/assistant/preset` {projectId, preset, projects} — owner
 * session only. Rewrites the assistant's token to the preset (Full / Helper /
 * Observer) and the projects it works in; the daemon enforces it from the
 * assistant's next call, no restart. An assistant not set up yet gets it
 * with its first token.
 */
export const managerAssistantPresetRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/assistant/preset",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const tokenRepository = yield* ManagerCapabilityTokenRepository;
    const config = yield* ServerConfig;
    const projections = yield* ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngineService;
    const input = yield* HttpServerRequest.schemaBodyJson(AssistantPresetInput).pipe(
      Effect.mapError(() => new AuthError({ message: "Invalid preset payload.", status: 400 })),
    );
    yield* requireAssistantProject(input.projectId);
    yield* requireAssistantSandboxForProjects(
      input.projects,
      (message) => new AuthError({ message, status: 403 }),
    );
    return yield* Effect.gen(function* () {
      const updated = yield* applyAssistantAccess(
        { tokens: tokenRepository, stateDir: config.stateDir },
        input.projectId,
        presetTokenAccess(input.preset, input.projects, input.projectId),
      );
      yield* Effect.logInfo("assistant preset changed").pipe(
        Effect.annotateLogs({ projectId: input.projectId, preset: input.preset }),
      );
      // Its own chats follow the mode at once: "Cautious" narrows the
      // harness itself, not only the manager tools (Misha 23.10).
      yield* realignAssistantThreadModes(
        { projections, engine },
        input.projectId,
        assistantOwnRuntimeMode(input.preset),
      );
      // Decision 16.10: what it set up is cut to match, with "who lost what".
      const losses = yield* cascadeTeamRights(input.projectId);
      return HttpServerResponse.jsonUnsafe(
        { token: Option.getOrNull(updated), losses },
        { status: 200 },
      );
    }).pipe(Effect.catch(respondServerError("assistant:preset")));
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/** After the person changed an assistant's rights: cut what it set up to match. */
const cascadeTeamRights = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const team = yield* Effect.serviceOption(AssistantTeam);
    if (Option.isNone(team)) return [];
    return yield* team.value.rightsChanged(projectId);
  });

const respondTeamError = (error: AssistantTeamError) =>
  Effect.succeed(HttpServerResponse.jsonUnsafe({ error: error.message }, { status: error.status }));

const withTeamService = <A, E, R>(
  run: (team: AssistantTeamShape) => Effect.Effect<A, E, R>,
): Effect.Effect<A | HttpServerResponse.HttpServerResponse, E, R> =>
  Effect.gen(function* () {
    const team = yield* Effect.serviceOption(AssistantTeam);
    if (Option.isNone(team)) {
      return HttpServerResponse.jsonUnsafe(
        { error: "The team of assistants is not available in this Uno Work." },
        { status: 501 },
      );
    }
    return yield* run(team.value);
  });

/**
 * `POST /api/manager/assistant/team` — the person edits who an assistant is
 * (name, face, role, character, where it talks, setup done / again).
 */
export const managerAssistantTeamUpdateRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/assistant/team",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const input = yield* HttpServerRequest.schemaBodyJson(AssistantTeamUpdateInput).pipe(
      Effect.mapError(() => new AuthError({ message: "Invalid team payload.", status: 400 })),
    );
    yield* requireAssistantProject(input.projectId);
    return yield* withTeamService((team) =>
      team.update(input).pipe(
        Effect.map((result) => HttpServerResponse.jsonUnsafe({ team: result }, { status: 200 })),
        Effect.catch(respondTeamError),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/**
 * `POST /api/manager/assistant/revoke` {projectId, revoked} — revoking takes
 * every assistant it set up along (decision 14.10); bringing back is one at
 * a time, within its creator's rights.
 */
export const managerAssistantRevokeRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/assistant/revoke",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const input = yield* HttpServerRequest.schemaBodyJson(AssistantRevokeInput).pipe(
      Effect.mapError(() => new AuthError({ message: "Invalid revoke payload.", status: 400 })),
    );
    yield* requireAssistantProject(input.projectId);
    return yield* withTeamService((team) =>
      team.revoke(input).pipe(
        Effect.map((result) => HttpServerResponse.jsonUnsafe(result, { status: 200 })),
        Effect.catch(respondTeamError),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/**
 * `POST /api/manager/assistants/:projectId/setup-chat` — the assistant sets
 * itself up in a chat (Misha 16.10): a conversation that starts with its
 * first question, or the setup chat already open (it goes on from there).
 */
export const managerAssistantSetupChatRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/assistants/:projectId/setup-chat",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const params = yield* HttpRouter.params;
    const raw = params.projectId?.trim() ?? "";
    if (!isAssistantProjectId(raw)) {
      return yield* new AuthError({ message: "Not an assistant.", status: 400 });
    }
    const projectId = ProjectId.make(raw);
    yield* requireAssistantProject(projectId);
    return yield* withTeamService((team) =>
      team.startSetupChat(projectId).pipe(
        Effect.map((result) => HttpServerResponse.jsonUnsafe(result, { status: 200 })),
        Effect.catch(respondTeamError),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

const TelegramConfigPayload = Schema.Struct({
  projectId: ProjectId,
  botToken: Schema.optional(Schema.String),
  allowedChatIds: Schema.Array(Schema.String),
  enabled: Schema.Boolean,
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  addressing: Schema.optional(ManagerConnectorAddressingConfig),
  groupMembers: Schema.optional(ManagerConnectorGroupMembersPolicy),
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
      // Relay credentials are minted by `/telegram/shared`, never typed in.
      if (
        input.botToken !== undefined &&
        (isRelayCredential(input.botToken.trim()) || isRouteCredential(input.botToken.trim()))
      ) {
        return HttpServerResponse.jsonUnsafe(
          { error: "Paste the token @BotFather gave you." },
          { status: 400 },
        );
      }
      const botToken = input.botToken?.trim() || previousToken;
      if (botToken === undefined || botToken.length === 0) {
        return HttpServerResponse.jsonUnsafe(
          { error: "Bot token is required for the first setup." },
          { status: 400 },
        );
      }
      // A new own-bot token: Telegram must know it (getMe) before it is kept.
      const typedToken = input.botToken?.trim() ?? "";
      if (typedToken.length > 0 && typedToken !== previousToken) {
        const verified = yield* verifyTelegramBotToken(typedToken);
        if (!verified.ok && verified.rejected) {
          return HttpServerResponse.jsonUnsafe({ error: verified.message }, { status: 400 });
        }
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
      const previousSuccess =
        existingConfig !== null && existingConfig._tag === "Success" ? existingConfig.value : null;
      // Owners are recorded by the daemon (linking by code); the settings
      // form never sends them, so they survive every save.
      const ownerUserIds = previousSuccess?.ownerUserIds;
      const groupMembers = input.groupMembers ?? previousSuccess?.groupMembers;
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
        ...(ownerUserIds !== undefined ? { ownerUserIds } : {}),
        ...(groupMembers !== undefined ? { groupMembers } : {}),
      } satisfies ManagerTelegramConnectorConfig;
      yield* connectorRepository.upsert({
        projectId: input.projectId,
        kind: "telegram",
        config,
        updatedAt: new Date().toISOString(),
      });
      // Shared bot: unlink removed chats at the console / drop the relay
      // when the owner switched to an own bot.
      yield* afterTelegramConfigSaved({
        previous:
          existingConfig !== null && existingConfig._tag === "Success"
            ? existingConfig.value
            : null,
        next: config,
        identity: yield* currentWorkMachineIdentity,
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
  groupMembers: Schema.optional(ManagerConnectorGroupMembersPolicy),
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
      // Relay credentials come from "Add to Slack", never typed in.
      if (
        (input.botToken !== undefined && isRelayCredential(input.botToken.trim())) ||
        input.appToken?.trim() === "unorelay"
      ) {
        return HttpServerResponse.jsonUnsafe(
          { error: "Paste the bot token (xoxb-…) and app token (xapp-…) of your Slack app." },
          { status: 400 },
        );
      }
      // Both tokens are optional on update (keep the stored ones), required
      // first time — and when leaving Uno's Slack app for an own app: a relay
      // row's stored tokens never mix with typed ones.
      const suppliesToken =
        (input.botToken?.trim() ?? "").length > 0 || (input.appToken?.trim() ?? "").length > 0;
      const reusable =
        existingConfig !== null && isRelayCredential(existingConfig.botToken) && suppliesToken
          ? null
          : existingConfig;
      const botToken = input.botToken?.trim() || reusable?.botToken;
      const appToken = input.appToken?.trim() || reusable?.appToken;
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
      const slackGroupMembers = input.groupMembers ?? existingConfig?.groupMembers;
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
        // Owners are recorded by the daemon (installer, DM senders).
        ...(existingConfig?.ownerUserIds !== undefined
          ? { ownerUserIds: existingConfig.ownerUserIds }
          : {}),
        ...(slackGroupMembers !== undefined ? { groupMembers: slackGroupMembers } : {}),
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
  /** The content the editor started from: a crossing write is merged, not overwritten. */
  base: Schema.optional(Schema.String),
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
      Effect.map((written) =>
        HttpServerResponse.jsonUnsafe(
          { saved: true, content: written.content, merged: written.merged },
          { status: 200 },
        ),
      ),
      Effect.catch(respondServerError("assistant:file-write")),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/**
 * `GET /api/manager/assistant/chats` — the chats this computer's assistant
 * started, with model, status, tokens and (Uno AI) cost. The assistant page
 * reads it ("Chats Ana started"). Owner session only.
 */
export const managerAssistantChatsRouteLayer = HttpRouter.add(
  "GET",
  "/api/manager/assistant/chats",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const projections = yield* ProjectionSnapshotQuery;
    const providerRegistry = yield* ProviderRegistry;
    // Optional so a wiring without the gateway (tests) still answers.
    const gatewayKey = yield* Effect.serviceOption(UnoGatewayKey);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const rawProjectId = url._tag === "Some" ? url.value.searchParams.get("projectId") : null;
    const assistantProjectId = rawProjectId?.trim() || undefined;
    const stateDir = Option.map(yield* Effect.serviceOption(ServerConfig), (c) => c.stateDir);
    return yield* Effect.gen(function* () {
      const snapshot = yield* projections.getShellSnapshot();
      // One assistant's chats when asked (several assistants per computer).
      const startedBy = Option.isSome(stateDir)
        ? yield* Effect.promise(() => readStartedChats(stateDir.value))
        : new Map<string, string>();
      const chats = selectAssistantChats({
        threads: snapshot.threads,
        assistantProjectId,
        startedBy,
      });
      const localTokens = new Map<string, number | null>();
      yield* Effect.forEach(
        chats,
        (thread) =>
          projections.getThreadDetailById(thread.id).pipe(
            Effect.map((detail) =>
              localTokens.set(
                thread.id,
                Option.isSome(detail) ? tokensFromActivities(detail.value.activities) : null,
              ),
            ),
            Effect.orElseSucceed(() => localTokens.set(thread.id, null)),
          ),
        { concurrency: 4, discard: true },
      );
      const providers = yield* providerRegistry.getProviders;
      const key = Option.isSome(gatewayKey) ? yield* gatewayKey.value.harnessKey() : "";
      const unoInstances = new Set(
        providers
          .filter((provider) => provider.driver === "uno")
          .map((p) => p.instanceId as string),
      );
      const gateway = yield* Effect.promise(() =>
        fetchGatewayThreadUsage({
          gateway: key.length > 0 ? { baseUrl: assistantGatewayBaseUrl(), key } : null,
          threadIds: chats
            .filter((thread) => unoInstances.has(thread.modelSelection.instanceId))
            .map((thread) => thread.id),
        }),
      );
      const result = buildAssistantChats({
        threads: chats,
        projects: snapshot.projects,
        providers,
        localTokens,
        gateway,
      });
      return HttpServerResponse.jsonUnsafe(result, { status: 200 });
    }).pipe(Effect.catch(respondServerError("assistant:chats")));
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/** Same gateway as the App SDK (its `UNO_WORK_APP_GATEWAY_URL` overrides, for stands). */
function assistantGatewayBaseUrl(): string {
  return (process.env["UNO_WORK_APP_GATEWAY_URL"]?.trim() || UNO_GATEWAY_BASE_URL).replace(
    /\/+$/,
    "",
  );
}

// ── Assistants on this computer (0.0.106): delete / restore / apps ──

const respondAssistantError = (scope: string) => (cause: unknown) =>
  Schema.is(ManagerAssistantError)(cause)
    ? Effect.succeed(HttpServerResponse.jsonUnsafe({ error: cause.detail }, { status: 409 }))
    : respondServerError(scope)(cause);

/** `DELETE /api/manager/assistants?projectId=` — kept 7 days, see `deleteAssistant`. */
export const managerAssistantDeleteRouteLayer = HttpRouter.add(
  "DELETE",
  "/api/manager/assistants",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const projectId = yield* assistantProjectIdFromQuery;
    yield* requireAssistantProject(projectId);
    const assistants = yield* ManagerAssistantService;
    const team = yield* Effect.serviceOption(AssistantTeam);
    // The team: the helpers it set up go with it (each kept 7 days too).
    if (Option.isSome(team)) {
      return yield* team.value.deleteWithHelpers(projectId).pipe(
        Effect.map((result) =>
          HttpServerResponse.jsonUnsafe({ ok: true, deleted: result.deleted }, { status: 200 }),
        ),
        Effect.catch(respondTeamError),
      );
    }
    return yield* assistants.deleteAssistant(projectId).pipe(
      Effect.map(() => HttpServerResponse.jsonUnsafe({ ok: true }, { status: 200 })),
      Effect.catch(respondAssistantError("assistants:delete")),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/** `GET /api/manager/assistants/deleted` — deleted assistants still kept (Restore). */
export const managerAssistantsDeletedRouteLayer = HttpRouter.add(
  "GET",
  "/api/manager/assistants/deleted",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const assistants = yield* ManagerAssistantService;
    return yield* assistants.listDeletedAssistants().pipe(
      Effect.map((deleted) => HttpServerResponse.jsonUnsafe({ deleted }, { status: 200 })),
      Effect.catch(respondServerError("assistants:deleted")),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

const RestorePayload = Schema.Struct({ projectId: ProjectId });

/** `POST /api/manager/assistants/restore` {projectId}. */
export const managerAssistantRestoreRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/assistants/restore",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const input = yield* HttpServerRequest.schemaBodyJson(RestorePayload).pipe(
      Effect.mapError(() => new AuthError({ message: "Invalid payload.", status: 400 })),
    );
    yield* requireAssistantProject(input.projectId);
    const assistants = yield* ManagerAssistantService;
    return yield* assistants.restoreAssistant(input.projectId).pipe(
      Effect.map(() => HttpServerResponse.jsonUnsafe({ ok: true }, { status: 200 })),
      Effect.catch(respondAssistantError("assistants:restore")),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/**
 * `GET /api/manager/assistant/apps?projectId=` — which apps an assistant of
 * this computer may open. Checked by Work here (`unoWork/tools.ts`), not by
 * the console: on a shared computer the console sees one machine token.
 */
export const managerAssistantAppsGetRouteLayer = HttpRouter.add(
  "GET",
  "/api/manager/assistant/apps",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const projectId = yield* assistantProjectIdFromQuery;
    yield* requireAssistantProject(projectId);
    const config = yield* ServerConfig;
    const access = yield* Effect.promise(() => readAppAccess(config.stateDir, projectId));
    return HttpServerResponse.jsonUnsafe({ ...access, enforcedBy: "computer" }, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/**
 * `GET /api/manager/assistant/mail?projectId=` — its own email for its page:
 * its address in the computer's mailbox, its rules, what it sent today and
 * its newest letters. `available: false` when the computer has no mail.
 */
export const managerAssistantMailRouteLayer = HttpRouter.add(
  "GET",
  "/api/manager/assistant/mail",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const projectId = yield* assistantProjectIdFromQuery;
    yield* requireAssistantProject(projectId);
    const config = yield* ServerConfig;
    const mail = yield* Effect.serviceOption(AgentMailService);
    const cloud = yield* Effect.serviceOption(UnoCloudService);
    const state = Option.isSome(mail)
      ? yield* mail.value.status
      : { available: false, reason: "not_configured" as const, mailbox: null };
    // Another assistant's letters are among the mailbox's: a fuller page to filter.
    const letters =
      state.available && Option.isSome(mail)
        ? yield* mail.value.recent(projectId === ASSISTANT_PROJECT_ID ? 5 : 50)
        : [];
    const ownerEmail = Option.isSome(cloud)
      ? yield* cloud.value.getState().pipe(
          Effect.map((current) => current.account?.email ?? null),
          Effect.orElseSucceed(() => null),
        )
      : null;
    const team = yield* Effect.promise(() => readTeam(config.stateDir, projectId));
    const ledger = yield* Effect.promise(() => readMailLedger(config.stateDir, projectId));
    return HttpServerResponse.jsonUnsafe(
      assistantMailView({
        projectId,
        state,
        letters,
        team,
        ledger,
        ownerEmail,
        now: new Date(),
      }),
      { status: 200 },
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

// ── Its picture (Misha 23.10) ──────────────────────────────────────────

class AvatarDrawError extends Data.TaggedError("AvatarDrawError")<{ readonly message: string }> {}

const assistantWorkspaceRoot = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionSnapshotQuery;
    const project = yield* projections
      .getProjectShellById(projectId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(project)) {
      return yield* new AuthError({ message: "Unknown assistant.", status: 400 });
    }
    return project.value.workspaceRoot;
  });

/** `GET /api/manager/assistant/avatar?projectId=` — its picture (owner session only). */
export const managerAssistantAvatarGetRouteLayer = HttpRouter.add(
  "GET",
  "/api/manager/assistant/avatar",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const projectId = yield* assistantProjectIdFromQuery;
    yield* requireAssistantProject(projectId);
    const root = yield* assistantWorkspaceRoot(projectId);
    const avatar = yield* Effect.promise(() => readAvatar(root));
    if (avatar === null) {
      return HttpServerResponse.jsonUnsafe({ error: "No picture." }, { status: 404 });
    }
    return HttpServerResponse.uint8Array(avatar.bytes, {
      status: 200,
      contentType: avatar.contentType,
      // The file name changes with every new picture: a cached one is right.
      headers: { "Cache-Control": "private, max-age=86400" },
    });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/** `POST /api/manager/assistant/avatar` {projectId, image} — set its picture, or null for its emoji. */
export const managerAssistantAvatarSetRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/assistant/avatar",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const input = yield* HttpServerRequest.schemaBodyJson(AssistantAvatarSetInput).pipe(
      Effect.mapError(
        () => new AuthError({ message: "Use a PNG, JPG or WebP up to 2 MB.", status: 400 }),
      ),
    );
    yield* requireAssistantProject(input.projectId);
    const root = yield* assistantWorkspaceRoot(input.projectId);
    if (input.image === null) {
      yield* Effect.promise(() => clearAvatar(root));
      return HttpServerResponse.jsonUnsafe({ avatar: null }, { status: 200 });
    }
    const checked = checkAvatarImage(input.image);
    if (!checked.ok) {
      return HttpServerResponse.jsonUnsafe({ error: checked.problem }, { status: 400 });
    }
    const avatar = yield* Effect.promise(() => saveAvatar(root, checked));
    return HttpServerResponse.jsonUnsafe({ avatar }, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/**
 * `POST /api/manager/assistant/avatar/generate` {projectId, persona, seed?} →
 * {image: data URL}: a portrait drawn by Uno AI, not saved (the person picks
 * it). 503 where pictures aren't available (no Uno AI key, the account
 * without assistants); the gateway's own refusals as its words.
 */
export const managerAssistantAvatarGenerateRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/assistant/avatar/generate",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const input = yield* HttpServerRequest.schemaBodyJson(AssistantAvatarGenerateInput).pipe(
      Effect.mapError(() => new AuthError({ message: "Invalid persona.", status: 400 })),
    );
    yield* requireAssistantProject(input.projectId);
    const gatewayKey = yield* Effect.serviceOption(UnoGatewayKey);
    const settings = yield* Effect.serviceOption(ServerSettingsService);
    const enabled = Option.isSome(settings)
      ? yield* settings.value.getSettings.pipe(
          Effect.flatMap((current) => Effect.promise(() => assistantsMvpEnabled(current))),
          Effect.orElseSucceed(() => false),
        )
      : false;
    if (Option.isNone(gatewayKey) || !enabled) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Pictures aren't available on this computer." },
        { status: 503 },
      );
    }
    const apiKey = yield* gatewayKey.value.harnessKey();
    const prompt = personaPrompt(input.persona, input.seed ?? Date.now());
    return yield* Effect.tryPromise({
      try: () =>
        requestGatewayImage({ baseUrl: UNO_GATEWAY_BASE_URL, apiKey, prompt, size: "1024x1024" }),
      catch: (cause) =>
        new AvatarDrawError({
          message: cause instanceof Error ? cause.message : "Uno AI couldn't draw it.",
        }),
    }).pipe(
      Effect.map((image) => {
        const format = avatarFormat(image.bytes) ?? "png";
        const base64 = Buffer.from(image.bytes).toString("base64");
        return HttpServerResponse.jsonUnsafe(
          { image: `data:${AVATAR_CONTENT_TYPE[format]};base64,${base64}` },
          { status: 200 },
        );
      }),
      Effect.catch((cause) =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            {
              error: cause.message.replace(/ Tell the person[^.]*\./, ""),
            },
            { status: 502 },
          ),
        ),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/** `POST /api/manager/assistant/apps` {projectId, permissions} — owner session only. */
export const managerAssistantAppsPutRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/assistant/apps",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const input = yield* HttpServerRequest.schemaBodyJson(AssistantAppAccessInput).pipe(
      Effect.mapError(() => new AuthError({ message: "Invalid payload.", status: 400 })),
    );
    yield* requireAssistantProject(input.projectId);
    const config = yield* ServerConfig;
    const access = yield* Effect.tryPromise(() =>
      writeAppAccess(config.stateDir, input.projectId, input.permissions),
    ).pipe(Effect.orDie);
    yield* Effect.logInfo("assistant app access changed").pipe(
      Effect.annotateLogs({ projectId: input.projectId, permissions: access.permissions }),
    );
    const losses = yield* cascadeTeamRights(input.projectId);
    return HttpServerResponse.jsonUnsafe(
      { ...access, enforcedBy: "computer", losses },
      { status: 200 },
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/**
 * `GET /api/manager/assistant/instructions?projectId=` — AGENTS.md against
 * Uno's newer instructions (an untouched file is updated on the way).
 */
export const managerAssistantInstructionsGetRouteLayer = HttpRouter.add(
  "GET",
  "/api/manager/assistant/instructions",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const projectId = yield* assistantProjectIdFromQuery;
    yield* requireAssistantProject(projectId);
    const assistants = yield* ManagerAssistantService;
    return yield* assistants.instructionsStatus(projectId).pipe(
      Effect.map((status) => HttpServerResponse.jsonUnsafe(status, { status: 200 })),
      Effect.catch(respondAssistantError("assistant:instructions")),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/** `POST /api/manager/assistant/instructions` {projectId, action, choices?}. */
export const managerAssistantInstructionsResolveRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/assistant/instructions",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const input = yield* HttpServerRequest.schemaBodyJson(AssistantInstructionsResolveInput).pipe(
      Effect.mapError(() => new AuthError({ message: "Invalid payload.", status: 400 })),
    );
    yield* requireAssistantProject(input.projectId);
    const assistants = yield* ManagerAssistantService;
    return yield* assistants
      .resolveInstructions({
        projectId: input.projectId,
        action: input.action,
        choices: input.choices,
      })
      .pipe(
        Effect.map((result) => HttpServerResponse.jsonUnsafe(result, { status: 200 })),
        Effect.catch(respondAssistantError("assistant:instructions")),
      );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/**
 * `GET /api/manager/assistant/slack/channels?projectId=` — the workspace's
 * channels through Uno's app, and which assistant of this computer answers
 * in each ("Channels Ana answers in").
 */
export const managerAssistantSlackChannelsGetRouteLayer = HttpRouter.add(
  "GET",
  "/api/manager/assistant/slack/channels",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const projectId = yield* assistantProjectIdFromQuery;
    yield* requireAssistantProject(projectId);
    const slack = yield* ManagerSlackService;
    const repository = yield* ManagerConnectorRepository;
    const channels = yield* slack.listChannels(projectId);
    if (channels === null) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Slack isn't connected on this computer." },
        { status: 409 },
      );
    }
    const owners = new Map<string, string>();
    for (const row of yield* repository.listByKind("slack").pipe(Effect.orElseSucceed(() => []))) {
      const decoded = Schema.decodeUnknownExit(ManagerSlackConnectorConfig)(row.config);
      if (decoded._tag !== "Success") continue;
      for (const id of decoded.value.allowedChannelIds) owners.set(id, row.projectId);
    }
    return HttpServerResponse.jsonUnsafe(
      {
        channels: channels.map((channel) => ({
          id: channel.id,
          name: channel.name,
          isPrivate: channel.isPrivate,
          isMember: channel.isMember,
          assistantProjectId: owners.get(channel.id) ?? null,
        })),
      },
      { status: 200 },
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

const SlackChannelsPayload = Schema.Struct({
  projectId: ProjectId,
  channelIds: Schema.Array(Schema.String),
});

/** `POST /api/manager/assistant/slack/channels` {projectId, channelIds} — owner only. */
export const managerAssistantSlackChannelsPutRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/assistant/slack/channels",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const input = yield* HttpServerRequest.schemaBodyJson(SlackChannelsPayload).pipe(
      Effect.mapError(() => new AuthError({ message: "Invalid payload.", status: 400 })),
    );
    yield* requireAssistantProject(input.projectId);
    const slack = yield* ManagerSlackService;
    return yield* Effect.gen(function* () {
      const assigned = yield* assignSlackChannelsFor(input);
      // The app has to be in a public channel to hear it (private: invite it).
      const listed = (yield* slack.listChannels(input.projectId)) ?? [];
      for (const channel of listed) {
        if (assigned.includes(channel.id) && !channel.isMember && !channel.isPrivate) {
          yield* slack.joinChannel(input.projectId, channel.id);
        }
      }
      return HttpServerResponse.jsonUnsafe({ allowedChannelIds: assigned }, { status: 200 });
    }).pipe(Effect.catch(respondServerError("assistant:slack-channels")));
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

// ---------------------------------------------------------------------------
// Connector bindings (chat → target)
// ---------------------------------------------------------------------------

// Resolve target titles for the settings table in one snapshot read.
const withBindingLabels = (bindings: ReadonlyArray<ManagerConnectorBinding>) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionSnapshotQuery;
    const snapshot = yield* projections.getShellSnapshot();
    const labels = {
      projectTitleById: new Map(snapshot.projects.map((project) => [project.id, project.title])),
      threadTitleById: new Map(snapshot.threads.map((thread) => [thread.id, thread.title])),
    };
    return bindings.map(
      (binding): ManagerConnectorBindingView => ({
        ...binding,
        targetLabel: bindingTargetLabel(binding.target, labels),
      }),
    );
  });

export const managerConnectorBindingsListRouteLayer = HttpRouter.add(
  "GET",
  "/api/manager/connector-bindings",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const bindingRepository = yield* ManagerConnectorBindingRepository;
    const projectId = yield* assistantProjectIdFromQuery;
    return yield* bindingRepository.listByConnectorProject(projectId).pipe(
      Effect.flatMap(withBindingLabels),
      Effect.map((bindings) => HttpServerResponse.jsonUnsafe({ bindings }, { status: 200 })),
      Effect.catch(respondServerError("connector-bindings:list")),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const managerConnectorBindingsUpsertRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/connector-bindings",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const bindingRepository = yield* ManagerConnectorBindingRepository;
    const projections = yield* ProjectionSnapshotQuery;
    const input = yield* HttpServerRequest.schemaBodyJson(ManagerConnectorBindingUpsertInput).pipe(
      Effect.mapError(() => new AuthError({ message: "Invalid binding payload.", status: 400 })),
    );
    if (!isAssistantProjectId(input.connectorProjectId)) {
      return HttpServerResponse.jsonUnsafe(
        { error: "connectorProjectId must be an assistant project." },
        { status: 400 },
      );
    }
    return yield* Effect.gen(function* () {
      // The target must exist: a binding to nothing would only produce
      // "no longer exists" replies in the chat.
      const targetExists =
        input.target.kind === "thread"
          ? Option.isSome(yield* projections.getThreadShellById(input.target.threadId))
          : Option.isSome(yield* projections.getProjectShellById(input.target.projectId));
      if (!targetExists) {
        return HttpServerResponse.jsonUnsafe(
          { error: "Binding target not found." },
          { status: 404 },
        );
      }
      const existing = yield* bindingRepository.get({ kind: input.kind, chatId: input.chatId });
      yield* bindingRepository.upsert({
        kind: input.kind,
        chatId: input.chatId,
        connectorProjectId: input.connectorProjectId,
        target: input.target,
        notifyOnComplete:
          input.notifyOnComplete ??
          (Option.isSome(existing) ? existing.value.notifyOnComplete : false),
        updatedAt: new Date().toISOString(),
      });
      const saved = yield* bindingRepository.get({ kind: input.kind, chatId: input.chatId });
      const labelled = yield* withBindingLabels(Option.isSome(saved) ? [saved.value] : []);
      return HttpServerResponse.jsonUnsafe({ binding: labelled[0] ?? null }, { status: 200 });
    }).pipe(Effect.catch(respondServerError("connector-bindings:upsert")));
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const managerConnectorBindingsRemoveRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/connector-bindings/remove",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const bindingRepository = yield* ManagerConnectorBindingRepository;
    const input = yield* HttpServerRequest.schemaBodyJson(ManagerConnectorBindingRemoveInput).pipe(
      Effect.mapError(() => new AuthError({ message: "Invalid remove payload.", status: 400 })),
    );
    return yield* bindingRepository.remove(input).pipe(
      Effect.map((removed) => HttpServerResponse.jsonUnsafe({ removed }, { status: 200 })),
      Effect.catch(respondServerError("connector-bindings:remove")),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

// ---------------------------------------------------------------------------
// Outbound: software / harness → bound chat(s)
// ---------------------------------------------------------------------------

export const channelsNotifyRouteLayer = HttpRouter.add(
  "POST",
  CHANNEL_NOTIFY_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const browserBridge = yield* BrowserBridge;
    const thread = requireBridgeThread(authorizeLocalBridgeRequest(browserBridge, request));
    if (!thread.ok) {
      return HttpServerResponse.jsonUnsafe(
        { error: thread.error, message: thread.message },
        { status: thread.status },
      );
    }
    const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    const decoded = Schema.decodeUnknownExit(ChannelNotifyInput)(body);
    if (decoded._tag !== "Success") {
      return HttpServerResponse.jsonUnsafe(
        {
          error:
            'Invalid payload: expected {"text": string, "threadId"?: string, "projectId"?: string, "kind"?: "info"|"warning"|"error"}.',
        },
        { status: 400 },
      );
    }
    const input = decoded.value;
    // The token names the thread. An explicit `threadId` may only repeat it:
    // notifying from someone else's chat is exactly what a shared token used
    // to allow.
    const notifyThread = resolveNotifyThreadId(thread.threadId, input.threadId);
    if (!notifyThread.ok) {
      return HttpServerResponse.jsonUnsafe(
        {
          error: "thread_mismatch",
          message:
            'Уведомить можно только от имени своего чата: "threadId" не совпадает с тредом bridge-токена.',
        },
        { status: 403 },
      );
    }
    const threadId = ThreadId.make(notifyThread.threadId);
    const notifyService = yield* ConnectorNotifyService;
    const result = yield* notifyService.notify({
      text: input.text,
      threadId,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
    });
    return HttpServerResponse.jsonUnsafe(result, { status: 200 });
  }),
);
