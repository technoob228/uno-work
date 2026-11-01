/**
 * ChatImportService: the chat import (`chatImport.ts`) wired to the daemon: the
 * computer's tunnel, the orchestration engine and this computer's state folder.
 *
 * @module myComputer/import/ChatImportService
 */
import {
  MyComputerError,
  ProjectId,
  ThreadId,
  type ImportedChatTool,
  type MyComputerChatHistory,
  type MyComputerImportStatus,
  type OrchestrationCommandOrigin,
} from "@t3tools/contracts";
import { Context, Effect, Layer, Option } from "effect";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { MyComputerService } from "../MyComputerService.ts";
import { createChatImport, type ChatImport } from "./chatImport.ts";

const ORIGIN: OrchestrationCommandOrigin = { kind: "system", component: "my-computer-import" };

export interface ChatImportShape {
  readonly status: (computerId: string) => Effect.Effect<MyComputerImportStatus, MyComputerError>;
  readonly scan: (computerId: string) => Effect.Effect<MyComputerImportStatus, MyComputerError>;
  readonly start: (
    computerId: string,
    tools: ReadonlyArray<ImportedChatTool>,
  ) => Effect.Effect<MyComputerImportStatus, MyComputerError>;
  readonly decline: (computerId: string) => Effect.Effect<MyComputerImportStatus, MyComputerError>;
  readonly history: (threadId: string) => Effect.Effect<MyComputerChatHistory, MyComputerError>;
}

export class ChatImportService extends Context.Service<ChatImportService, ChatImportShape>()(
  "t3/myComputer/import/ChatImportService",
) {}

const toError = (cause: unknown) =>
  new MyComputerError({
    message: (cause instanceof Error ? cause.message : String(cause)).trim() || "It didn't work.",
  });

function chatImportShape(chats: ChatImport): ChatImportShape {
  const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: toError });
  return {
    status: (computerId) => attempt(() => chats.status(computerId)),
    scan: (computerId) => attempt(() => chats.scan(computerId)),
    start: (computerId, tools) => attempt(() => chats.start(computerId, tools)),
    decline: (computerId) => attempt(() => chats.decline(computerId)),
    history: (threadId) => attempt(() => chats.history(threadId)),
  };
}

const make = Effect.gen(function* () {
  const { core } = yield* MyComputerService;
  const config = yield* ServerConfig;
  const engine = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;

  const chats = createChatImport({
    stateDir: config.stateDir,
    baseDir: config.baseDir,
    core,
    dispatch: (command) =>
      Effect.runPromise(engine.dispatch(command, { origin: ORIGIN }).pipe(Effect.asVoid)),
    getThread: (threadId) =>
      Effect.runPromise(
        projections.getThreadShellById(ThreadId.make(threadId)).pipe(
          Effect.map(
            Option.match({
              onNone: () => null,
              onSome: (thread) => ({
                title: thread.title,
                snoozedUntil: thread.snoozedUntil ?? null,
                source: thread.source ?? null,
              }),
            }),
          ),
        ),
      ),
    projectExists: (projectId) =>
      Effect.runPromise(
        projections.getProjectShellById(ProjectId.make(projectId)).pipe(Effect.map(Option.isSome)),
      ),
    warn: (message) => {
      Effect.runFork(Effect.logWarning(message));
    },
  });
  return chatImportShape(chats);
});

export const ChatImportServiceLive = Layer.effect(ChatImportService, make);
