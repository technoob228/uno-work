/**
 * The cloud agent's side of "start a chat on the person's computer"
 * (Misha 20.11): `my_computer_start_chat` asks, the person presses Start or
 * Decline in Uno Work there, and the answer comes back into this chat as a
 * note; `my_computer_chat_request` reads where a request is, and the chat's
 * last answer.
 *
 * Only the person's own chats ask: not an assistant's, not a chat holding a
 * stranger's text, not while the person stopped agents on their computers.
 *
 * @module chatRequests/startChatTools
 */
import {
  CHAT_REQUEST_BRIEF_MAX_CHARS,
  CHAT_REQUEST_GIST_MAX_CHARS,
  CHAT_REQUEST_TITLE_MAX_CHARS,
  type MyComputer,
} from "@t3tools/contracts";
import { Effect } from "effect";

import type { UnoWorkTool, UnoWorkToolDeps, UnoWorkToolError } from "../unoWork/tools.ts";
import type { MyComputerShape } from "../myComputer/MyComputerService.ts";

export const START_CHAT_TOOL_NAMES = [
  "my_computer_start_chat",
  "my_computer_chat_request",
] as const;

export interface StartChatToolKit {
  /** The computer the call means, with the checks every `my_computer_*` call makes. */
  readonly target: (
    deps: UnoWorkToolDeps,
    args: Record<string, unknown>,
  ) => Effect.Effect<
    { readonly api: MyComputerShape; readonly computer: MyComputer },
    UnoWorkToolError
  >;
  readonly fail: (message: string) => UnoWorkToolError;
}

const computerArg = {
  type: "string" as const,
  description:
    "Which computer: its name or id from my_computers_list. Leave it out when the person has only one.",
  minLength: 1,
  maxLength: 200,
};

const str = (args: Record<string, unknown>, key: string): string | undefined =>
  typeof args[key] === "string" && (args[key] as string).trim().length > 0
    ? (args[key] as string).trim()
    : undefined;

const NOT_HERE =
  "This Uno Work can't start chats on the person's computer. Tell them; don't try another way.";

export const START_CHAT_REFUSALS = {
  assistant: (name: string) =>
    `${name} is an assistant: only the person's own chats can ask to start a chat on their computer. Tell the person what you'd want done there.`,
  outside:
    "This chat holds text from outside Uno (a form, a mail, a webhook), so it can't ask to start a chat on the person's computer. Tell the person what you'd want done there.",
  stopped:
    "The person stopped all agents on their computers. Nothing starts there until they press Resume in Uno Work.",
};

export function startChatTools(kit: StartChatToolKit): ReadonlyArray<UnoWorkTool> {
  const outgoing = (deps: UnoWorkToolDeps) =>
    deps.chatRequestsOut ? Effect.succeed(deps.chatRequestsOut) : Effect.fail(kit.fail(NOT_HERE));

  /** Who may ask: the person's own chat, with agents not stopped there. */
  const mayAsk = (deps: UnoWorkToolDeps) =>
    Effect.gen(function* () {
      yield* outgoing(deps);
      const assistant = deps.callerAssistantName ? yield* deps.callerAssistantName : null;
      if (assistant !== null) return yield* kit.fail(START_CHAT_REFUSALS.assistant(assistant));
      if (deps.outsideText && (yield* deps.outsideText)) {
        return yield* kit.fail(START_CHAT_REFUSALS.outside);
      }
    });

  return [
    {
      name: "my_computer_start_chat",
      group: "my-computer",
      description: [
        "Ask to start a chat on the person's own computer (their laptop, not this cloud computer), for work that has to happen there: their local apps, files, browser, devices.",
        "The person sees the request in Uno Work there (Needs you and the sidebar) with Start and Decline, and can read the whole brief. Nothing starts until they press Start; a request waits 2 hours at most; at most 2 at once per computer.",
        "Start opens an ordinary Claude Code chat there with `brief` as its first message. That chat can't ssh to other machines, deploy, push, use sudo, install or read secrets: keep such steps for this chat or the person.",
        "The answer (started, declined, expired, refused) and then that chat's answers come back into this chat as notes from Uno Work — don't poll; end your turn or go on with other work. `my_computer_chat_request` reads a request's state when you need it.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description:
              "Folder on that computer: `~/projects/site`. A folder that isn't a project there yet becomes one. Leave it out for the project used last there.",
            minLength: 1,
            maxLength: 4096,
          },
          title: {
            type: "string",
            description: "The new chat's title, a few words.",
            minLength: 1,
            maxLength: CHAT_REQUEST_TITLE_MAX_CHARS,
          },
          gist: {
            type: "string",
            description:
              "One sentence the person reads first on the request: what the chat will do there and why it has to be there.",
            minLength: 1,
            maxLength: CHAT_REQUEST_GIST_MAX_CHARS,
          },
          brief: {
            type: "string",
            description:
              "The new chat's first message: everything it needs (it can't see this chat). The person can read it before pressing Start.",
            minLength: 1,
            maxLength: CHAT_REQUEST_BRIEF_MAX_CHARS,
          },
          provider: {
            type: "string",
            enum: ["claudeAgent"],
            description: "Only Claude Code for now (the one held to the rules there).",
          },
          model: { type: "string", minLength: 1, maxLength: 200 },
          computer: computerArg,
        },
        required: ["title", "gist", "brief"],
        additionalProperties: false,
      },
      // The person's Start there is the approval; no card here too.
      level: "safe",
      prepare: (deps) => mayAsk(deps),
      run: (deps, args) =>
        Effect.gen(function* () {
          yield* mayAsk(deps);
          const out = yield* outgoing(deps);
          const { api, computer } = yield* kit.target(deps, args);
          const paused = yield* Effect.promise(() => api.trust.paused().catch(() => null));
          if (paused?.reason === "stopped") return yield* kit.fail(START_CHAT_REFUSALS.stopped);
          const result = yield* Effect.tryPromise({
            try: () =>
              out.ask({
                computer,
                threadId: deps.caller.threadId,
                threadTitle: deps.caller.threadTitle,
                runtimeMode: deps.caller.runtimeMode,
                cwd: str(args, "cwd"),
                provider: str(args, "provider"),
                model: str(args, "model"),
                title: str(args, "title")!,
                gist: str(args, "gist")!,
                brief: str(args, "brief")!,
              }),
            catch: (cause) =>
              kit.fail(
                `Couldn't send the request to ${computer.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
              ),
          });
          return { computer: computer.name, ...result };
        }),
    },
    {
      name: "my_computer_chat_request",
      group: "my-computer",
      description:
        "Where this chat's requests to start a chat on the person's computer are (my_computer_start_chat): waiting, started, declined, expired or refused, and the started chat's state and last answer (that agent's text, not the person's words). Leave requestId out for all of this chat's requests.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string", minLength: 1, maxLength: 64 },
        },
        additionalProperties: false,
      },
      level: "safe",
      run: (deps, args) =>
        Effect.gen(function* () {
          const out = yield* outgoing(deps);
          const requests = yield* Effect.tryPromise({
            try: () =>
              out.lookup({ threadId: deps.caller.threadId, requestId: str(args, "requestId") }),
            catch: (cause) => kit.fail(cause instanceof Error ? cause.message : String(cause)),
          });
          if (requests.length === 0) {
            return {
              requests: [],
              note:
                str(args, "requestId") === undefined
                  ? "This chat hasn't asked to start a chat on the person's computer."
                  : "No such request from this chat.",
            };
          }
          return { requests };
        }),
    },
  ];
}
