/**
 * The person's team of assistants on this computer (decisions 14.10, 16.10;
 * strategy/TEAMMATES_GROOMING.md §2–3.5):
 *
 * - an assistant sets itself up in a chat — `assistant_profile_get` /
 *   `assistant_profile_set` save each answer at once and keep the progress,
 *   so a restarted setup goes on where it stopped; `ask_user` shows the
 *   question as a card (Hermes asks none itself, see `askCards.ts`);
 * - an assistant only narrows its own rights; widening is the person's, on
 *   its page;
 * - an assistant sets up a helper (`assistant_create`) without asking, but
 *   never wider than itself (child ⊆ parent: preset, projects, app levels —
 *   checked here, not in the prompt), and the person gets an Inbox notice;
 * - cutting an assistant's rights cuts what it set up, all the way down
 *   (with "who lost what"); revoking or deleting one takes its helpers along.
 *
 * Rights stay where the daemon enforces them: the preset and projects on the
 * assistant's token (`assistantAccess.ts`), app levels in `apps.json`. The
 * team record (`teamStore.ts`) holds who it is and who set it up.
 *
 * On a shared computer this is protection against accidents, not a wall —
 * every assistant runs as the same system user (the UI says so).
 *
 * @module assistants/assistantTeam
 */
import {
  ASSISTANT_PROJECT_ID,
  AssistantRevokeInput,
  AssistantTeamUpdateInput,
  ManagerAskUserInput,
  ManagerAssistantCreateInput,
  ManagerAssistantProfileSetInput,
  ProjectId,
  type AssistantPreset,
  type AssistantSetupStepId,
  type ManagerAssistantTeam,
  type ManagerAssistantTeamView,
  type ManagerProjectAllowlist,
  type ThreadId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import {
  applyMailPatch,
  assistantMailAddress,
  mailPolicyBeyond,
  mailPolicyLine,
} from "@t3tools/shared/assistantMail";
import { ASSISTANT_PRESET_COPY, assistantPresetAllows } from "@t3tools/shared/assistantPreset";
import {
  ASSISTANT_SETUP_STEPS,
  clampGrant,
  grantAppLevel,
  grantBeyond,
  setupStepsLeft,
  TEAM_APP_NAME,
  TEAM_APP_PROVIDERS,
  teamDescendants,
  teamGrant,
  type TeamGrant,
} from "@t3tools/shared/assistantTeam";
import { ASSISTANT_SETUP_PREFIX } from "@t3tools/shared/secretRequestCopy";
import { Context, Data, Effect, Schema } from "effect";
import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";

import type { InboxPost } from "../inbox/inboxModel.ts";
import type { ManagerCaller } from "../manager/Services/ManagerToolService.ts";
import { askCardQuestion, newAskCardRequestId } from "./askCards.ts";
import { assistantOfTokenLabel } from "./assistantAccess.ts";
import { assistantSandboxGrantDenial } from "./assistantSandboxRules.ts";
import { readAppAccess, writeAppAccess } from "./localAssistantStore.ts";
import {
  EMPTY_TEAM,
  normalizeDuties,
  readTeam,
  updateTeam,
  withActivity,
  withSetupStep,
} from "./teamStore.ts";

export class AssistantTeamError extends Data.TaggedError("AssistantTeamError")<{
  readonly message: string;
  /** HTTP status for the person's routes. */
  readonly status: number;
}> {}

const fail = (message: string, status = 400) =>
  Effect.fail(new AssistantTeamError({ message, status }));

/** How many helpers one assistant may have, and the team at most (a runaway loop stops here). */
export const MAX_HELPERS_PER_ASSISTANT = 5;
export const MAX_TEAM_SIZE = 20;

/** The assistant an assistant's own token speaks for, or null for any other token. */
export function callerAssistant(caller: Pick<ManagerCaller, "label">): ProjectId | null {
  const id = assistantOfTokenLabel(caller.label);
  return id === null ? null : ProjectId.make(id);
}

/** What one assistant is on this computer, as the team needs it. */
export interface TeamMemberRecord {
  readonly projectId: ProjectId;
  /** Its folder's title (the person's name for it, unless the team renamed it). */
  readonly title: string;
  readonly team: ManagerAssistantTeam;
  readonly grant: TeamGrant;
}

/** Everything the team touches outside its own files — fakes in tests. */
export interface AssistantTeamDeps {
  readonly stateDir: string;
  readonly now: () => Date;
  /** Assistants that exist (live projects `assistant-*`), Uno included. */
  readonly listAssistants: () => Effect.Effect<
    ReadonlyArray<{ readonly projectId: ProjectId; readonly title: string }>
  >;
  /** The person's projects (not assistants' workspaces), for names and checks. */
  readonly listProjects: () => Effect.Effect<
    ReadonlyArray<{ readonly id: string; readonly title: string }>
  >;
  /** The preset and allowlist an assistant works with now (its token, or what it gets). */
  readonly readAccess: (projectId: ProjectId) => Effect.Effect<{
    readonly preset: AssistantPreset;
    readonly allowlist: ManagerProjectAllowlist;
  }>;
  readonly writeAccess: (
    projectId: ProjectId,
    preset: AssistantPreset,
    projects: "all" | ReadonlyArray<string>,
  ) => Effect.Effect<void>;
  readonly createAssistant: (input: {
    readonly name: string;
    readonly emoji?: string;
    readonly preset: AssistantPreset;
    readonly projects: "all" | ReadonlyArray<string>;
  }) => Effect.Effect<{ readonly projectId: ProjectId }, AssistantTeamError>;
  readonly deleteAssistant: (projectId: ProjectId) => Effect.Effect<void, AssistantTeamError>;
  readonly renameAssistant: (projectId: ProjectId, title: string) => Effect.Effect<void>;
  readonly setEmoji: (projectId: ProjectId, emoji: string | null) => Effect.Effect<void>;
  readonly createConversation: (
    projectId: ProjectId,
    title: string,
  ) => Effect.Effect<{ readonly threadId: ThreadId }, AssistantTeamError>;
  /** The conversation still there (not deleted, not archived). */
  readonly threadAlive: (threadId: string) => Effect.Effect<boolean>;
  /** A message in a conversation the assistant answers: from Uno Work (`system`) or the person. */
  readonly startTurn: (input: {
    readonly threadId: ThreadId;
    readonly text: string;
    readonly system: boolean;
  }) => Effect.Effect<void>;
  readonly showCard: (input: {
    readonly threadId: ThreadId;
    readonly requestId: string;
    readonly question: UserInputQuestion;
  }) => Effect.Effect<void>;
  readonly inbox: (post: InboxPost) => Effect.Effect<void>;
  /** Routines (schedules) run here: a cloud computer linked to the console, not a laptop. */
  readonly routinesAvailable: () => Effect.Effect<boolean>;
  /**
   * "Only selected projects" can be held here (the assistant sandbox). Absent
   * (tests): yes. Where it can't, narrowing to projects is refused.
   */
  readonly assistantSandboxAvailable?: () => Effect.Effect<boolean>;
  /**
   * The computer's mailbox address (`name-otter@uno4.me`), or null when mail
   * isn't there (the account's flag is off, not a cloud computer). Absent: no mail.
   */
  readonly mailboxAddress?: () => Effect.Effect<string | null>;
  /** schedule_create for this caller. */
  readonly createRoutine: (
    caller: ManagerCaller,
    input: { name: string; cron: string; prompt: string; timezone?: string },
  ) => Effect.Effect<unknown, { readonly message: string }>;
}

const decode = <S extends Schema.Top>(schema: S, args: unknown) =>
  Schema.decodeUnknownEffect(schema)(args ?? {}).pipe(
    Effect.mapError(
      (error) =>
        new AssistantTeamError({ message: `Invalid arguments: ${error.message}`, status: 400 }),
    ),
  );

const UNO_NAME = "Uno";

/** The name the person sees: the team's, else Uno for the computer's own, else the folder's. */
export function memberName(member: Pick<TeamMemberRecord, "projectId" | "title" | "team">): string {
  if (member.team.name) return member.team.name;
  return member.projectId === ASSISTANT_PROJECT_ID ? UNO_NAME : member.title;
}

/** "landing, fishcode" / "every project" — by title where the project still exists. */
export function projectsLine(
  projects: "all" | ReadonlyArray<string>,
  known: ReadonlyArray<{ readonly id: string; readonly title: string }>,
): string {
  if (projects === "all") return "every project";
  if (projects.length === 0) return "no projects yet";
  const titles = new Map(known.map((project) => [project.id, project.title]));
  return projects.map((id) => titles.get(id) ?? id).join(", ");
}

/** "Gmail & Calendar — reads only · GitHub — no access" (only what isn't the default). */
export function appsLine(grant: TeamGrant): string {
  const parts = [...new Set([...TEAM_APP_PROVIDERS, ...Object.keys(grant.apps)])].flatMap(
    (provider) => {
      const level = grantAppLevel(grant, provider);
      if (level === "write") return [];
      return [
        `${TEAM_APP_NAME[provider] ?? provider} — ${level === "read" ? "reads only" : "no access"}`,
      ];
    },
  );
  return parts.length === 0 ? "every app it's given" : parts.join(" · ");
}

/** Lost lines in plain words, prefixed by the project titles they name. */
const readableLost = (
  lost: ReadonlyArray<string>,
  known: ReadonlyArray<{ readonly id: string; readonly title: string }>,
) => {
  const titles = new Map(known.map((project) => [project.id, project.title]));
  return lost.map((line) =>
    line.startsWith("project ") ? `project ${titles.get(line.slice(8)) ?? line.slice(8)}` : line,
  );
};

/** Kickoff of the setup chat: what the assistant reads (the person sees one quiet line). */
const WORKS_ON_WORDS = {
  here: "this computer",
  cloud: "a cloud computer of the person's",
  own: "a computer of its own",
} as const;

export const SETUP_KICKOFF_PREFIX = ASSISTANT_SETUP_PREFIX;

export function setupKickoffText(input: {
  readonly name: string;
  readonly resume: boolean;
  readonly left: ReadonlyArray<AssistantSetupStepId>;
}): string {
  const steps = ASSISTANT_SETUP_STEPS.filter((step) => input.left.includes(step.id))
    .map((step, index) => `${index + 1}. ${step.id} — ${step.ask}`)
    .join("\n");
  return [
    `${SETUP_KICKOFF_PREFIX}${input.resume ? " (continue)" : ""}]`,
    input.resume
      ? `The person opened your setup again. Continue where it stopped — don't repeat what is saved.`
      : `The person just made you, ${input.name}, and opened this chat to set you up.`,
    "Follow “Setting yourself up” in your instructions: call assistant_profile_get first, then say hi in one short line and ask the first question with ask_user. One question per turn; save each answer with assistant_profile_set (with its step) before the next question.",
    steps.length > 0 ? `Steps left:\n${steps}` : "Every step is answered: wrap up in one line.",
  ].join("\n\n");
}

export interface AssistantTeamShape {
  /** The team part of each assistant's summary (`GET /api/manager/assistants`). */
  readonly views: (
    projectIds: ReadonlyArray<ProjectId>,
  ) => Effect.Effect<ReadonlyMap<string, ManagerAssistantTeamView>>;
  /** `assistant_profile_get`: who it is, its rights, what is left of its setup. */
  readonly profileGet: (caller: ManagerCaller) => Effect.Effect<unknown, AssistantTeamError>;
  /** `assistant_profile_set`: saves answers; rights only narrow. */
  readonly profileSet: (
    caller: ManagerCaller,
    args: unknown,
  ) => Effect.Effect<unknown, AssistantTeamError>;
  /** `assistant_create`: a helper within the caller's own rights. */
  readonly create: (
    caller: ManagerCaller,
    args: unknown,
  ) => Effect.Effect<unknown, AssistantTeamError>;
  /** `ask_user`: a question card in the caller's conversation. */
  readonly askUser: (
    caller: ManagerCaller,
    args: unknown,
  ) => Effect.Effect<unknown, AssistantTeamError>;
  /** The person edits who it is (its page). */
  readonly update: (
    input: AssistantTeamUpdateInput,
  ) => Effect.Effect<ManagerAssistantTeam, AssistantTeamError>;
  /** The person changed its rights (preset, projects, apps): cut what it set up to match. */
  readonly rightsChanged: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly projectId: ProjectId; readonly lost: ReadonlyArray<string> }>
  >;
  /** Revoke it with everything it set up, or bring it back. */
  readonly revoke: (
    input: AssistantRevokeInput,
  ) => Effect.Effect<{ readonly affected: ReadonlyArray<ProjectId> }, AssistantTeamError>;
  /** Delete it and every helper it set up (each kept 7 days, like any delete). */
  readonly deleteWithHelpers: (
    projectId: ProjectId,
  ) => Effect.Effect<{ readonly deleted: ReadonlyArray<ProjectId> }, AssistantTeamError>;
  /** Its setup chat: a new conversation that starts with its first question, or the open one. */
  readonly startSetupChat: (
    projectId: ProjectId,
  ) => Effect.Effect<{ readonly threadId: ThreadId }, AssistantTeamError>;
}

