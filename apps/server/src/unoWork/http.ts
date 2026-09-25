/**
 * HTTP surface of the `uno-work` MCP server (see `tools.ts`):
 *
 * - `POST /api/uno-work/mcp`             — stateless Streamable-HTTP MCP endpoint;
 * - `GET|DELETE /api/uno-work/mcp`       — 405 (no SSE stream offered);
 * - `GET  /api/uno-work/guide/:topic`    — the same guides as `uno_guide`, for
 *   sessions where MCP didn't attach (plain curl with the bridge token);
 * - `POST /api/uno-work/approval/result` — the person's Allow / Deny from the
 *   approval card (authenticated by the card's one-time response token).
 *
 * The MCP and guide routes authenticate with the per-thread bridge token the
 * harness got for this chat (`UNO_WORK_BRIDGE_TOKEN`): the caller is always
 * the thread the token was issued to.
 */
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";

import { ThreadId, type UnoMachineApp } from "@t3tools/contracts";
import { Effect, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { BROWSER_BRIDGE_TOKEN_ENV, BrowserBridge, requireBridgeThread } from "../browserBridge.ts";
import { ComputerResourcesService } from "../computerResources/ComputerResourcesService.ts";
import { FilesService } from "../files/FilesService.ts";
import { InboxService } from "../inbox/InboxService.ts";
import { MachineAppsService } from "../machineApps/MachineAppsService.ts";
import { resolveManifestDir } from "../machineApps/manifestDir.ts";
import { ConnectorNotifyService } from "../manager/Services/ConnectorNotify.ts";
import { handleMcpMessage } from "../mcp/mcpJsonRpc.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { openCodeSessionEnvDir, readOpenCodeSessionEnv } from "../provider/opencodeSessionEnv.ts";
import { UnoCloudService } from "../workspaceRegistry/UnoCloudService.ts";
import { UnoComputerService } from "../workspaceRegistry/UnoComputerService.ts";
import { ConnectorsService } from "../setupTools/ConnectorsService.ts";
import {
  buildUnoWorkGuide,
  isUnoWorkGuideTopic,
  UNO_WORK_GUIDE_TOPICS,
} from "../agentContext/guides.ts";
import {
  UNO_WORK_APPROVAL_RESULT_PATH,
  UNO_WORK_GUIDE_PATH,
  UNO_WORK_MCP_PATH,
  buildUnoWorkMcpServer,
  UnoWorkToolError,
  type BridgeReply,
  type UnoWorkToolDeps,
} from "./tools.ts";
import { controlPlaneBaseUrl } from "../workspaceRegistry/unoCloudParse.ts";
import { consoleRequest, consoleToken } from "./consoleClient.ts";
import { UNO_WORK_MCP_SESSION_ARG } from "./constants.ts";

const LOG_MAX_BYTES = 64 * 1024;

function run(command: string, args: ReadonlyArray<string>): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: 8_000, maxBuffer: 2 * LOG_MAX_BYTES },
      (error, stdout, stderr) => {
        const text = `${stdout ?? ""}${stderr ?? ""}`.trim();
        resolve(text || (error ? `(${error.message})` : ""));
      },
    );
  });
}

async function tailFile(file: string, lines: number): Promise<string> {
  const handle = await fsp.open(file, "r").catch(() => null);
  if (handle === null) return "";
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - LOG_MAX_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString("utf8").split("\n").slice(-lines).join("\n");
  } finally {
    await handle.close();
  }
}

/** The last lines an app printed, by where its kind of app logs. */
export async function readAppLogTail(
  app: UnoMachineApp,
  lines: number,
  manifestDir: string,
): Promise<string> {
  const [kind, ...rest] = app.id.split(":");
  const name = rest.join(":");
  const safeName = /^[A-Za-z0-9@._-]{1,200}$/.test(name);
  switch (kind) {
    case "manifest":
      return safeName ? tailFile(path.join(manifestDir, `${name}.log`), lines) : "";
    case "docker":
      return safeName ? run("docker", ["logs", "--tail", String(lines), name]) : "";
    case "systemd": {
      if (!safeName) return "";
      const user = await run("journalctl", [
        "--user",
        "-u",
        name,
        "-n",
        String(lines),
        "--no-pager",
      ]);
      return user.includes("-- No entries --") || user.length === 0
        ? run("journalctl", ["-u", name, "-n", String(lines), "--no-pager"])
        : user;
    }
    default:
      return "This app wasn't started by Uno (only a listening port is known), so there is no log to read. Check how it was started (ps, the app's own log files).";
  }
}

