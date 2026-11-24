/**
 * T51: the agent's tools for the people of its project (uno-work MCP).
 *
 * - `team_members` — who is in the project and what this person's agent
 *   may do with each (the level in effect: Off, Through them, Answer
 *   questions, Do tasks).
 * - `team_request` — a message, a question or "a session on your
 *   computer" to one of them, from this chat (`agent-requests`): the cloud
 *   checks the level, the rounds and the limits; the answer comes back into
 *   this chat as a note from Uno Work.
 *
 * Only the person's own chats ask: not an assistant's, not a chat holding
 * text from outside (a colleague's words included), not a chat started at
 * a cloud chat's or a colleague's request (those keep to a few tools).
 * Except on the person's Uno assistant computer (Misha 23.11): there its
 * chats may ask; the cloud marks the request "from <name>'s assistant",
 * never lets it start or answer anything on its own, and the colleague's
 * side reads it as outside text.
 *
 * @module team/teamTools
 */
import { Effect } from "effect";

import type { UnoWorkTool, UnoWorkToolDeps, UnoWorkToolError } from "../unoWork/tools.ts";
import type { TeamCollabShape } from "./TeamCollab.ts";
import { TeamCloudError } from "./teamCloud.ts";
import {
  personName,
  type TeamLevels,
  type TeamMember,
  type TeamProject,
} from "./teamCloud.logic.ts";

export const TEAM_TOOL_NAMES = ["team_members", "team_request"] as const;

export interface TeamToolKit {
  readonly fail: (message: string) => UnoWorkToolError;
}

const LEVEL_WORDS: Readonly<Record<string, string>> = {
  off: "off: your agent can't reach them",
  ask: "through them: every request waits for their answer",
  answer: "answer questions: their agent answers your questions on its own",
  tasks: "do tasks: a session you ask for may start on their computer on its own",
};

export const TEAM_REFUSALS = {
  notHere:
    "Working with the team isn't on in this Uno Work. Tell the person; don't try another way.",
  off: "Working with the team isn't on for this account. Tell the person if it matters.",
  assistant: (name: string) =>
    `${name} is an assistant: only the person's own chats write to their colleagues. Tell the person what you'd want to ask.`,
  outside:
    "This chat holds text from outside (a form, a mail, a colleague's message), so it can't write to the person's colleagues. Tell the person what you'd want to ask.",
} as const;

const str = (args: Record<string, unknown>, key: string): string | undefined =>
  typeof args[key] === "string" && (args[key] as string).trim().length > 0
    ? (args[key] as string).trim()
    : undefined;

/** The project the call means: by name or number, else this chat's, else the only one. */
export function pickProject(
  projects: ReadonlyArray<TeamProject>,
  asked: string | undefined,
  chatsProjectId: number | null,
): { readonly project: TeamProject } | { readonly problem: string } {
  if (projects.length === 0) {
    return {
      problem:
        "The person isn't in any team project. Projects with people are set up in Uno Work's project settings → Team.",
    };
  }
  const names = projects.map((project) => `“${project.name}”`).join(", ");
  if (asked !== undefined) {
    const lower = asked.toLowerCase();
    const found =
      projects.find((project) => String(project.id) === asked) ??
      projects.find((project) => project.name.toLowerCase() === lower);
    return found !== undefined
      ? { project: found }
      : { problem: `No team project “${asked}”. The person's team projects: ${names}.` };
  }
  const own = projects.find((project) => project.id === chatsProjectId);
  if (own !== undefined) return { project: own };
  if (projects.length === 1) return { project: projects[0]! };
  return { problem: `Say which project: ${names}.` };
}

/** A colleague by email, username, name or number. */
export function pickMember(members: ReadonlyArray<TeamMember>, asked: string): TeamMember | null {
  const lower = asked.trim().toLowerCase().replace(/^@/, "");
  return (
    members.find((member) => String(member.userId) === lower) ??
    members.find((member) => member.email?.toLowerCase() === lower) ??
    members.find((member) => member.username?.toLowerCase() === lower) ??
    members.find((member) => personName(member).toLowerCase() === lower) ??
    null
  );
}

