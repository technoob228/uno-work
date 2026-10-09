/**
 * The agent bridge's side of chats on another computer (`POST /api/threads`
 * with another `computerId`, then `GET`/`POST /api/threads/box-N:<id>…`).
 *
 * Trust: the person's own computers trust each other by default — an agent
 * here may start and drive chats on any other computer of the SAME Uno
 * account (the console only lists and opens the account's own computers;
 * other people's and team computers are out of reach by construction). Off
 * switches: "Agents can start chats on my other computers" (Settings →
 * General, this computer), agent access to the account turned off, and on a
 * cloud computer the console's "Add new computers" (it covers connecting).
 * The chat on the other computer never runs with more rights than the
 * calling chat has.
 *
 * @module crossComputer/agentRemoteChats
 */
import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { Effect } from "effect";
import * as crypto from "node:crypto";

import type { AgentThreadsReply, RemoteChatsPort } from "../agentThreads/service.ts";
import {
  formatRemoteThreadId,
  openRemoteSession,
  readRemoteChat,
  RemoteSessionCache,
  RemoteWorkError,
  remoteChatUrl,
  resolveComputer,
  sendRemoteMessage,
  startRemoteChat,
  withRemoteSession,
  type RemoteWorkDeps,
  type UnoBoxRef,
} from "./remoteWork.ts";

export const OTHER_COMPUTERS_OFF_MESSAGE =
  'The person turned off "Agents can start chats on my other computers" (Settings → General). Tell them what you wanted to hand over; don\'t try other ways.';

const NOT_LINKED_MESSAGE =
  "This computer isn't connected to an Uno account, so it can't reach the person's other computers. Tell the person to sign in to Uno in Settings.";

const ACCESS_OFF_MESSAGE =
  "The person turned agent access to their Uno account off (Settings → Uno account → Agent access), so you can't reach their other computers. Tell them; don't try other ways.";

export interface RemoteChatsPolicy {
  readonly apiKey: string;
  readonly agentAccessOff: boolean;
  readonly otherComputersAllowed: boolean;
}

export interface AgentRemoteChatsDeps {
  readonly getPolicy: Effect.Effect<RemoteChatsPolicy>;
  /** The account's computers (id, name, power state), freshly read. */
  readonly listComputers: (apiKey: string) => Promise<ReadonlyArray<UnoBoxRef>>;
  /** This computer's box id (null on a laptop): naming it by name means "here". */
  readonly getOwnBoxId: Effect.Effect<number | null>;
  /** This computer's name, as the person sees it. */
  readonly getOwnLabel: Effect.Effect<string>;
  readonly makeRemoteDeps: (apiKey: string) => RemoteWorkDeps;
  /** This computer's home: a folder the tools already made absolute goes back to `~/…`. */
  readonly home: string;
  readonly cache: RemoteSessionCache;
}

const reply = (status: number, body: Record<string, unknown>): AgentThreadsReply => ({
  status,
  body,
});

const errorReply = (error: unknown): AgentThreadsReply =>
  error instanceof RemoteWorkError
    ? reply(error.status, { ok: false, error: error.code, message: error.message })
    : reply(502, {
        ok: false,
        error: "remote_error",
        message: `The other computer did not answer as expected (${error instanceof Error ? error.message : String(error)}).`,
      });

const keyFingerprint = (apiKey: string) =>
  crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 16);

/**
 * `cwd` arrives absolute for THIS computer (the uno-work tools resolve `~`);
 * on the other computer the home differs, so `~/…` is what is meant.
 */
export function homeRelative(folder: string, home: string): string {
  const trimmed = folder.trim();
  const base = home.replace(/\/+$/, "");
  if (base.length > 0 && (trimmed === base || trimmed.startsWith(`${base}/`))) {
    return `~${trimmed.slice(base.length)}`;
  }
  return trimmed;
}

/** One cache for the daemon: a session per (account key, computer). */
export const daemonRemoteSessions = new RemoteSessionCache();