const readJson = (request: HttpServerRequest.HttpServerRequest) =>
  request.json.pipe(Effect.catch(() => Effect.succeed(null)));

function bearerToken(header: string | undefined): string {
  return header?.replace(/^Bearer\s+/i, "").trim() ?? "";
}

/** The `tools/call` arguments object of a JSON-RPC message, if it is one. */
function toolCallArguments(body: unknown): Record<string, unknown> | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const message = body as { method?: unknown; params?: unknown };
  if (message.method !== "tools/call") return undefined;
  const params = message.params as { arguments?: unknown } | undefined;
  const args = params?.arguments;
  return args !== null && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : undefined;
}

/** The session tag is ours, never a tool argument. */
function stripSessionArg(body: unknown): void {
  const args = toolCallArguments(body);
  if (args) delete args[UNO_WORK_MCP_SESSION_ARG];
}

/**
 * A shared server's call: the thread token of the OpenCode session the call
 * names. An unknown session yields an empty token (401 from the bridge).
 */
function sharedServerCaller(
  body: unknown,
  envDir: string,
): { readonly token: string; readonly isCall: boolean } {
  const isCall =
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    (body as { method?: unknown }).method === "tools/call";
  const sessionId = toolCallArguments(body)?.[UNO_WORK_MCP_SESSION_ARG];
  const token =
    typeof sessionId === "string"
      ? (readOpenCodeSessionEnv(envDir, sessionId)?.[BROWSER_BRIDGE_TOKEN_ENV] ?? "")
      : "";
  return { token, isCall };
}

