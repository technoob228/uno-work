/**
 * "Works on" (Misha 22.10): an assistant moves to another of the person's
 * computers that Uno Work is connected to — the same cross-computer channel
 * the app already uses for every assistant (each computer's manager API):
 *
 * 1. its memory and rules (SOUL / USER / NOTES / ROUTING), its app levels,
 *    who it is on the team (role, character, duties, mail rules) and what it
 *    may do (its preset, its projects by name) are read where it is;
 * 2. it is made on the other computer with them — its projects matched by
 *    name there (projects arrive there by sync; one not there yet is named,
 *    the person gives it later);
 * 3. only then the one here is deleted (kept 7 days, Restore).
 *
 * Its chats stay where they ran; its routines and Telegram/Slack links are
 * the computer's and are set up there again (the confirmation says so). A
 * failure before step 3 removes nothing here.
 *
 * Pure orchestration: every call goes through `deps` (tests fake them).
 */
import {
  type AssistantAppLevel,
  type AssistantPreset,
  type AssistantTeamUpdateInput,
  isAssistantProjectId,
  type ManagerAssistantTeam,
} from "@t3tools/contracts";

/** The files that carry an assistant's memory and rules between computers. */
export const MOVED_FILES = ["SOUL.md", "USER.md", "NOTES.md", "ROUTING.md"] as const;
export type MovedFile = (typeof MOVED_FILES)[number];

export interface MoveAssistantDeps {
  readonly readFile: (environmentId: string, projectId: string, name: MovedFile) => Promise<string>;
  readonly getApps: (
    environmentId: string,
    projectId: string,
  ) => Promise<{
    readonly permissions: Readonly<Record<string, AssistantAppLevel>>;
    readonly restricted: boolean;
  } | null>;
  readonly listProjects: (
    environmentId: string,
  ) => Promise<ReadonlyArray<{ readonly id: string; readonly title: string }>>;
  readonly createAssistant: (
    environmentId: string,
    input: {
      readonly name: string;
      readonly emoji?: string;
      readonly access: { readonly preset: AssistantPreset; readonly projects: "all" | string[] };
    },
  ) => Promise<{ readonly projectId: string }>;
  readonly writeFile: (
    environmentId: string,
    projectId: string,
    name: MovedFile,
    content: string,
  ) => Promise<void>;
  readonly putApps: (
    environmentId: string,
    projectId: string,
    permissions: Readonly<Record<string, AssistantAppLevel>>,
  ) => Promise<void>;
  readonly updateTeam: (
    environmentId: string,
    projectId: string,
    input: Omit<AssistantTeamUpdateInput, "projectId">,
  ) => Promise<void>;
  readonly deleteAssistant: (environmentId: string, projectId: string) => Promise<void>;
}

export interface MoveAssistantInput {
  readonly from: {
    readonly environmentId: string;
    readonly projectId: string;
    readonly name: string;
    readonly emoji: string | null;
    readonly preset: AssistantPreset;
    /** Its projects by title here ("all" = every project). */
    readonly projects: "all" | ReadonlyArray<string>;
    readonly team: ManagerAssistantTeam | null;
  };
  readonly toEnvironmentId: string;
}

export interface MoveAssistantResult {
  readonly projectId: string;
  /** Its projects that aren't on the other computer yet (by title). */
  readonly missingProjects: ReadonlyArray<string>;
}

/** Its projects there: the ones with the same name; the rest are reported. */
export function matchProjects(
  wanted: "all" | ReadonlyArray<string>,
  there: ReadonlyArray<{ readonly id: string; readonly title: string }>,
): { readonly projects: "all" | string[]; readonly missing: ReadonlyArray<string> } {
  if (wanted === "all") return { projects: "all", missing: [] };
  const byTitle = new Map<string, string>();
  for (const project of there) {
    if (isAssistantProjectId(project.id)) continue;
    const key = project.title.trim().toLowerCase();
    if (!byTitle.has(key)) byTitle.set(key, project.id);
  }
  const projects: string[] = [];
  const missing: string[] = [];
  for (const title of wanted) {
    const id = byTitle.get(title.trim().toLowerCase());
    if (id === undefined) missing.push(title);
    else if (!projects.includes(id)) projects.push(id);
  }
  return { projects, missing };
}

/** Who it is on the team, as the other computer's daemon takes it. */
export function teamUpdateOf(
  team: ManagerAssistantTeam | null,
): Omit<AssistantTeamUpdateInput, "projectId"> {
  if (team === null) return { setup: "done" };
  return {
    ...(team.tone !== null ? { tone: team.tone } : {}),
    ...(team.roles.length > 0 ? { roles: [...team.roles] } : {}),
    ...(team.character.trim().length > 0 ? { character: team.character } : {}),
    ...(team.skills.length > 0 ? { skills: [...team.skills] } : {}),
    ...(team.channel !== null ? { channel: team.channel } : {}),
    duties: [...team.duties],
    mail: { ...team.mail, allow: [...team.mail.allow] },
    // It was set up here; the other computer doesn't ask again.
    setup: "done",
  };
}

export async function moveAssistantToComputer(
  input: MoveAssistantInput,
  deps: MoveAssistantDeps,
): Promise<MoveAssistantResult> {
  const { from, toEnvironmentId } = input;
  if (from.environmentId === toEnvironmentId) {
    throw new Error(`${from.name} already works on this computer.`);
  }
  const files = await Promise.all(
    MOVED_FILES.map(async (name) => {
      const content = await deps.readFile(from.environmentId, from.projectId, name).catch(() => "");
      return [name, content] as const;
    }),
  );
  const apps = await deps.getApps(from.environmentId, from.projectId).catch(() => null);
  const there = await deps.listProjects(toEnvironmentId);
  const { projects, missing } = matchProjects(from.projects, there);

  const created = await deps.createAssistant(toEnvironmentId, {
    name: from.name,
    ...(from.emoji ? { emoji: from.emoji } : {}),
    access: { preset: from.preset, projects },
  });
  try {
    for (const [name, content] of files) {
      if (content.trim().length === 0) continue;
      await deps.writeFile(toEnvironmentId, created.projectId, name, content);
    }
    if (apps?.restricted) {
      await deps.putApps(toEnvironmentId, created.projectId, apps.permissions);
    }
    await deps.updateTeam(toEnvironmentId, created.projectId, {
      name: from.name,
      ...teamUpdateOf(from.team),
    });
  } catch (cause) {
    const reason = cause instanceof Error && cause.message ? cause.message : "it didn't answer";
    throw new Error(
      `${from.name} was made on the other computer, but not all of it got there (${reason}). Nothing was removed here.`,
      { cause },
    );
  }
  await deps.deleteAssistant(from.environmentId, from.projectId);
  return { projectId: created.projectId, missingProjects: missing };
}
