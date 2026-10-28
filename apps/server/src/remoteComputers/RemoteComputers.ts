/**
 * RemoteComputersService — the calling side of "an assistant starts a chat on
 * another computer of the account" (assistants D, 28.10; audit 27.10 #2).
 *
 * `chat_create` (uno-work) and `create_thread` (uno-manager) with the
 * `computerId` of another computer land here: the target is resolved against
 * the account's computer list, the other daemon is reached through the
 * console's pairing (`remoteDaemonClient.ts`), and the chat starts there with
 * `POST /api/manager/remote-chats` (`remoteChatHost.ts`). The chat is put in
 * the outgoing ledger (`remoteChatStore.ts`): `work_status` lists it, and the
 * done push (manager/Layers/AssistantPush.ts) polls its status.
 *
 * @module remoteComputers/RemoteComputers
 */
import * as os from "node:os";

import type {
  AssistantPreset,
  ManagerRemoteChatCreateInput,
  ManagerRemoteChatResult,
  ManagerRemoteChatStatus,
  RuntimeMode,
} from "@t3tools/contracts";
import { Context, Effect, Layer, Option } from "effect";

import { readAppAccess } from "../assistants/localAssistantStore.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { parseSettingsBoxId } from "../unoBoxIdentity.ts";
import { fetchControlPlaneJson } from "../workspaceRegistry/unoCloudParse.ts";
import { accountWideKeyFor } from "../workspaceRegistry/unoComputer.ts";
import { UnoCloudService } from "../workspaceRegistry/UnoCloudService.ts";
import {
  makeRemoteDaemonClient,
  RemoteComputerError,
  remoteError,
  remoteErrorText,
  type RemoteDaemonClient,
  type RemoteDaemonReply,
} from "./remoteDaemonClient.ts";
import {
  readOutgoingRemoteChats,
  recordOutgoingRemoteChat,
  updateOutgoingRemoteChat,
  type OutgoingRemoteChat,
} from "./remoteChatStore.ts";
import { resolveComputerRef } from "./target.ts";

export const REMOTE_CHATS_PATH = "/api/manager/remote-chats";

export type RemoteTarget =
  | { readonly kind: "this" }
  | { readonly kind: "box"; readonly boxId: number; readonly name: string };

export interface RemoteChatStartInput {
  readonly target: { readonly boxId: number; readonly name: string };
  readonly text: string;
  readonly title?: string | undefined;
  readonly cwd?: string | undefined;
  readonly projectId?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  /** Never wider than the asking chat runs in. */
  readonly runtimeMode: RuntimeMode;
  readonly startedBy: {
    readonly assistantName: string;
    /** Null: the person's own chat asked (no assistant). */
    readonly assistantProjectId: string | null;
    readonly fromThreadId: string;
    /** Its mode; its app levels are read here and go along. */
    readonly preset?: AssistantPreset | null | undefined;
  };
}

export interface RemoteChatStarted extends ManagerRemoteChatResult {
  readonly computer: { readonly boxId: number; readonly name: string };
}

export interface RemoteComputersServiceShape {
  /** `computerId` → this computer, or another computer of the account (or a plain-words error). */
  readonly resolveTarget: (computerId: unknown) => Effect.Effect<RemoteTarget, RemoteComputerError>;
  readonly startChat: (
    input: RemoteChatStartInput,
  ) => Effect.Effect<RemoteChatStarted, RemoteComputerError>;
  readonly chatStatus: (input: {
    readonly boxId: number;
    readonly computerName: string;
    readonly threadId: string;
  }) => Effect.Effect<ManagerRemoteChatStatus, RemoteComputerError>;
  /** Chats this computer's assistants started elsewhere (newest first). */
  readonly outgoing: Effect.Effect<ReadonlyArray<OutgoingRemoteChat>>;
  readonly noteStatus: (
    threadId: string,
    status: Pick<ManagerRemoteChatStatus, "state" | "lastMessage" | "title">,
  ) => Effect.Effect<void>;
}

export class RemoteComputersService extends Context.Service<
  RemoteComputersService,
  RemoteComputersServiceShape
