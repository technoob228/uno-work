/**
 * Who an assistant is on the person's team (decisions 14.10, 16.10): its
 * name and face, role, character, where it talks, how far its setup went,
 * who set it up, whether it is revoked or paused, and the few things it did
 * that its chats don't show (set up a helper, lost access).
 *
 * `<stateDir>/assistants/<id>/team.json`, next to `access.json` and
 * `apps.json` — not in the assistant's folder, which the assistant writes
 * all day: the parent link decides what a revoke reaches, so the assistant
 * must not be able to edit it. Its rights are not here: the preset and
 * projects are its token's, the app levels are `apps.json`'s.
 *
 * Plain async I/O like `localAssistantStore.ts`; the pure parts are tested
 * directly.
 *
 * @module assistants/teamStore
 */
import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";

import {
  ASSISTANT_DUTIES_MAX,
  ASSISTANT_DUTY_MAX_CHARS,
  ASSISTANT_SETUP_STEP_IDS,
  ASSISTANT_TEAM_ACTIVITY_LIMIT,
  ASSISTANT_TEAM_TEXT_MAX,
  ProjectId,
  type AssistantSetupStepId,
  type AssistantTeamActivity,
  type ManagerAssistantTeam,
} from "@t3tools/contracts";
import { DEFAULT_ASSISTANT_MAIL_POLICY, normalizeMailPolicy } from "@t3tools/shared/assistantMail";

export const EMPTY_TEAM: ManagerAssistantTeam = {
  name: null,
  tone: null,
  roles: [],
  character: "",
  skills: [],
  channel: null,
  createdBy: null,
  createdAt: null,
  setup: { state: "not-started", answered: [], skipped: [], threadId: null, updatedAt: null },
  firstTask: null,
  duties: [],
  mail: DEFAULT_ASSISTANT_MAIL_POLICY,
  worksOnWish: null,
  revokedAt: null,
  pausedAt: null,
  activity: [],
};

const teamFile = (stateDir: string, projectId: string) =>
  nodePath.join(stateDir, "assistants", encodeURIComponent(projectId), "team.json");

const text = (value: unknown, max = ASSISTANT_TEAM_TEXT_MAX): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, max) : null;

const texts = (value: unknown, max = 8): ReadonlyArray<string> =>
  Array.isArray(value)
    ? [
        ...new Set(value.flatMap((item) => (text(item, 60) === null ? [] : [text(item, 60)!]))),
      ].slice(0, max)
    : [];

/** Standing duties: trimmed lines, no repeats, at most 12 of 200 characters. */
export function normalizeDuties(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const item of value) {
    const line = text(item, ASSISTANT_DUTY_MAX_CHARS)?.replace(/\s+/g, " ") ?? null;
    if (line !== null) out.add(line);
    if (out.size >= ASSISTANT_DUTIES_MAX) break;
  }
  return [...out];
}

const STEP_IDS: ReadonlySet<string> = new Set(ASSISTANT_SETUP_STEP_IDS);
const steps = (value: unknown): ReadonlyArray<AssistantSetupStepId> =>
  Array.isArray(value)
    ? [...new Set(value.filter((id): id is AssistantSetupStepId => STEP_IDS.has(id)))]
    : [];

const ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "teammate",
  "access",
  "setup",
  "note",
  "denied",
]);