/** Everything the tools use, bound to the calling thread. */
const makeDeps = (input: {
  readonly token: string;
  readonly threadId: string;
  readonly cwd: string | undefined;
}) =>
  Effect.gen(function* () {
    const browserBridge = yield* BrowserBridge;
    const projections = yield* ProjectionSnapshotQuery;
    const machineApps = yield* MachineAppsService;
    const computerResources = yield* ComputerResourcesService;
    const files = yield* FilesService;
    const inbox = yield* InboxService;
    const notify = yield* ConnectorNotifyService;
    const unoCloud = yield* UnoCloudService;
    const unoComputer = yield* UnoComputerService;
    const serverSettings = yield* ServerSettingsService;
    const serverConfig = yield* ServerConfig;
    const connectors = Option.getOrNull(yield* Effect.serviceOption(ConnectorsService));

    const shell = yield* projections
      .getThreadShellById(ThreadId.make(input.threadId))
      .pipe(Effect.orElseSucceed(() => Option.none()));
    const thread = Option.getOrNull(shell);
    const home = os.homedir();
    const manifestDir = resolveManifestDir(home);
    const context = { threadId: input.threadId, ...(input.cwd ? { cwd: input.cwd } : {}) };

    const deps: UnoWorkToolDeps = {
      caller: {
        threadId: input.threadId,
        threadTitle: thread?.title ?? "Chat",
        // A thread the projection can't see yet is treated as Ask mode: the
        // safe default when we can't tell what the person chose.
        runtimeMode: thread?.runtimeMode ?? "approval-required",
        cwd: input.cwd ?? thread?.worktreePath ?? undefined,
      },
      home,
      manifestDir,
      pluginsDir: serverConfig.pluginsDir,
      bridge: ({ method, path: requestPath, body, timeoutMs }) =>
        Effect.tryPromise({
          try: async (signal): Promise<BridgeReply> => {
            if (!browserBridge.baseUrl)
              throw new Error("The Uno Work bridge is off on this computer.");
            const controller = new AbortController();
            const abort = () => controller.abort();
            signal.addEventListener("abort", abort);
            const timer = setTimeout(abort, timeoutMs ?? 60_000);
            try {
              const response = await fetch(`${browserBridge.baseUrl}${requestPath}`, {
                method,
                headers: {
                  authorization: `Bearer ${input.token}`,
                  ...(body !== undefined ? { "content-type": "application/json" } : {}),
                },
                ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
                signal: controller.signal,
              });
              const text = await response.text();
              let parsed: unknown = text;
              try {
                parsed = text.length > 0 ? JSON.parse(text) : null;
              } catch {
                // plain-text refusal
              }
              return { status: response.status, body: parsed };
            } finally {
              clearTimeout(timer);
              signal.removeEventListener("abort", abort);
            }
          },
          catch: (cause) =>
            new UnoWorkToolError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        }),
      requestApproval: (approval) =>
        Effect.gen(function* () {
          // The bell too: the person may be looking at another chat.
          const item = yield* inbox
            .post({
              kind: "agent.approval",
              source: {
                kind: "agent",
                id: input.threadId,
                name: thread?.title ?? "Chat",
                icon: null,
              },
              title: approval.title,
              body: approval.detail ?? null,
              open: { kind: "thread", threadId: input.threadId },
              groupKey: `uno-work-approval:${input.threadId}`,
            })
            .pipe(Effect.option);
          const outcome = yield* browserBridge.requestToolApproval(approval, context);
          if (Option.isSome(item)) {
            yield* inbox.update({ action: "read", ids: [item.value.id] }).pipe(Effect.ignore);
          }
          return outcome;
        }),
      machineApps: { list: machineApps.list, action: machineApps.action },
      resources: computerResources.snapshot,
      computerState: unoComputer.getState(),
      files: {
        list: (args) => files.list(args),
        stat: (args) => files.stat(args),
        createShare: (args) => files.createShare(args),
        publishSite: (args) => files.publishSite(args),
        cloudState: files.cloudState,
        cloudList: (args) => files.cloudList(args),
        driveState: files.driveState,
        driveSearch: (args) => files.driveSearch(args),
        driveRecent: (args) => files.driveRecent(args),
        driveShareCreate: (args) => files.driveShareCreate(args),
        cloudCopyToCloud: (args) => files.cloudCopyToCloud(args),
      },
      inboxPost: (post) => inbox.post(post).pipe(Effect.map((item) => ({ id: item.id }))),
      messengerNotify: ({ text, kind }) =>
        notify
          .notify({ text, threadId: ThreadId.make(input.threadId), kind })
          .pipe(Effect.map((result) => ({ delivered: result.delivered }))),
      openInApp: ({ view, path: filePath }) =>
        Effect.gen(function* () {
          if (!(yield* browserBridge.hasSubscribers)) {
            return { ok: false, error: "Uno Work isn't open anywhere to show it." };
          }
          yield* browserBridge.publishOpenInApp({ view, path: filePath }, context);
          return { ok: true };
        }),
      account: {
        cloudState: unoCloud.getState(),
        resizeOptions: unoComputer.resizeOptions(),
        createBox: (args) => unoCloud.createBox(args),
        createBoxStatus: (args) => unoCloud.createBoxStatus(args),
      },
      settings: serverSettings.getSettings,
      console: {
        request: (request) =>
          Effect.gen(function* () {
            const current = yield* serverSettings.getSettings.pipe(
              Effect.orElseSucceed(() => null),
            );
            const token = current ? consoleToken(current) : "";
            // No token: answer like the console would, the tool explains it.
            if (token.length === 0) return { status: 401, body: null };
            return yield* Effect.tryPromise({
              try: () => consoleRequest({ ...request, baseUrl: controlPlaneBaseUrl(), token }),
              catch: (cause) =>
                new UnoWorkToolError({
                  message: `The Uno console didn't answer: ${cause instanceof Error ? cause.message : String(cause)}`,
                }),
            });
          }),
      },
      readLogTail: ({ app, lines }) =>
        Effect.promise(() => readAppLogTail(app, lines, manifestDir)),
      ...(connectors
        ? {
            connectors: {
              call: (callInput) =>
                connectors
                  .call(callInput)
                  .pipe(
                    Effect.mapError((error) => new UnoWorkToolError({ message: error.message })),
                  ),
            },
          }
        : {}),
    };
    return deps;
  });