export class AssistantTeam extends Context.Service<AssistantTeam, AssistantTeamShape>()(
  "t3/assistants/AssistantTeam",
) {}

/** Its access before it was revoked, so "Bring back" restores it (state dir, not its folder). */
interface RevokedAccess {
  readonly preset: AssistantPreset;
  readonly projects: "all" | ReadonlyArray<string>;
}

const REVOKED_PRESET: AssistantPreset = "observer";

/** What `revoked-access.json` kept; anything unreadable brings it back as Full (the default). */
export function parseRevokedAccess(raw: string | null): RevokedAccess {
  const fallback: RevokedAccess = { preset: "full", projects: "all" };
  if (raw === null) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  const record = parsed as { preset?: unknown; projects?: unknown } | null;
  const preset =
    record?.preset === "full" || record?.preset === "helper" || record?.preset === "observer"
      ? record.preset
      : "full";
  const projects =
    record?.projects === "all"
      ? "all"
      : Array.isArray(record?.projects)
        ? record.projects.filter((id): id is string => typeof id === "string")
        : "all";
  return { preset, projects };
}

export const makeAssistantTeam = (deps: AssistantTeamDeps): AssistantTeamShape => {
  const members = Effect.gen(function* () {
    const assistants = yield* deps.listAssistants();
    const out: TeamMemberRecord[] = [];
    for (const assistant of assistants) {
      out.push(yield* memberOf(assistant.projectId, assistant.title));
    }
    return out;
  });

  const memberOf = (projectId: ProjectId, title: string) =>
    Effect.gen(function* () {
      const team = yield* Effect.promise(() => readTeam(deps.stateDir, projectId));
      const access = yield* deps.readAccess(projectId);
      const apps = yield* Effect.promise(() => readAppAccess(deps.stateDir, projectId));
      const grant = teamGrant({
        preset: access.preset,
        allowlist: access.allowlist,
        apps: apps.permissions,
      });
      return { projectId, title, team, grant } satisfies TeamMemberRecord;
    });

  const memberById = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const assistants = yield* deps.listAssistants();
      const found = assistants.find((assistant) => assistant.projectId === projectId);
      if (found === undefined) return yield* fail("No such assistant on this computer.", 404);
      return yield* memberOf(found.projectId, found.title);
    });

  const ownMember = (caller: ManagerCaller) =>
    Effect.gen(function* () {
      const own = callerAssistant(caller);
      if (own === null) {
        return yield* fail("Only an assistant's own token can do this.", 403);
      }
      const member = yield* memberById(own);
      if (member.team.revokedAt !== null) {
        return yield* fail(
          "The person revoked your access. Tell them what you wanted to do; they can bring you back on your page.",
          403,
        );
      }
      return member;
    });

  const note = (projectId: ProjectId, entry: Parameters<typeof withActivity>[1]) =>
    Effect.promise(() =>
      updateTeam(deps.stateDir, projectId, (team) => withActivity(team, entry, deps.now())),
    );

  /** Writes a grant (token access + app levels), only the parts that differ. */
  const applyGrant = (projectId: ProjectId, before: TeamGrant, after: TeamGrant) =>
    Effect.gen(function* () {
      const projectsChanged = JSON.stringify(before.projects) !== JSON.stringify(after.projects);
      if (before.preset !== after.preset || projectsChanged) {
        yield* deps.writeAccess(projectId, after.preset, after.projects);
      }
      if (JSON.stringify(before.apps) !== JSON.stringify(after.apps)) {
        yield* Effect.promise(() => writeAppAccess(deps.stateDir, projectId, after.apps));
      }
    });

  /**
   * Cuts everything `projectId` set up to its rights now, all the way down
   * (decision 16.10: automatically, with "who lost what" in the Inbox).
   */
  const cascadeFrom = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const all = yield* members;
      const byId = new Map(all.map((member) => [member.projectId as string, member]));
      const root = byId.get(projectId);
      if (root === undefined) return [];
      const known = yield* deps.listProjects();
      const losses: Array<{ projectId: ProjectId; name: string; lost: ReadonlyArray<string> }> = [];
      const grants = new Map<string, TeamGrant>([[projectId, root.grant]]);
      const queue: ProjectId[] = [projectId];
      const seen = new Set<string>(queue);
      while (queue.length > 0) {
        const parentId = queue.shift()!;
        const parentGrant = grants.get(parentId)!;
        for (const child of all) {
          if (child.team.createdBy !== parentId || seen.has(child.projectId)) continue;
          seen.add(child.projectId);
          queue.push(child.projectId);
          if (child.team.revokedAt !== null) {
            grants.set(child.projectId, child.grant);
            continue;
          }
          const { grant, lost } = clampGrant(parentGrant, child.grant);
          grants.set(child.projectId, grant);
          if (lost.length === 0) continue;
          yield* applyGrant(child.projectId, child.grant, grant);
          const words = readableLost(lost, known);
          const parentName = memberName(byId.get(parentId)!);
          yield* note(child.projectId, {
            kind: "access",
            text: `Lost ${words.join(", ")} — ${parentName}'s rights changed`,
            by: "you",
          });
          losses.push({ projectId: child.projectId, name: memberName(child), lost: words });
        }
      }
      if (losses.length > 0) {
        const first = losses[0]!;
        yield* deps.inbox({
          kind: "agent.done",
          source: {
            kind: "system",
            id: `assistant-rights:${projectId}`,
            name: memberName(root),
            icon: "🔒",
          },
          title:
            losses.length === 1
              ? `${first.name} lost some access`
              : `${losses.length} assistants lost some access`,
          body: `${memberName(root)}'s rights changed, so what it set up was cut to match. ${losses
            .map((loss) => `${loss.name}: ${loss.lost.join(", ")}`)
            .join(" · ")}.`,
          open: { kind: "url", url: assistantUrl(first.projectId) },
          groupKey: null,
        });
      }
      return losses.map((loss) => ({ projectId: loss.projectId, lost: loss.lost }));
    });

  const knownProjectIds = (ids: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const known = yield* deps.listProjects();
      const knownIds = new Set(known.map((project) => project.id));
      const unknown = ids.filter((id) => !knownIds.has(id));
      if (unknown.length > 0) {
        return yield* fail(
          `Unknown project ids: ${unknown.join(", ")}. Use the ids from assistant_profile_get.`,
        );
      }
      return known;
    });

  const stepsLeft = (member: TeamMemberRecord) =>
    setupStepsLeft(member.team.setup).filter(
      // Uno lives on its computer: "where it works" is the others' question.
      (step) => !(step === "computer" && member.projectId === ASSISTANT_PROJECT_ID),
    );

  const mailView = (member: TeamMemberRecord) =>
    Effect.gen(function* () {
      const mailbox = deps.mailboxAddress ? yield* deps.mailboxAddress() : null;
      if (mailbox === null) {
        return {
          available: false,
          note: "Email of your own isn't on this computer (it comes with an Uno cloud computer, where the account has it). Skip the mail step.",
        };
      }
      return {
        available: true,
        address: assistantMailAddress(mailbox, member.projectId),
        rules: mailPolicyLine(member.team.mail, null),
        policy: member.team.mail,
      };
    });

  const profileView = (member: TeamMemberRecord) =>
    Effect.gen(function* () {
      const known = yield* deps.listProjects();
      const left = stepsLeft(member);
      return {
        name: memberName(member),
        isUno: member.projectId === ASSISTANT_PROJECT_ID,
        roles: member.team.roles,
        character: member.team.character,
        channel: member.team.channel,
        firstTask: member.team.firstTask,
        duties: member.team.duties,
        mail: yield* mailView(member),
        worksOn: {
          now: "this computer",
          wish: member.team.worksOnWish,
          ...(member.projectId === ASSISTANT_PROJECT_ID
            ? { note: "You are this computer's own assistant: you stay here." }
            : {}),
        },
        access: {
          preset: member.grant.preset,
          presetMeans: ASSISTANT_PRESET_COPY[member.grant.preset].line,
          projects:
            member.grant.projects === "all"
              ? "all"
              : member.grant.projects.map((id) => ({
                  id,
                  title: known.find((project) => project.id === id)?.title ?? id,
                })),
          apps: Object.fromEntries(
            [...new Set([...TEAM_APP_PROVIDERS, ...Object.keys(member.grant.apps)])].map(
              (provider) => [provider, grantAppLevel(member.grant, provider)],
            ),
          ),
          canSetUpHelpers: assistantPresetAllows(member.grant.preset, "create-assistant"),
        },
        personsProjects: known.map((project) => ({ id: project.id, title: project.title })),
        setup: {
          state: member.team.setup.state,
          answered: member.team.setup.answered,
          skipped: member.team.setup.skipped,
          left: ASSISTANT_SETUP_STEPS.filter((step) => left.includes(step.id)),
        },
        routinesHere: yield* deps.routinesAvailable(),
        rule: "You can only narrow your own rights here. Widening is the person's: they change it on your page (Assistants → your name).",
      };
    });

  const profileGet: AssistantTeamShape["profileGet"] = (caller) =>
    ownMember(caller).pipe(Effect.flatMap(profileView));

  const profileSet: AssistantTeamShape["profileSet"] = (caller, args) =>
    Effect.gen(function* () {
      const input = yield* decode(ManagerAssistantProfileSetInput, args);
      const member = yield* ownMember(caller);
      const saved: string[] = [];
      const notes: string[] = [];

      // Its mail only narrows too (off, fewer people, a lower limit).
      const nextMail =
        input.mail === undefined ? member.team.mail : applyMailPatch(member.team.mail, input.mail);
      const widerMail = mailPolicyBeyond(member.team.mail, nextMail);
      if (widerMail.length > 0) {
        yield* note(member.projectId, {
          kind: "denied",
          text: `Wanted more mail: ${widerMail.join(", ")}`,
        });
        return yield* fail(
          `You can't give yourself more mail than you have (${widerMail.join(", ")}). Only the person can — on your page (Assistants → ${memberName(member)} → Mail). Tell them in one line; save the rest of the answer.`,
          403,
        );
      }

      // Rights: only narrower than now (child ⊆ itself), checked here.
      const wantsRights =
        input.preset !== undefined || input.projects !== undefined || input.apps !== undefined;
      if (wantsRights) {
        if (input.projects !== undefined && input.projects !== "all") {
          yield* knownProjectIds(input.projects as ReadonlyArray<string>);
        }
        const next: TeamGrant = {
          preset: input.preset ?? member.grant.preset,
          projects:
            input.projects === undefined
              ? member.grant.projects
              : teamGrant({ preset: "full", allowlist: input.projects, apps: {} }).projects,
          apps:
            input.apps === undefined ? member.grant.apps : { ...member.grant.apps, ...input.apps },
        };
        if (
          next.projects !== "all" &&
          JSON.stringify(next.projects) !== JSON.stringify(member.grant.projects)
        ) {
          const sandbox = deps.assistantSandboxAvailable
            ? yield* deps.assistantSandboxAvailable()
            : true;
          const denial = assistantSandboxGrantDenial(next.projects, sandbox);
          if (denial !== null) return yield* fail(denial, 409);
        }
        const known = yield* deps.listProjects();
        const wider = readableLost(grantBeyond(member.grant, next), known);
        if (wider.length > 0) {
          yield* note(member.projectId, {
            kind: "denied",
            text: `Wanted more access: ${wider.join(", ")}`,
          });
          return yield* fail(
            `You can't give yourself more than you have (${wider.join(", ")}). Only the person can widen your access — on your page (Assistants → ${memberName(member)}). Tell them in one line what you'd need and why; save the rest of the answer.`,
            403,
          );
        }
        yield* applyGrant(member.projectId, member.grant, next);
        if (next.preset !== member.grant.preset) {
          saved.push(`can do — ${ASSISTANT_PRESET_COPY[next.preset].name}`);
        }
        if (input.projects !== undefined)
          saved.push(`projects — ${projectsLine(next.projects, known)}`);
        if (input.apps !== undefined) saved.push(`apps — ${appsLine(next)}`);
        const losses = yield* cascadeFrom(member.projectId);
        if (losses.length > 0) {
          notes.push(`${losses.length} assistant(s) you set up were cut to match.`);
        }
      }

      if (input.name !== undefined && member.projectId !== ASSISTANT_PROJECT_ID) {
        yield* deps.renameAssistant(member.projectId, input.name);
        saved.push(`name — ${input.name}`);
      }
      if (input.emoji !== undefined) {
        yield* deps.setEmoji(member.projectId, input.emoji);
        saved.push(`face — ${input.emoji}`);
      }
      if (input.routine !== undefined) {
        if (!(yield* deps.routinesAvailable())) {
          notes.push(
            "Routines run on a cloud computer: this one is a laptop that sleeps. Tell the person they can get a cloud computer to run it, and skip this step.",
          );
        } else {
          const routine = input.routine;
          const created = yield* deps
            .createRoutine(caller, {
              name: routine.name,
              cron: routine.cron,
              prompt: routine.prompt,
              ...(routine.timezone !== undefined ? { timezone: routine.timezone } : {}),
            })
            .pipe(
              Effect.map(() => true),
              Effect.catch((cause) =>
                Effect.sync(() => {
                  notes.push(`The routine wasn't made: ${cause.message}`);
                  return false;
                }),
              ),
            );
          if (created) saved.push(`routine — ${routine.name} (${routine.cron})`);
        }
      }

      const now = deps.now();
      yield* Effect.promise(() =>
        updateTeam(deps.stateDir, member.projectId, (current) => {
          let team: ManagerAssistantTeam = {
            ...current,
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.roles !== undefined ? { roles: input.roles } : {}),
            ...(input.character !== undefined ? { character: input.character } : {}),
            ...(input.skills !== undefined ? { skills: input.skills } : {}),
            ...(input.channel !== undefined ? { channel: input.channel } : {}),
            ...(input.firstTask !== undefined ? { firstTask: input.firstTask } : {}),
            ...(input.duties !== undefined ? { duties: normalizeDuties(input.duties) } : {}),
            ...(input.mail !== undefined ? { mail: nextMail } : {}),
            ...(input.worksOn !== undefined ? { worksOnWish: input.worksOn } : {}),
          };
          if (input.step !== undefined) {
            team = withSetupStep(team, input.step, input.skipped === true, now);
          }
          if (input.done === true) {
            team = {
              ...team,
              setup: { ...team.setup, state: "done", updatedAt: now.toISOString() },
            };
          }
          return team;
        }),
      );
      if (input.roles !== undefined) saved.push(`role — ${input.roles.join(", ")}`);
      if (input.character !== undefined) saved.push(`character — ${input.character}`);
      if (input.skills !== undefined) saved.push(`good at — ${input.skills.join(", ")}`);
      if (input.channel !== undefined) saved.push(`talk — ${input.channel}`);
      if (input.firstTask !== undefined) saved.push(`first task — “${input.firstTask}”`);
      if (input.duties !== undefined) {
        const duties = normalizeDuties(input.duties);
        saved.push(
          duties.length === 0
            ? "always on you — nothing"
            : `always on you — ${duties.map((duty) => `“${duty}”`).join(", ")}`,
        );
      }
      if (input.mail !== undefined) saved.push(`email — ${mailPolicyLine(nextMail, null)}`);
      if (input.worksOn !== undefined) {
        saved.push(`works on — ${WORKS_ON_WORDS[input.worksOn]}`);
        if (input.worksOn !== "here" && member.projectId !== ASSISTANT_PROJECT_ID) {
          notes.push(
            "Moving you is the person's: tell them in one line it is one click on your page (Works on), and go on with the setup here.",
          );
        }
      }

      const after = yield* memberById(member.projectId);
      const left = stepsLeft(after);
      return {
        saved,
        tell: saved.length > 0 ? `✓ Saved: ${saved.join("; ")}` : null,
        notes,
        setup: {
          state: after.team.setup.state,
          left: ASSISTANT_SETUP_STEPS.filter((step) => left.includes(step.id)),
        },
      };
    });

  const create: AssistantTeamShape["create"] = (caller, args) =>
    Effect.gen(function* () {
      const input = yield* decode(ManagerAssistantCreateInput, args);
      const parent = yield* ownMember(caller);
      if (!assistantPresetAllows(parent.grant.preset, "create-assistant")) {
        return yield* fail(
          `Your access is "${ASSISTANT_PRESET_COPY[parent.grant.preset].name}": you can't set up other assistants. Tell the person what kind of helper you'd want; they can make one under Assistants.`,
          403,
        );
      }
      const all = yield* members;
      const live = all.filter((member) => member.team.revokedAt === null);
      if (live.length >= MAX_TEAM_SIZE) {
        return yield* fail(
          `The team has ${live.length} assistants already — that's the limit.`,
          409,
        );
      }
      const helpers = live.filter((member) => member.team.createdBy === parent.projectId);
      if (helpers.length >= MAX_HELPERS_PER_ASSISTANT) {
        return yield* fail(
          `You set up ${helpers.length} helpers already — that's the limit. Ask the person before making more.`,
          409,
        );
      }
      if (input.projects !== undefined && input.projects !== "all") {
        yield* knownProjectIds(input.projects as ReadonlyArray<string>);
      }
      const child: TeamGrant = {
        preset: input.preset ?? parent.grant.preset,
        projects:
          input.projects === undefined
            ? parent.grant.projects
            : teamGrant({ preset: "full", allowlist: input.projects, apps: {} }).projects,
        apps: { ...parent.grant.apps, ...input.apps },
      };
      const known = yield* deps.listProjects();
      const beyond = readableLost(grantBeyond(parent.grant, child), known);
      if (beyond.length > 0) {
        yield* note(parent.projectId, {
          kind: "denied",
          text: `Wanted to set up ${input.name} with more than it has: ${beyond.join(", ")}`,
        });
        return yield* fail(
          `A helper can't get more than you have: ${beyond.join(", ")}. Make it narrower, or ask the person to set it up.`,
          403,
        );
      }
      const { projectId } = yield* deps.createAssistant({
        name: input.name,
        ...(input.emoji !== undefined ? { emoji: input.emoji } : {}),
        preset: child.preset,
        projects: child.projects,
      });
      yield* Effect.promise(() => writeAppAccess(deps.stateDir, projectId, child.apps));
      const now = deps.now();
      const parentName = memberName(parent);
      const where = projectsLine(child.projects, known);
      const presetName = ASSISTANT_PRESET_COPY[child.preset].name;
      yield* Effect.promise(() =>
        updateTeam(deps.stateDir, projectId, () =>
          withActivity(
            {
              ...EMPTY_TEAM,
              roles: input.roles ?? [],
              character: input.character ?? "",
              createdBy: parent.projectId,
              createdAt: now.toISOString(),
              firstTask: input.firstTask ?? null,
              duties: normalizeDuties(input.duties ?? []),
              // Its mail is its creator's or narrower: never wider.
              mail: parent.team.mail,
              // Its creator set it up; the person can still run "Set up again".
              setup: { ...EMPTY_TEAM.setup, state: "done", updatedAt: now.toISOString() },
            },
            { kind: "teammate", text: `Set up by ${parentName}`, by: "auto" },
            now,
          ),
        ),
      );
      yield* note(parent.projectId, {
        kind: "teammate",
        text: `Set up ${input.name}: ${where} · ${presetName}`,
        by: "auto",
      });
      // Decision 14.10 (3): no confirmation, but the person always hears of it.
      yield* deps.inbox({
        kind: "agent.done",
        source: {
          kind: "system",
          id: `assistant-set-up:${projectId}`,
          name: parentName,
          icon: input.emoji ?? "🧑‍🤝‍🧑",
        },
        title: `${parentName} set up assistant ${input.name}`,
        body: `Projects: ${where} · ${presetName}${appsLine(child) === "every app it's given" ? "" : ` · ${appsLine(child)}`}. Within ${parentName}'s access.`,
        open: { kind: "url", url: assistantUrl(projectId) },
        groupKey: null,
      });
      let threadId: ThreadId | null = null;
      if (input.firstTask !== undefined) {
        const chat = yield* deps.createConversation(projectId, input.firstTask.slice(0, 60));
        threadId = chat.threadId;
        yield* deps.startTurn({
          threadId: chat.threadId,
          text: `(Uno Work) ${parentName} set you up and hands you your first task. You take tasks only from the person; ${parentName} works for them too.\n\n${input.firstTask}`,
          system: true,
        });
      }
      return {
        projectId,
        name: input.name,
        preset: child.preset,
        projects: where,
        apps: appsLine(child),
        firstTaskChat: threadId,
        note: "The person got a notice in their Inbox. They can change or revoke it on its page.",
      };
    });

  const askUser: AssistantTeamShape["askUser"] = (caller, args) =>
    Effect.gen(function* () {
      const input = yield* decode(ManagerAskUserInput, args);
      yield* ownMember(caller);
      const threadId = caller.callerThreadId;
      if (threadId === undefined) {
        return yield* fail(
          "ask_user works only in your own conversation in Uno Work. Here, ask in plain text.",
        );
      }
      const requestId = newAskCardRequestId();
      yield* deps.showCard({ threadId, requestId, question: askCardQuestion(input) });
      return {
        asked: true,
        next: `The card is on the person's screen. End your turn now with no other text. Their answer comes as their next message: "${input.header}: <answer>" (or "${input.header}: Skip").`,
      };
    });

  const update: AssistantTeamShape["update"] = (input) =>
    Effect.gen(function* () {
      const member = yield* memberById(input.projectId);
      if (input.name !== undefined && member.projectId !== ASSISTANT_PROJECT_ID) {
        yield* deps.renameAssistant(member.projectId, input.name);
      }
      if (input.emoji !== undefined) yield* deps.setEmoji(member.projectId, input.emoji);
      const now = deps.now();
      return yield* Effect.promise(() =>
        updateTeam(deps.stateDir, member.projectId, (current) => ({
          ...current,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.tone !== undefined ? { tone: input.tone } : {}),
          ...(input.roles !== undefined ? { roles: input.roles } : {}),
          ...(input.character !== undefined ? { character: input.character } : {}),
          ...(input.skills !== undefined ? { skills: input.skills } : {}),
          ...(input.channel !== undefined ? { channel: input.channel } : {}),
          ...(input.duties !== undefined ? { duties: normalizeDuties(input.duties) } : {}),
          ...(input.mail !== undefined ? { mail: applyMailPatch(current.mail, input.mail) } : {}),
          ...(input.paused !== undefined
            ? { pausedAt: input.paused ? now.toISOString() : null }
            : {}),
          ...(input.setup === "done"
            ? { setup: { ...current.setup, state: "done" as const, updatedAt: now.toISOString() } }
            : input.setup === "not-started"
              ? { setup: EMPTY_TEAM.setup }
              : {}),
        })),
      );
    });

  const revokedFile = (projectId: ProjectId) =>
    nodePath.join(
      deps.stateDir,
      "assistants",
      encodeURIComponent(projectId),
      "revoked-access.json",
    );

  const revoke: AssistantTeamShape["revoke"] = (input) =>
    Effect.gen(function* () {
      if (input.projectId === ASSISTANT_PROJECT_ID) {
        return yield* fail("Uno is the computer's own assistant and can't be revoked.", 409);
      }
      const all = yield* members;
      const target = all.find((member) => member.projectId === input.projectId);
      if (target === undefined) return yield* fail("No such assistant on this computer.", 404);
      const now = deps.now();
      if (input.revoked) {
        const ids = [
          target.projectId,
          ...teamDescendants(
            all.map((member) => ({ id: member.projectId, createdBy: member.team.createdBy })),
            target.projectId,
          ).map((id) => ProjectId.make(id)),
        ];
        const affected: ProjectId[] = [];
        for (const id of ids) {
          const member = all.find((item) => item.projectId === id)!;
          if (member.team.revokedAt !== null) continue;
          const kept: RevokedAccess = {
            preset: member.grant.preset,
            projects: member.grant.projects,
          };
          yield* Effect.promise(async () => {
            await fsp.mkdir(nodePath.dirname(revokedFile(id)), { recursive: true });
            await fsp.writeFile(revokedFile(id), `${JSON.stringify(kept)}\n`, "utf8");
          });
          // Revoked = reads its own chats, nothing else: no projects, no writes.
          yield* deps.writeAccess(id, REVOKED_PRESET, []);
          yield* Effect.promise(() =>
            updateTeam(deps.stateDir, id, (team) =>
              withActivity(
                { ...team, revokedAt: now.toISOString() },
                {
                  kind: "access",
                  text:
                    id === target.projectId
                      ? "You revoked its access"
                      : `Revoked with ${memberName(target)}, who set it up`,
                  by: "you",
                },
                now,
              ),
            ),
          );
          affected.push(id);
        }
        return { affected };
      }
      // Bring back: within its creator's rights, and only if the creator is back.
      const parent =
        target.team.createdBy === null
          ? null
          : (all.find((member) => member.projectId === target.team.createdBy) ?? null);
      if (parent !== null && parent.team.revokedAt !== null) {
        return yield* fail(`Bring back ${memberName(parent)} first — it set this one up.`, 409);
      }
      const raw = yield* Effect.promise(() =>
        fsp.readFile(revokedFile(target.projectId), "utf8").catch(() => null),
      );
      const kept = parseRevokedAccess(raw);
      const wanted: TeamGrant = {
        preset: kept.preset,
        projects: kept.projects,
        apps: target.grant.apps,
      };
      const grant = parent === null ? wanted : clampGrant(parent.grant, wanted).grant;
      yield* deps.writeAccess(target.projectId, grant.preset, grant.projects);
      yield* Effect.promise(() =>
        updateTeam(deps.stateDir, target.projectId, (team) =>
          withActivity(
            { ...team, revokedAt: null },
            { kind: "access", text: "You brought it back", by: "you" },
            now,
          ),
        ),
      );
      return { affected: [target.projectId] };
    });

  const deleteWithHelpers: AssistantTeamShape["deleteWithHelpers"] = (projectId) =>
    Effect.gen(function* () {
      const all = yield* members;
      const target = all.find((member) => member.projectId === projectId);
      const helpers = teamDescendants(
        all.map((member) => ({ id: member.projectId, createdBy: member.team.createdBy })),
        projectId,
      ).map((id) => ProjectId.make(id));
      // Deepest first, then the assistant itself.
      for (const id of helpers.toReversed()) yield* deps.deleteAssistant(id);
      yield* deps.deleteAssistant(projectId);
      if (helpers.length > 0 && target !== undefined) {
        const names = helpers.map((id) =>
          memberName(all.find((member) => member.projectId === id)!),
        );
        yield* deps.inbox({
          kind: "agent.done",
          source: {
            kind: "system",
            id: `assistant-deleted:${projectId}`,
            name: memberName(target),
            icon: "🗑️",
          },
          title: `${memberName(target)} was deleted with ${helpers.length === 1 ? names[0] : `${helpers.length} assistants`} it set up`,
          body: `Also deleted: ${names.join(", ")}. Each is kept 7 days — Restore under Assistants.`,
          open: null,
          groupKey: null,
        });
      }
      return { deleted: [...helpers, projectId] };
    });

  const startSetupChat: AssistantTeamShape["startSetupChat"] = (projectId) =>
    Effect.gen(function* () {
      const member = yield* memberById(projectId);
      if (member.team.revokedAt !== null) return yield* fail("Bring it back first.", 409);
      const setup = member.team.setup;
      const open =
        setup.state === "in-progress" && setup.threadId !== null
          ? yield* deps.threadAlive(setup.threadId)
          : false;
      const restart = setup.state === "done";
      const progress = restart ? { answered: [], skipped: [] } : setup;
      const left = setupStepsLeft(progress).filter(
        (step) => !(step === "computer" && projectId === ASSISTANT_PROJECT_ID),
      );
      const name = memberName(member);
      const threadId: ThreadId = open
        ? (setup.threadId as ThreadId)
        : (yield* deps.createConversation(projectId, `Setting up ${name}`)).threadId;
      const now = deps.now();
      yield* Effect.promise(() =>
        updateTeam(deps.stateDir, projectId, (team) => ({
          ...team,
          setup: {
            state: "in-progress",
            answered: restart ? [] : team.setup.answered,
            skipped: restart ? [] : team.setup.skipped,
            threadId,
            updatedAt: now.toISOString(),
          },
        })),
      );
      yield* deps.startTurn({
        threadId,
        text: setupKickoffText({ name, resume: open || progress.answered.length > 0, left }),
        system: true,
      });
      return { threadId };
    });

  const views: AssistantTeamShape["views"] = (projectIds) =>
    Effect.gen(function* () {
      const out = new Map<string, ManagerAssistantTeamView>();
      for (const projectId of projectIds) {
        const team = yield* Effect.promise(() => readTeam(deps.stateDir, projectId));
        const apps = yield* Effect.promise(() => readAppAccess(deps.stateDir, projectId));
        out.set(projectId, { team, apps });
      }
      return out;
    });

  return {
    views,
    profileGet,
    profileSet,
    create,
    askUser,
    update,
    rightsChanged: (projectId) => cascadeFrom(projectId).pipe(Effect.orElseSucceed(() => [])),
    revoke,
    deleteWithHelpers,
    startSetupChat,
  };
};

/** The Inbox link to an assistant's page on the computer the item came from. */
export function assistantUrl(projectId: string): string {
  return `uno://assistant/this/${projectId}`;
}