/** The cloud's refusal as one line the agent acts on. */
export function requestRefusal(
  error: unknown,
  name: string,
  project: string,
  kind?: "message" | "question" | "session",
): string {
  if (!(error instanceof TeamCloudError)) {
    return `Couldn't send it: ${error instanceof Error ? error.message : String(error)}`;
  }
  switch (error.code) {
    case "LEVEL_OFF":
      return `LEVEL_OFF: in ${project}, your agent can't reach ${name} (the level is Off). Don't try again; tell the person if it matters.`;
    case "TOO_MANY_ROUNDS":
      return `TOO_MANY_ROUNDS: the agents went back and forth too many times on this. Call people: tell the person here what is open (chat_call_person) instead of asking again.`;
    case "TOO_MANY_SESSIONS":
      return `TOO_MANY_SESSIONS: ${name} already has 2 sessions from colleagues. Try later, or send a message instead.`;
    case "PERSON_NOT_ENABLED":
      return `PERSON_NOT_ENABLED: working with the team isn't on for ${name} yet (or not for questions to their agent). Send a message instead, or tell the person.`;
    case "CANNOT_TARGET_SELF":
      return "CANNOT_TARGET_SELF: that's the person themself. Pick a colleague from team_members.";
    case "INVALID_FIELD":
      return `INVALID_FIELD: the cloud didn't accept ${error.field || "a field"}. Make it shorter or fix it and send once more.`;
    case "BODY_TOO_LARGE":
      return "BODY_TOO_LARGE: the request is too long. Shorten the text (at most 20000 characters) and send once more.";
    default:
      if (error.status === 429) {
        return "RATE_LIMIT: 20 requests an hour from one person to colleagues. Wait, or put it all in one request.";
      }
      if (error.code === "WORK_TEAM_COLLAB_DISABLED" && kind === "question") {
        return "Questions to colleagues' agents aren't on for this account. Send a message instead, or tell the person.";
      }
      return error.off ? TEAM_REFUSALS.off : `Couldn't send it: ${error.message}`;
  }
}

/** One line the person reads first on the request. */
const gistOf = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  const sentence = /^(.{20,200}?[.!?])\s/.exec(line)?.[1] ?? line;
  return sentence.length <= 200 ? sentence : `${sentence.slice(0, 199)}…`;
};

