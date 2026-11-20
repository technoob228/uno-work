/**
 * "A cloud chat asks to start a chat on my computer" (Misha 20.11): both
 * sides in one service.
 *
 * On the person's own computer (a laptop: no `uno.boxToken`), the host:
 * - watches `~/.uno-work/chat-requests/in/` (spool.ts) and admits each
 *   request by the rules (hostLogic.ts): waiting, or refused / expired at once;
 * - shows the waiting ones to the person (`chatRequests.*` RPC → Needs you,
 *   the sidebar, Settings → Computer), who presses Start or Decline;
 * - Start opens an ordinary chat here with the brief framed as the cloud
 *   agent's text (remoteChatHost.ts, so the sidebar says who started it),
 *   held to the rules of this computer (CommandGuardPolicy) before its first
 *   turn;
 * - writes each answer into `out/`, follows a started chat for a day, keeps
 *   `state.json` fresh (every minute) and a journal of requests and decisions.
 *
 * On a cloud computer, the sending side (outgoing.ts) runs the
 * `my_computer_start_chat` tool's requests through the tunnel and tells the
 * chat that asked how they went.
 *
 * @module chatRequests/ChatRequests
 */
import { watch, type FSWatcher } from "node:fs";
import * as crypto from "node:crypto";
import * as os from "node:os";

import {
  ChatRequestsError,
  CommandId,
  MessageId,
  ThreadId,
  type ChatRequestDecideInput,
  type ChatRequestDecideResult,
  type ChatRequestsSetAllowedInput,
  type ChatRequestsState,
} from "@t3tools/contracts";
import { Context, Effect, Layer, Option, Schedule } from "effect";

import packageJson from "../../package.json" with { type: "json" };
import { ServerConfig } from "../config.ts";
import { readWorkMachineIdentity } from "../manager/workConsole.ts";
import { MyComputerService } from "../myComputer/MyComputerService.ts";
import { MyComputerFailure } from "../myComputer/myComputerCore.ts";
import { systemCommandOrigin } from "../orchestration/commandOrigin.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeHost } from "../remoteComputers/http.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { parseSettingsBoxId } from "../unoBoxIdentity.ts";
import { UnoCloudService } from "../workspaceRegistry/UnoCloudService.ts";
import { makeChatRequestsHost } from "./host.ts";
import { makeOutgoing, type Outgoing } from "./outgoing.ts";
import { ensureSpool } from "./spool.ts";

const COMPONENT = "chat-requests";
const HOST_TICK = "5 seconds";
const OUTGOING_TICK = "20 seconds";

export interface ChatRequestsShape {
  readonly state: Effect.Effect<ChatRequestsState, ChatRequestsError>;
  readonly decide: (
    input: ChatRequestDecideInput,
  ) => Effect.Effect<ChatRequestDecideResult, ChatRequestsError>;
  readonly setAllowed: (
    input: ChatRequestsSetAllowedInput,
  ) => Effect.Effect<ChatRequestsState, ChatRequestsError>;
  /** The sending side (a cloud computer with "Connect my computer"); null elsewhere. */
  readonly outgoing: Outgoing | null;
}

export class ChatRequests extends Context.Service<ChatRequests, ChatRequestsShape>()(
  "t3/chatRequests/ChatRequests",
) {}