>()("t3/remoteComputers/RemoteComputersService") {}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * A reply of the other daemon that is not our route's JSON: an older Uno Work
 * there (404 / 405, or its web app's HTML served for an unknown path).
 */
export function isOutdatedReply(reply: RemoteDaemonReply, expectKey: string): boolean {
  const body = asRecord(reply.body);
  if (reply.status === 200) return body === null || !(expectKey in body);
  if (reply.status === 404 || reply.status === 405) {
    return body === null || (body["ok"] !== false && typeof body["error"] !== "string");
  }
  return false;
}

const outdated = (name: string) =>
  remoteError(
    "outdated",
    `Uno Work on ${name} is too old to take chats from another computer. Update Uno Work on ${name} (it updates itself when it restarts), then try again.`,
  );

/** Plain words for a refusal of the other daemon (its own message when it has one). */
export function refusalFrom(reply: RemoteDaemonReply, name: string): RemoteComputerError {
  const text = remoteErrorText(reply.body);
  if (reply.status === 401 || reply.status === 403) {
    return remoteError(
      "no_permission",
      `${name} didn't let this computer in. Try again; if it repeats, open Uno Work on ${name} once.`,
      reply.status,
    );
  }
  return remoteError(
    "refused",
    text === null ? `${name} couldn't start the chat (HTTP ${reply.status}).` : `${name}: ${text}`,
    reply.status,
  );
}

export const makeRemoteComputersService = (options?: {
  readonly fetch?: typeof fetch;
  readonly fetchControlPlane?: typeof fetchControlPlaneJson;
}) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const cloud = yield* UnoCloudService;
    const config = yield* ServerConfig;
    const fetchControlPlane = options?.fetchControlPlane ?? fetchControlPlaneJson;

    // One client per key: a new key (sign-in, rotated machine token) starts
    // with no cached sessions.
    let current: { readonly key: string; readonly client: RemoteDaemonClient } | null = null;

    const identity = settings.getSettings.pipe(
      Effect.map((value) => ({
        credential: accountWideKeyFor({
          accountKey: value.uno.apiKey,
          boxToken: value.uno.boxToken ?? "",
        }),
        ownBoxId: parseSettingsBoxId(value.uno.boxId),
      })),
      Effect.orElseSucceed(() => ({
        credential: { key: "", kind: "none" as const },
        ownBoxId: null,
      })),
    );

    const clientFor = (credential: { key: string; kind: "account" | "machine" | "none" }) => {
      if (current !== null && current.key === credential.key) return current.client;
      const client = makeRemoteDaemonClient({
        controlPlane:
          credential.key.length === 0
            ? null
            : (path, init) => fetchControlPlane(credential.key, path, init),
        keyKind: credential.kind,
        ...(options?.fetch ? { fetch: options.fetch } : {}),
      });
      current = { key: credential.key, client };
      return client;
    };

    const fromPromise = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) =>
          cause instanceof RemoteComputerError
            ? cause
            : remoteError(
                "unreachable",
                "Can't reach the other computer right now. Try again in a minute.",
              ),
      });

    const resolveTarget: RemoteComputersServiceShape["resolveTarget"] = (computerId) =>
      Effect.gen(function* () {
        const { credential, ownBoxId } = yield* identity;
        if (computerId === undefined || computerId === null) return { kind: "this" } as const;
        if (credential.kind === "none") {
          return yield* remoteError(
            "not_linked",
            "This computer isn't signed in to an Uno account, so it can't start chats on other computers. Leave computerId out to start it here.",
          );
        }
        const state = yield* cloud.getState();
        const ref = resolveComputerRef(computerId, { boxes: state.boxes, ownBoxId });
        if (ref.kind === "this") return ref;
        if (ref.kind === "unknown") {
          return yield* remoteError(
            "not_found",
            state.boxes.length === 0 && state.error !== null ? state.error : ref.message,
          );
        }
        return { kind: "box", boxId: ref.box.id, name: ref.box.name } as const;
      });

    const ownName = Effect.gen(function* () {
      const { ownBoxId } = yield* identity;
      if (ownBoxId === null) return os.hostname().replace(/\.local$/, "") || "this computer";
      const state = yield* cloud.getState();
      return state.boxes.find((box) => box.id === ownBoxId)?.name ?? `box-${ownBoxId}`;
    });

    const startChat: RemoteComputersServiceShape["startChat"] = (input) =>
      Effect.gen(function* () {
        const { credential, ownBoxId } = yield* identity;
        const client = clientFor(credential);
        const name = input.target.name;
        // Its app levels go along: that computer's connected apps open no
        // wider for this chat than they do for the assistant here.
        const assistantId = input.startedBy.assistantProjectId;
        const apps =
          assistantId === null
            ? null
            : yield* Effect.promise(() => readAppAccess(config.stateDir, assistantId)).pipe(
                Effect.orElseSucceed(() => ({ permissions: {}, restricted: true })),
              );
        const body: ManagerRemoteChatCreateInput = {
          text: input.text,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
          ...(input.provider !== undefined ? { provider: input.provider } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          runtimeMode: input.runtimeMode,
          startedBy: {
            assistantName: input.startedBy.assistantName,
            assistantProjectId: input.startedBy.assistantProjectId,
            fromComputerName: yield* ownName,
            fromBoxId: ownBoxId,
            fromThreadId: input.startedBy.fromThreadId,
            ...(apps !== null ? { apps } : {}),
            ...(input.startedBy.preset ? { preset: input.startedBy.preset } : {}),
          },
        };
        const reply = yield* fromPromise(() =>
          client.request({
            boxId: input.target.boxId,
            computerName: name,
            method: "POST",
            path: REMOTE_CHATS_PATH,
            body,
          }),
        );
        if (isOutdatedReply(reply, "threadId")) return yield* outdated(name);
        if (reply.status !== 200) return yield* refusalFrom(reply, name);
        const result = asRecord(reply.body)!;
        const started: RemoteChatStarted = {
          threadId: String(result["threadId"]) as RemoteChatStarted["threadId"],
          projectId: String(result["projectId"] ?? "") as RemoteChatStarted["projectId"],
          title: typeof result["title"] === "string" ? result["title"] : (input.title ?? "Chat"),
          computer: { boxId: input.target.boxId, name },
        };
        yield* Effect.promise(() =>
          recordOutgoingRemoteChat(config.stateDir, {
            threadId: started.threadId,
            boxId: input.target.boxId,
            computerName: name,
            title: started.title,
            assistantProjectId: input.startedBy.assistantProjectId ?? "",
            conversationThreadId: input.startedBy.fromThreadId,
            startedAt: new Date().toISOString(),
            state: "running",
            lastMessage: null,
            checkedAt: null,
          }),
        ).pipe(Effect.ignoreCause({ log: true }));
        yield* Effect.logInfo("remote chat started on another computer").pipe(
          Effect.annotateLogs({
            boxId: input.target.boxId,
            threadId: started.threadId,
            assistant: input.startedBy.assistantProjectId ?? "person",
          }),
        );
        return started;
      });

    const chatStatus: RemoteComputersServiceShape["chatStatus"] = (input) =>
      Effect.gen(function* () {
        const { credential } = yield* identity;
        const client = clientFor(credential);
        const reply = yield* fromPromise(() =>
          client.request({
            boxId: input.boxId,
            computerName: input.computerName,
            method: "GET",
            path: `${REMOTE_CHATS_PATH}/${encodeURIComponent(input.threadId)}`,
          }),
        );
        if (isOutdatedReply(reply, "state")) return yield* outdated(input.computerName);
        if (reply.status !== 200) return yield* refusalFrom(reply, input.computerName);
        const record = asRecord(reply.body)!;
        return {
          threadId: input.threadId as ManagerRemoteChatStatus["threadId"],
          title: typeof record["title"] === "string" ? record["title"] : "",
          state: typeof record["state"] === "string" ? record["state"] : "idle",
          lastMessage: typeof record["lastMessage"] === "string" ? record["lastMessage"] : null,
          updatedAt:
            typeof record["updatedAt"] === "string"
              ? record["updatedAt"]
              : new Date().toISOString(),
        } satisfies ManagerRemoteChatStatus;
      });

    const outgoing: RemoteComputersServiceShape["outgoing"] = Effect.promise(() =>
      readOutgoingRemoteChats(config.stateDir),
    ).pipe(
      Effect.map((list) => list.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))),
      Effect.orElseSucceed(() => []),
    );

    const noteStatus: RemoteComputersServiceShape["noteStatus"] = (threadId, status) =>
      Effect.promise(() =>
        updateOutgoingRemoteChat(config.stateDir, threadId, {
          state: status.state,
          lastMessage: status.lastMessage,
          ...(status.title.length > 0 ? { title: status.title } : {}),
          checkedAt: new Date().toISOString(),
        }),
      ).pipe(Effect.ignoreCause({ log: true }));

    return {
      resolveTarget,
      startChat,
      chatStatus,
      outgoing,
      noteStatus,
    } satisfies RemoteComputersServiceShape;
  });

export const RemoteComputersServiceLive = Layer.effect(
  RemoteComputersService,
  makeRemoteComputersService(),
);

/** The service when it is wired (tests and older wirings run without it). */
export const remoteComputersOption = Effect.serviceOption(RemoteComputersService).pipe(
  Effect.map(Option.getOrNull),
);