export function makeAgentRemoteChats(deps: AgentRemoteChatsDeps): RemoteChatsPort {
  const allowed = Effect.gen(function* () {
    const policy = yield* deps.getPolicy;
    if (policy.apiKey.length === 0) {
      return {
        ok: false as const,
        reply: reply(403, { ok: false, error: "not_linked", message: NOT_LINKED_MESSAGE }),
      };
    }
    if (policy.agentAccessOff) {
      return {
        ok: false as const,
        reply: reply(403, { ok: false, error: "account_access_off", message: ACCESS_OFF_MESSAGE }),
      };
    }
    if (!policy.otherComputersAllowed) {
      return {
        ok: false as const,
        reply: reply(403, {
          ok: false,
          error: "computer_not_allowed",
          message: OTHER_COMPUTERS_OFF_MESSAGE,
        }),
      };
    }
    return { ok: true as const, apiKey: policy.apiKey };
  });

  /** Run `body` against computer `boxId` with a (cached) session; errors become replies. */
  const withComputer = (
    caller: OrchestrationThreadShell,
    resolveBox: (apiKey: string) => Promise<UnoBoxRef>,
    body: (input: {
      readonly box: UnoBoxRef;
      readonly from: string;
      readonly remote: RemoteWorkDeps;
      readonly call: <T>(
        fn: (session: Awaited<ReturnType<typeof openRemoteSession>>) => Promise<T>,
      ) => Promise<T>;
    }) => Promise<AgentThreadsReply>,
  ): Effect.Effect<AgentThreadsReply> =>
    Effect.gen(function* () {
      const gate = yield* allowed;
      if (!gate.ok) return gate.reply;
      const ownLabel = yield* deps.getOwnLabel;
      const from = `the agent on ${ownLabel}`;
      const ownBoxId = yield* deps.getOwnBoxId;
      const remote = deps.makeRemoteDeps(gate.apiKey);
      const result = yield* Effect.promise(async (): Promise<AgentThreadsReply> => {
        try {
          const box = await resolveBox(gate.apiKey);
          if (box.id === ownBoxId) {
            throw new RemoteWorkError(
              400,
              "this_computer",
              `${box.name} is this computer: leave computerId out to start the chat here.`,
            );
          }
          const key = `${keyFingerprint(gate.apiKey)}:${box.id}`;
          return await body({
            box,
            from,
            remote,
            call: (fn) =>
              withRemoteSession(
                deps.cache,
                key,
                remote,
                () =>
                  openRemoteSession(remote, { boxId: box.id, clientLabel: `Agent on ${ownLabel}` }),
                fn,
              ),
          });
        } catch (error) {
          return errorReply(error);
        }
      });
      if (result.status >= 500) {
        yield* Effect.logWarning("agent threads: other computer failed", {
          callerThreadId: caller.id,
          status: result.status,
          body: result.body,
        });
      }
      return result;
    });

  const boxById = (boxId: number) => async (apiKey: string) =>
    resolveComputer(await deps.listComputers(apiKey), boxId);

  const start: RemoteChatsPort["start"] = (input) =>
    withComputer(
      input.caller,
      async (apiKey) => resolveComputer(await deps.listComputers(apiKey), input.computer),
      async ({ box, from, remote, call }) => {
        const started = await call((session) =>
          startRemoteChat(remote, session, {
            text: input.text,
            title: input.title,
            folder: input.cwd === undefined ? undefined : homeRelative(input.cwd, deps.home),
            model: input.model,
            from,
            fromChatTitle: input.caller.title,
            runtimeMode: input.caller.runtimeMode,
          }).then((result) => ({ result, session })),
        );
        return reply(200, {
          ok: true,
          threadId: formatRemoteThreadId(box.id, started.result.threadId),
          computer: { id: box.id, name: box.name },
          folder: started.result.folder,
          title: started.result.title,
          url: remoteChatUrl(
            started.session,
            started.result.environmentId,
            started.result.threadId,
          ),
          note: `Started on ${box.name}. Use this threadId with chat_status / chat_message; the person sees the chat in Uno Work on ${box.name}.`,
        });
      },
    );

  const read: RemoteChatsPort["read"] = (input) =>
    withComputer(input.caller, boxById(input.boxId), async ({ box, remote, call }) => {
      const view = await call((session) =>
        readRemoteChat(remote, session, input.threadId, {
          limit: input.limit,
          waitMs: input.waitMs,
        }),
      );
      return reply(200, {
        id: formatRemoteThreadId(box.id, input.threadId),
        computer: { id: box.id, name: box.name },
        ...view,
      });
    });

  const send: RemoteChatsPort["send"] = (input) =>
    withComputer(input.caller, boxById(input.boxId), async ({ box, from, remote, call }) => {
      await call((session) =>
        sendRemoteMessage(remote, session, input.threadId, {
          text: input.text,
          waitMs: input.waitMs,
          from,
          fromChatTitle: input.caller.title,
          runtimeMode: input.caller.runtimeMode,
        }),
      );
      return reply(200, {
        ok: true,
        threadId: formatRemoteThreadId(box.id, input.threadId),
        computer: { id: box.id, name: box.name },
      });
    });

  return { start, read, send };
}
