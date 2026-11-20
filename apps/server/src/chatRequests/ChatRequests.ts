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
 * chat that asked how they went; once a request waits there, the person's
 * Telegram gets it too with Start / Decline (messenger.ts), and a press
 * there is decided on that computer like its own button.
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
import { pickPersonChats } from "../manager/connectorNotify.ts";
import { detectReplyLanguage } from "../manager/connectorReplyText.ts";
import { ConnectorNotifyService } from "../manager/Services/ConnectorNotify.ts";
import { MyComputerService } from "../myComputer/MyComputerService.ts";
import { MyComputerFailure } from "../myComputer/myComputerCore.ts";
import { systemCommandOrigin } from "../orchestration/commandOrigin.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeHost } from "../remoteComputers/http.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { parseSettingsBoxId } from "../unoBoxIdentity.ts";
import { UnoCloudService } from "../workspaceRegistry/UnoCloudService.ts";
import { OutsideThreads } from "../automations/outsideThreads.ts";
import { makeChatRequestsHost, type TeamHostShape } from "./host.ts";
import {
  chatRequestButtons,
  chatRequestMessageText,
  chatRequestSettledLine,
  setChatRequestDecider,
} from "./messenger.ts";
import {
  makeOutgoing,
  PICKUP_GRACE_MS,
  type Outgoing,
  type OutgoingMessenger,
  type OutRecord,
} from "./outgoing.ts";
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
  /** T51: a colleague's requests, for the team bridge (team/bridge.ts). */
  readonly team: TeamHostShape;
  /** A laptop or desktop (no machine token): the person's own computer. */
  readonly isOwnComputer: Effect.Effect<boolean>;
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
    const notify = Option.getOrNull(yield* Effect.serviceOption(ConnectorNotifyService));
    const outside = Option.getOrNull(yield* Effect.serviceOption(OutsideThreads));
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
      // T51: a colleague's words, outside text (T49); without the record, no start.
      markOutside: (threadId) =>
        outside === null
          ? Effect.fail(fail("Outside text can't be marked here, so a colleague's chat can't start."))
          : outside.mark(threadId),
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

    // The person's Telegram: the request with Start / Decline, only where
    // Telegram is linked (Misha: "Telegram: only needs-you and approvals").
    const languageOf = (record: OutRecord) =>
      detectReplyLanguage(`${record.request.title}\n${record.request.gist}`, null);
    const announce = (record: OutRecord) =>
      Effect.gen(function* () {
        if (notify === null) return;
        const threadId = ThreadId.make(record.threadId);
        const shell = Option.getOrNull(yield* projections.getThreadShellById(threadId));
        const chats = pickPersonChats(
          yield* notify.resolveChats({
            threadId,
            projectId: shell?.projectId ?? null,
            includeAssistantFallback: true,
          }),
        );
        if (!chats.some((chat) => chat.kind === "telegram")) return;
        const language = languageOf(record);
        const now = Date.now();
        yield* notify.sendToPerson({
          threadId,
          text: chatRequestMessageText(record, language, now),
          textWithoutButtons: chatRequestMessageText(record, language, now, false),
          buttons: chatRequestButtons(record.id, language),
          // Past its 2 h and the pickup grace: the last line still finds the message.
          buttonsTtlMs: Math.max(60_000, Date.parse(record.expiresAt) - now) + 2 * PICKUP_GRACE_MS,
          language,
          approval: true,
        });
      });
    const messenger: OutgoingMessenger | undefined =
      notify === null
        ? undefined
        : {
            announce: (record) => runFork(announce(record).pipe(Effect.ignoreCause({ log: true }))),
            settle: (record) =>
              runFork(
                notify.retireButtons(record.id, (language) =>
                  chatRequestSettledLine(record, language),
                ),
              ),
          };

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
            messenger,
          });
    if (outgoing !== null) {
      setChatRequestDecider(outgoing.decideFromMessenger);
      yield* Effect.addFinalizer(() => Effect.sync(() => setChatRequestDecider(null)));
    }

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
    // So does a Start pressed in the person's Telegram (`decisions/`).
    const watchers: Array<FSWatcher> = [];
    yield* Effect.addFinalizer(() => Effect.sync(() => watchers.forEach((entry) => entry.close())));
    if (yield* isOwnComputerNow) {
      yield* io(() => ensureSpool(hostSide.paths)).pipe(Effect.ignoreCause({ log: false }));
      for (const dir of [hostSide.paths.incoming, hostSide.paths.decisions]) {
        try {
          const watcher = watch(dir, () => {
            void Effect.runPromise(hostSide.tick.pipe(quietly("chat requests: host round")));
          });
          watcher.on("error", () => watcher.close());
          watchers.push(watcher);
        } catch {
          // The 5-second round still picks it up.
        }
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
      team: hostSide.team,
      isOwnComputer: isOwnComputerNow,
    } satisfies ChatRequestsShape;
  }),
);