export function teamTools(kit: TeamToolKit): ReadonlyArray<UnoWorkTool> {
  const teamOf = (deps: UnoWorkToolDeps) =>
    deps.team ? Effect.succeed(deps.team) : Effect.fail(kit.fail(TEAM_REFUSALS.notHere));

  const on = (team: TeamCollabShape) =>
    Effect.promise(() => team.parts.get()).pipe(
      Effect.flatMap((parts) =>
        parts.requests ? Effect.succeed(parts) : Effect.fail(kit.fail(TEAM_REFUSALS.off)),
      ),
    );

  const projectFor = (deps: UnoWorkToolDeps, team: TeamCollabShape, asked: string | undefined) =>
    Effect.gen(function* () {
      const projects = yield* team.teamProjects.pipe(
        Effect.mapError((error) => kit.fail(error.message)),
      );
      const here = deps.caller.cwd ? yield* team.projectOfFolder(deps.caller.cwd) : null;
      const picked = pickProject(projects, asked, here?.teamProjectId ?? null);
      if ("problem" in picked) return yield* kit.fail(picked.problem);
      return picked.project;
    });

  const peopleOf = (team: TeamCollabShape, project: TeamProject) =>
    Effect.gen(function* () {
      const [members, levels] = yield* Effect.all(
        [
          Effect.tryPromise({
            try: () => team.cloud.members(project.id),
            catch: (error) => kit.fail(requestRefusal(error, "them", project.name)),
          }),
          Effect.promise(() => team.cloud.levels(project.id).catch((): TeamLevels | null => null)),
        ],
        { concurrency: 2 },
      );
      return { members, levels };
    });

  const mayAsk = (deps: UnoWorkToolDeps) =>
    Effect.gen(function* () {
      const team = yield* teamOf(deps);
      if (yield* team.onAssistantComputer) return team;
      const assistant = deps.callerAssistantName ? yield* deps.callerAssistantName : null;
      if (assistant !== null) return yield* kit.fail(TEAM_REFUSALS.assistant(assistant));
      if (deps.outsideText && (yield* deps.outsideText)) {
        return yield* kit.fail(TEAM_REFUSALS.outside);
      }
      return team;
    });

  return [
    {
      name: "team_members",
      group: "chats",
      description:
        "The people of a team project (the person's colleagues) and what your agent may do with each: the level in effect, set by the project's owner (Off · Through them — every request waits for their answer · Answer questions — their agent answers on its own · Do tasks — a session may start on their computer on its own). Leave project out for this chat's project. Use team_request to write to one of them.",
      inputSchema: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description: "The team project's name (or number). Leave it out for this chat's.",
            minLength: 1,
            maxLength: 200,
          },
        },
        additionalProperties: false,
      },
      level: "safe",
      run: (deps, args) =>
        Effect.gen(function* () {
          const team = yield* teamOf(deps);
          yield* on(team);
          const project = yield* projectFor(deps, team, str(args, "project"));
          const { members, levels } = yield* peopleOf(team, project);
          return {
            project: { id: project.id, name: project.name, yourRole: project.role },
            people: members.map((member) => {
              const level = levels?.effectiveOut[String(member.userId)] ?? null;
              return {
                name: personName(member),
                email: member.email,
                role: member.role,
                yourAgent: level === null ? null : (LEVEL_WORDS[level] ?? level),
              };
            }),
            note: "yourAgent is null for the person themself (and when the levels couldn't be read).",
          };
        }),
    },
    {
      name: "team_request",
      group: "chats",
      description: [
        "Write to one of the person's colleagues in a team project, from this chat: kind `message` (they read it), `question` (they — or their agent, at Answer questions — answer it), or `session` (a chat starts on their computer for the work in `text`: they press Start, or it starts on its own at Do tasks; it can't push, deploy or read their keys).",
        "The cloud checks the level the owner set (team_members): Off refuses; at most 20 requests an hour; at most 2 sessions from colleagues at once per person; agents can't go back and forth forever — when it says to call people, tell the person here instead.",
        "Write it as your own request to a colleague, with everything they need (they can't see this chat). Never put keys or passwords in it.",
        "The answer comes back into this chat as a note from Uno Work — don't poll; go on or end your turn.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description: "Who: their email or name as team_members shows it.",
            minLength: 1,
            maxLength: 200,
          },
          kind: { type: "string", enum: ["message", "question", "session"] },
          project: {
            type: "string",
            description: "The team project's name. Leave it out for this chat's project.",
            minLength: 1,
            maxLength: 200,
          },
          title: {
            type: "string",
            description: "A few words: what it is about.",
            minLength: 1,
            maxLength: 120,
          },
          text: {
            type: "string",
            description:
              "The message, the question, or the session's brief (the first message of the chat there).",
            minLength: 1,
            maxLength: 20_000,
          },
        },
        required: ["to", "kind", "title", "text"],
        additionalProperties: false,
      },
      level: "change",
      approvalTitle: (args) =>
        `Write to ${str(args, "to") ?? "a colleague"}: “${str(args, "title") ?? ""}”`,
      prepare: (deps) => mayAsk(deps).pipe(Effect.asVoid),
      run: (deps, args) =>
        Effect.gen(function* () {
          const team = yield* mayAsk(deps);
          yield* on(team);
          const kind = str(args, "kind");
          if (kind !== "message" && kind !== "question" && kind !== "session") {
            return yield* kit.fail("kind is message, question or session.");
          }
          const project = yield* projectFor(deps, team, str(args, "project"));
          const { members } = yield* peopleOf(team, project);
          const asked = str(args, "to") ?? "";
          const member = pickMember(members, asked);
          if (member === null) {
            const names = members.map((entry) => entry.email ?? personName(entry)).join(", ");
            return yield* kit.fail(`No one “${asked}” in ${project.name}. Its people: ${names}.`);
          }
          const name = personName(member);
          const text = str(args, "text") ?? "";
          const title = (str(args, "title") ?? gistOf(text)).slice(0, 120);
          const source = yield* team.source;
          const request = yield* Effect.tryPromise({
            try: () =>
              team.cloud.agentRequest(project.id, {
                to: member.userId,
                kind,
                title,
                gist: gistOf(text),
                body: text,
                fromSource: source,
                fromThread: deps.caller.threadId,
                fromChatTitle: deps.caller.threadTitle,
              }),
            catch: (error) => kit.fail(requestRefusal(error, name, project.name, kind)),
          });
          return {
            request: {
              id: request.id,
              to: name,
              project: project.name,
              kind: request.kind,
              status: request.status,
              level: request.level,
              startsOnItsOwn: request.auto,
            },
            note: "Sent. How it goes (and the answer) comes back into this chat as a note from Uno Work — don't poll; go on or end your turn.",
          };
        }),
    },
  ];
}