const fail = (message: string) => new ChatRequestsError({ message });
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export const ChatRequestsLive = Layer.effect(
  ChatRequests,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const settings = yield* ServerSettingsService;
    const engine = yield* OrchestrationEngineService;
    const projections = yield* ProjectionSnapshotQuery;
    const host = yield* makeHost;
    const myComputer = Option.getOrNull(yield* Effect.serviceOption(MyComputerService));
    const cloud = Option.getOrNull(yield* Effect.serviceOption(UnoCloudService));
    // A laptop or desktop: the person's own computer, where requests arrive.
    const isOwnComputerNow = settings.getSettings.pipe(
      Effect.map((value) => readWorkMachineIdentity(value.uno) === null),
      Effect.orElseSucceed(() => true),
    );
    const hostSide = yield* makeChatRequestsHost({
      stateDir: config.stateDir,
      host,
      isOwnComputer: isOwnComputerNow,
      app: `uno-work ${packageJson.version}`,
    });
    const stateDir = config.stateDir;
    const io = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({ try: run, catch: (cause) => fail(errorText(cause)) });

    // ── The sending side ────────────────────────────────────────────────
    const runFork = Effect.runPromise;
    const tell = (threadId: string, text: string) =>
      Effect.gen(function* () {
        const shell = Option.getOrNull(
          yield* projections.getThreadShellById(ThreadId.make(threadId)),
        );
        if (shell === null || shell.archivedAt !== null) return "gone" as const;
        const status = shell.session?.status;
        if (
          status === "starting" ||
          status === "running" ||
          shell.session?.activeTurnId != null ||
          shell.hasPendingApprovals ||
          shell.hasPendingUserInput
        ) {
          return "busy" as const;
        }
        yield* engine.dispatch(
          {
            type: "thread.turn.start",
            commandId: CommandId.make(`${COMPONENT}:tell:${crypto.randomUUID()}`),
            threadId: ThreadId.make(threadId),
            message: {
              messageId: MessageId.make(crypto.randomUUID()),
              role: "user",
              text,
              attachments: [],
            },
            runtimeMode: shell.runtimeMode,
            interactionMode: shell.interactionMode,
            createdAt: new Date().toISOString(),
          },
          { origin: systemCommandOrigin(COMPONENT, "answer from the person's computer") },
        );
        return "told" as const;
      });

    const outgoing: Outgoing | null =
      myComputer === null
        ? null
        : makeOutgoing({
            stateDir,
            computers: () =>
              myComputer.core.cachedStatus(15_000).then((status) => status.computers),
            read: async (computerId, path) => {
              try {
                const read = await myComputer.core.read({
                  computerId,
                  path,
                  maxBytes: 512 * 1024,
                  quiet: true,
                });
                return read.data.toString("utf8");
              } catch (cause) {
                // The helper's "no such file" comes back as a remote failure.
                if (cause instanceof MyComputerFailure && cause.kind === "remote") return null;
                throw cause;
              }
            },
            write: async (computerId, path, text) => {
              await myComputer.core.write({
                computerId,
                path,
                data: Buffer.from(text, "utf8"),
                mkdirs: true,
                quiet: true,
              });
            },
            note: (computerId, summary, threadId) =>
              myComputer.core.note(computerId, "chat", summary, threadId),
            tell: (threadId, text) =>
              runFork(tell(threadId, text).pipe(Effect.orElseSucceed(() => "busy" as const))),
            ownName: () =>
              runFork(
                Effect.gen(function* () {
                  const value = yield* settings.getSettings;
                  const boxId = parseSettingsBoxId(value.uno.boxId);
                  if (boxId === null || cloud === null) {
                    return os.hostname().replace(/\.local$/, "") || "a cloud computer";
                  }
                  const known = yield* cloud.getState();
                  return known.boxes.find((box) => box.id === boxId)?.name ?? `box-${boxId}`;
                }).pipe(Effect.orElseSucceed(() => os.hostname() || "a cloud computer")),
              ),
            ownBoxId: () =>
              runFork(
                settings.getSettings.pipe(
                  Effect.map((value) => parseSettingsBoxId(value.uno.boxId)),
                  Effect.orElseSucceed(() => null),
                ),
              ),
          });

    // ── Loops ───────────────────────────────────────────────────────────
    const quietly =
      (label: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.asVoid,
          Effect.catchCause((cause) => Effect.logWarning(`${label} failed`, { cause })),
        );

    yield* Effect.forkScoped(
      hostSide.tick.pipe(
        quietly("chat requests: host round"),
        Effect.repeat(Schedule.spaced(HOST_TICK)),
      ),
    );
    // A new request shows within a moment, not at the next round.
    let watcher: FSWatcher | null = null;
    yield* Effect.addFinalizer(() => Effect.sync(() => watcher?.close()));
    if (yield* isOwnComputerNow) {
      yield* io(() => ensureSpool(hostSide.paths)).pipe(Effect.ignoreCause({ log: false }));
      try {
        watcher = watch(hostSide.paths.incoming, () => {
          void Effect.runPromise(hostSide.tick.pipe(quietly("chat requests: host round")));
        });
        watcher.on("error", () => watcher?.close());
      } catch {
        watcher = null;
      }
    }
    if (outgoing !== null) {
      yield* Effect.forkScoped(
        io(() => outgoing.tick()).pipe(
          quietly("chat requests: outgoing round"),
          Effect.repeat(Schedule.spaced(OUTGOING_TICK)),
        ),
      );
    }

    return {
      state: hostSide.state,
      decide: hostSide.decide,
      setAllowed: hostSide.setAllowed,
      outgoing,
    } satisfies ChatRequestsShape;
  }),
);