/** Whatever is on disk (older shapes, a hand edit) as today's record. */
export function normalizeTeam(raw: unknown): ManagerAssistantTeam {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return EMPTY_TEAM;
  const record = raw as Record<string, unknown>;
  const setup =
    record.setup !== null && typeof record.setup === "object"
      ? (record.setup as Record<string, unknown>)
      : {};
  const state =
    setup.state === "in-progress" || setup.state === "done" ? setup.state : "not-started";
  const channel =
    record.channel === "here" || record.channel === "telegram" || record.channel === "slack"
      ? record.channel
      : null;
  const createdBy = text(record.createdBy, 120);
  const activity: AssistantTeamActivity[] = Array.isArray(record.activity)
    ? record.activity.flatMap((entry) => {
        if (entry === null || typeof entry !== "object") return [];
        const item = entry as Record<string, unknown>;
        const at = text(item.at, 40);
        const line = text(item.text, 300);
        if (at === null || line === null || typeof item.kind !== "string") return [];
        if (!ACTIVITY_KINDS.has(item.kind)) return [];
        return [
          {
            at,
            kind: item.kind as AssistantTeamActivity["kind"],
            text: line,
            ...(item.by === "you" || item.by === "auto" ? { by: item.by } : {}),
          },
        ];
      })
    : [];
  return {
    name: text(record.name, 60),
    tone: text(record.tone, 20),
    roles: texts(record.roles),
    character: text(record.character) ?? "",
    skills: texts(record.skills),
    channel,
    createdBy: createdBy === null ? null : ProjectId.make(createdBy),
    createdAt: text(record.createdAt, 40),
    setup: {
      state,
      answered: steps(setup.answered),
      skipped: steps(setup.skipped),
      threadId: text(setup.threadId, 128),
      updatedAt: text(setup.updatedAt, 40),
    },
    firstTask: text(record.firstTask, 500),
    duties: normalizeDuties(record.duties),
    mail: normalizeMailPolicy(record.mail),
    worksOnWish:
      record.worksOnWish === "here" ||
      record.worksOnWish === "cloud" ||
      record.worksOnWish === "own"
        ? record.worksOnWish
        : null,
    revokedAt: text(record.revokedAt, 40),
    pausedAt: text(record.pausedAt, 40),
    activity: activity.slice(-ASSISTANT_TEAM_ACTIVITY_LIMIT),
  };
}

/** One more line in its Activity (the newest kept, the oldest dropped). */
export function withActivity(
  team: ManagerAssistantTeam,
  entry: Omit<AssistantTeamActivity, "at">,
  now: Date,
): ManagerAssistantTeam {
  return {
    ...team,
    activity: [...team.activity, { ...entry, at: now.toISOString() }].slice(
      -ASSISTANT_TEAM_ACTIVITY_LIMIT,
    ),
  };
}

/** A setup step answered (or skipped); every step done → the setup is done. */
export function withSetupStep(
  team: ManagerAssistantTeam,
  step: AssistantSetupStepId,
  skipped: boolean,
  now: Date,
): ManagerAssistantTeam {
  const answered = skipped
    ? team.setup.answered.filter((id) => id !== step)
    : [...new Set([...team.setup.answered, step])];
  const skippedSteps = skipped
    ? [...new Set([...team.setup.skipped, step])]
    : team.setup.skipped.filter((id) => id !== step);
  const all = ASSISTANT_SETUP_STEP_IDS.every(
    (id) => answered.includes(id) || skippedSteps.includes(id),
  );
  return {
    ...team,
    setup: {
      ...team.setup,
      state: all ? "done" : "in-progress",
      answered,
      skipped: skippedSteps,
      updatedAt: now.toISOString(),
    },
  };
}

const queues = new Map<string, Promise<unknown>>();

function serialized<A>(file: string, task: () => Promise<A>): Promise<A> {
  const previous = queues.get(file) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(
    file,
    next.catch(() => undefined),
  );
  return next;
}

async function readRaw(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

export async function readTeam(stateDir: string, projectId: string): Promise<ManagerAssistantTeam> {
  return normalizeTeam(await readRaw(teamFile(stateDir, projectId)));
}

/** Read → change → write, one change at a time per assistant. */
export function updateTeam(
  stateDir: string,
  projectId: string,
  update: (current: ManagerAssistantTeam) => ManagerAssistantTeam,
): Promise<ManagerAssistantTeam> {
  const file = teamFile(stateDir, projectId);
  return serialized(file, async () => {
    const next = normalizeTeam(update(normalizeTeam(await readRaw(file))));
    await fsp.mkdir(nodePath.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await fsp.rename(temporary, file);
    return next;
  });
}