export const unoWorkMcpRouteLayer = HttpRouter.add(
  "POST",
  UNO_WORK_MCP_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const browserBridge = yield* BrowserBridge;
    const header = request.headers["authorization"];
    const authorization = browserBridge.authorize(header);
    const sharedServer = authorization?.kind === "shared-mcp";
    const body = yield* readJson(request);
    // The person's connected tools join the built-in ones (cached; none off a
    // cloud computer). Resolved only for authorized calls.
    const connectorsService = Option.getOrNull(yield* Effect.serviceOption(ConnectorsService));
    const mcpServer = connectorsService
      ? connectorsService.tools.pipe(Effect.map(buildUnoWorkMcpServer))
      : Effect.succeed(buildUnoWorkMcpServer([]));
    // A shared uno-code/OpenCode server (one process for every chat) holds
    // one token for all of them; each tool call names its OpenCode session
    // and the thread is the one the daemon wrote that session's token for.
    const sessionCaller = sharedServer
      ? sharedServerCaller(body, openCodeSessionEnvDir((yield* ServerConfig).stateDir))
      : { token: bearerToken(header), isCall: false };
    if (sharedServer && !sessionCaller.isCall && body !== null) {
      // initialize / tools/list / ping / notifications don't act for a thread.
      const outcome = yield* handleMcpMessage(
        yield* mcpServer,
        undefined as unknown as UnoWorkToolDeps,
        body,
      );
      return outcome.kind === "accepted"
        ? HttpServerResponse.empty({ status: 202 })
        : HttpServerResponse.jsonUnsafe(outcome.body, { status: 200 });
    }
    const thread = requireBridgeThread(
      sharedServer ? browserBridge.authorize(`Bearer ${sessionCaller.token}`) : authorization,
    );
    if (!thread.ok) {
      return HttpServerResponse.jsonUnsafe(
        { error: thread.error, message: thread.message },
        { status: thread.status },
      );
    }
    if (body === null) {
      return HttpServerResponse.jsonUnsafe(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
        { status: 400 },
      );
    }
    stripSessionArg(body);
    const deps = yield* makeDeps({
      token: sessionCaller.token,
      threadId: thread.threadId,
      cwd: thread.context.cwd,
    });
    const outcome = yield* handleMcpMessage(yield* mcpServer, deps, body);
    if (outcome.kind === "accepted") {
      return HttpServerResponse.empty({ status: 202 });
    }
    return HttpServerResponse.jsonUnsafe(outcome.body, { status: 200 });
  }),
);

const methodNotAllowed = Effect.succeed(
  HttpServerResponse.text("Method Not Allowed", { status: 405, headers: { allow: "POST" } }),
);

export const unoWorkMcpGetRouteLayer = HttpRouter.add("GET", UNO_WORK_MCP_PATH, methodNotAllowed);
export const unoWorkMcpDeleteRouteLayer = HttpRouter.add(
  "DELETE",
  UNO_WORK_MCP_PATH,
  methodNotAllowed,
);

export const unoWorkGuideRouteLayer = HttpRouter.add(
  "GET",
  `${UNO_WORK_GUIDE_PATH}/:topic`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const browserBridge = yield* BrowserBridge;
    const thread = requireBridgeThread(browserBridge.authorize(request.headers["authorization"]));
    if (!thread.ok) {
      return HttpServerResponse.text(thread.message, { status: thread.status });
    }
    const params = yield* HttpRouter.params;
    const topic = params.topic;
    if (!isUnoWorkGuideTopic(topic)) {
      return HttpServerResponse.text(
        `Unknown topic. Use one of: ${UNO_WORK_GUIDE_TOPICS.join(", ")}.`,
        { status: 404 },
      );
    }
    return HttpServerResponse.text(
      buildUnoWorkGuide(topic, {
        bridgeBaseUrl: browserBridge.baseUrl,
        pluginsDir: (yield* ServerConfig).pluginsDir,
      }),
      { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" } },
    );
  }),
);

export const unoWorkApprovalResultRouteLayer = HttpRouter.add(
  "POST",
  UNO_WORK_APPROVAL_RESULT_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* readJson(request);
    const input =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    if (
      typeof input.requestId !== "string" ||
      typeof input.responseToken !== "string" ||
      typeof input.approved !== "boolean"
    ) {
      return HttpServerResponse.text("Invalid approval payload.", { status: 400 });
    }
    const browserBridge = yield* BrowserBridge;
    const settled = yield* browserBridge.completeToolApproval({
      requestId: input.requestId,
      responseToken: input.responseToken,
      approved: input.approved,
    });
    return HttpServerResponse.jsonUnsafe({ ok: settled }, { status: settled ? 200 : 404 });
  }),
);

export const unoWorkRouteLayers = [
  unoWorkMcpRouteLayer,
  unoWorkMcpGetRouteLayer,
  unoWorkMcpDeleteRouteLayer,
  unoWorkGuideRouteLayer,
  unoWorkApprovalResultRouteLayer,
] as const;
