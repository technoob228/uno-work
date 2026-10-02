/**
 * "Create" of New assistant. Since 02.10 evening the default is an assistant
 * on THIS computer (`createLocalAssistant`, at the end: a folder in
 * ~/UnoWork/Assistants, several per computer); "Give it its own computer" is
 * the option below — its own Work computer with the
 * role `assistant`, the assistant on it with SOUL/USER/NOTES/AGENTS from the
 * person's sentence and answers, the template's connector permissions, and
 * the schedule if one was picked.
 *
 * The steps are injected so the order and the fallbacks are unit-tested:
 *
 *   computer → access → assistant → schedule
 *
 * The console sets the template's connector permissions itself when it makes
 * an assistant's computer (fishcode 567d969); the client only rewrites them
 * when the person changed them on the card (a PUT describes the whole
 * computer: every provider is sent).
 *
 * Only "computer" is fatal before a box exists. After that nothing throws
 * the box away: a step that can't finish is reported as a note, and the
 * plan stays in local storage (`pendingAssistantSetup`) so the assistant's
 * page can finish the setup once the computer answers.
 */
import type { EnvironmentId, UnoSetupProgress } from "@t3tools/contracts";

import { GOAL_KEY } from "../setup/goals";
import {
  ASSISTANT_ABOUT_KEY,
  ASSISTANT_CREATED_KEY,
  ASSISTANT_NAME_KEY,
  withAgentsProfile,
} from "./assistantEntity";
import {
  assistantFiles,
  assistantTurnCommand,
  sameConnectors,
  type AssistantPlan,
  type ConnectorPermissions,
} from "./assistantTemplates";
import type { ConnectorPermissionsState } from "../../lib/assistantsConsoleApi";

export const ASSISTANT_EMOJI_KEY = "assistant_emoji";
export const ASSISTANT_TEMPLATE_KEY = "assistant_template";
export const ASSISTANT_BOX_KEY = "assistant_box_id";

export type CreateStage = "computer" | "access" | "assistant" | "schedule" | "done";

export const CREATE_STAGES: ReadonlyArray<{ stage: Exclude<CreateStage, "done">; label: string }> =
  [
    { stage: "computer", label: "Making its own computer" },
    { stage: "access", label: "Setting what it can open" },
    { stage: "assistant", label: "Writing who it is and what it knows" },
    { stage: "schedule", label: "Adding its schedule" },
  ];

export interface CreateAssistantDeps {
  /** Creates the Work computer and connects it; null environment = made but not reachable yet. */
  readonly createComputer: () => Promise<{
    readonly boxId: number;
    readonly environmentId: EnvironmentId | null;
  }>;
  readonly getPermissions: (boxId: number) => Promise<ConnectorPermissionsState>;
  /** False: the console can't store permissions yet. */
  readonly putPermissions: (boxId: number, permissions: ConnectorPermissions) => Promise<boolean>;
  /** The assistant's chat exists on that computer (the daemon sets it up). */
  readonly ensureAssistant: (environmentId: EnvironmentId) => Promise<boolean>;
  readonly readFile: (environmentId: EnvironmentId, name: "AGENTS.md") => Promise<string>;
  readonly writeFile: (
    environmentId: EnvironmentId,
    name: "AGENTS.md" | "SOUL.md" | "USER.md" | "NOTES.md",
    content: string,
  ) => Promise<void>;
  readonly readSetup: (environmentId: EnvironmentId) => UnoSetupProgress;
  readonly saveSetup: (environmentId: EnvironmentId, setup: UnoSetupProgress) => Promise<void>;
  readonly createSchedule: (input: {
    readonly boxId: number;
    readonly name: string;
    readonly cron: string;
    readonly command: string;
  }) => Promise<void>;
  readonly onStage?: (stage: CreateStage) => void;
  readonly now?: () => string;
}

export interface CreateAssistantResult {
  readonly boxId: number;
  readonly environmentId: EnvironmentId | null;
  /** The console stores and checks its connector permissions. */
  readonly accessEnforced: boolean;
  readonly scheduleCreated: boolean;
  /** The assistant's files are on its computer. */
  readonly assistantReady: boolean;
  /** Things the person should know, in their words. */
  readonly notes: ReadonlyArray<string>;
}

/** The setup answers the assistant's computer keeps (its name in Work, its template). */
export function assistantSetupProgress(
  current: UnoSetupProgress,
  plan: AssistantPlan,
  boxId: number,
  now: string,
): UnoSetupProgress {
  return {
    ...current,
    mode: "ai",
    // An assistant's computer has nothing to onboard: it is set up already.
    finished: true,
    answers: {
      ...current.answers,
      [GOAL_KEY]: "assistant",
      [ASSISTANT_CREATED_KEY]: now,
      [ASSISTANT_NAME_KEY]: plan.name,
      [ASSISTANT_ABOUT_KEY]: plan.job.slice(0, 300),
      [ASSISTANT_EMOJI_KEY]: plan.emoji,
      [ASSISTANT_TEMPLATE_KEY]: plan.template ?? "custom",
      [ASSISTANT_BOX_KEY]: String(boxId),
    },
  };
}

/** Writes the assistant onto its computer. True when its files are there. */
export async function setUpAssistantOnComputer(
  deps: Pick<
    CreateAssistantDeps,
    "ensureAssistant" | "readFile" | "writeFile" | "readSetup" | "saveSetup"
  >,
  environmentId: EnvironmentId,
  plan: AssistantPlan,
  boxId: number,
  now: string,
): Promise<boolean> {
  if (!(await deps.ensureAssistant(environmentId))) return false;
  const files = assistantFiles(plan, now);
  // SOUL.md and USER.md need a daemon from 0.0.106; an older one refuses the
  // names, so their text also goes into AGENTS.md, which every daemon takes.
  let separateFiles = true;
  for (const [name, content] of [
    ["SOUL.md", files.soul],
    ["USER.md", files.user],
  ] as const) {
    await deps.writeFile(environmentId, name, content).catch(() => {
      separateFiles = false;
    });
  }
  const agents = await deps.readFile(environmentId, "AGENTS.md").catch(() => "");
  const about = separateFiles ? files.about : `${plan.job}\n\n${files.soul}\n${files.user}`;
  await deps.writeFile(
    environmentId,
    "AGENTS.md",
    withAgentsProfile(agents, { name: plan.name, about }),
  );
  await deps.writeFile(environmentId, "NOTES.md", files.notes).catch(() => undefined);
  await deps.saveSetup(
    environmentId,
    assistantSetupProgress(deps.readSetup(environmentId), plan, boxId, now),
  );
  return true;
}

export async function createAssistant(
  plan: AssistantPlan,
  deps: CreateAssistantDeps,
): Promise<CreateAssistantResult> {
  const now = deps.now?.() ?? new Date().toISOString();
  const notes: string[] = [];

  deps.onStage?.("computer");
  const { boxId, environmentId } = await deps.createComputer();

  deps.onStage?.("access");
  let accessEnforced = false;
  try {
    const current = await deps.getPermissions(boxId);
    if (current.supported) {
      accessEnforced =
        current.restricted && sameConnectors(current.permissions, plan.connectors)
          ? true
          : await deps.putPermissions(boxId, plan.connectors);
    }
  } catch {
    accessEnforced = false;
  }
  if (!accessEnforced) {
    notes.push(
      `Uno couldn't set which apps ${plan.name} opens. Until it does, ${plan.name} reaches every app you connected. Check "Apps ${plan.name} can open" on its page.`,
    );
  }

  deps.onStage?.("assistant");
  let assistantReady = false;
  if (environmentId) {
    assistantReady = await setUpAssistantOnComputer(deps, environmentId, plan, boxId, now).catch(
      () => false,
    );
  }
  if (!assistantReady) {
    notes.push(
      `${plan.name}'s computer is still starting. Open ${plan.name} in a minute and press "Finish setup".`,
    );
  }

  deps.onStage?.("schedule");
  let scheduleCreated = false;
  if (plan.schedule) {
    scheduleCreated = await deps
      .createSchedule({
        boxId,
        name: `${plan.name}: ${plan.schedule.label}`,
        cron: plan.schedule.cron,
        command: assistantTurnCommand(plan.job),
      })
      .then(
        () => true,
        () => false,
      );
    if (!scheduleCreated) {
      notes.push(
        `Uno couldn't add the schedule (${plan.schedule.label.toLowerCase()}). Ask ${plan.name} in the chat to set it up.`,
      );
    }
  }

  deps.onStage?.("done");
  return { boxId, environmentId, accessEnforced, scheduleCreated, assistantReady, notes };
}

// ── Setup left to finish ─────────────────────────────────────────────

const PENDING_KEY = "uno.assistants.pending-setup.v1";

function readPending(): Record<string, AssistantPlan> {
  try {
    const raw = window.localStorage.getItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as Record<string, AssistantPlan>) : {};
  } catch {
    return {};
  }
}

export const pendingAssistantSetup = {
  get: (boxId: number): AssistantPlan | null => readPending()[String(boxId)] ?? null,
  set: (boxId: number, plan: AssistantPlan) => {
    const all = readPending();
    all[String(boxId)] = plan;
    window.localStorage.setItem(PENDING_KEY, JSON.stringify(all));
  },
  clear: (boxId: number) => {
    const all = readPending();
    delete all[String(boxId)];
    window.localStorage.setItem(PENDING_KEY, JSON.stringify(all));
  },
};

// ── On this computer (the default since 02.10 evening) ────────────────

export type LocalCreateStage = "assistant" | "access" | "schedule" | "done";

export const LOCAL_CREATE_STAGES: ReadonlyArray<{
  stage: Exclude<LocalCreateStage, "done">;
  label: string;
}> = [
  { stage: "assistant", label: "Writing who it is and what it knows" },
  { stage: "access", label: "Setting what it can open" },
  { stage: "schedule", label: "Adding its schedule" },
];

export interface LocalCreateDeps {
  /** A new assistant folder in ~/UnoWork/Assistants on this computer. */
  readonly createAssistant: (input: {
    readonly name: string;
    readonly emoji: string;
    readonly template: string | null;
  }) => Promise<{ readonly projectId: string; readonly workspaceRoot: string | null }>;
  readonly readFile: (projectId: string, name: "AGENTS.md") => Promise<string>;
  readonly writeFile: (
    projectId: string,
    name: "AGENTS.md" | "SOUL.md" | "USER.md" | "NOTES.md",
    content: string,
  ) => Promise<void>;
  /** Apps it may open, stored and checked by Work on this computer. */
  readonly putApps: (projectId: string, permissions: ConnectorPermissions) => Promise<void>;
  /** Null: this computer can't be woken on a schedule (not an Uno cloud computer). */
  readonly createSchedule:
    | ((input: {
        readonly name: string;
        readonly cron: string;
        readonly command: string;
      }) => Promise<void>)
    | null;
  readonly onStage?: (stage: LocalCreateStage) => void;
  readonly now?: () => string;
}

export interface LocalCreateResult {
  readonly projectId: string;
  readonly accessSet: boolean;
  readonly scheduleCreated: boolean;
  readonly notes: ReadonlyArray<string>;
}

/**
 * "Create" for an assistant on this computer: its folder (the daemon), who
 * it is (SOUL/USER/NOTES, and its name in AGENTS.md), the template's apps
 * (checked by Work here), the schedule if one was picked. Only the folder is
 * fatal; the rest becomes a note the person can act on.
 */
export async function createLocalAssistant(
  plan: AssistantPlan,
  deps: LocalCreateDeps,
): Promise<LocalCreateResult> {
  const now = deps.now?.() ?? new Date().toISOString();
  const notes: string[] = [];

  deps.onStage?.("assistant");
  const { projectId, workspaceRoot } = await deps.createAssistant({
    name: plan.name,
    emoji: plan.emoji,
    template: plan.template,
  });
  const files = assistantFiles(plan, now);
  await deps.writeFile(projectId, "SOUL.md", files.soul);
  await deps.writeFile(projectId, "USER.md", files.user);
  await deps.writeFile(projectId, "NOTES.md", files.notes).catch(() => undefined);
  const agents = await deps.readFile(projectId, "AGENTS.md").catch(() => "");
  await deps
    .writeFile(
      projectId,
      "AGENTS.md",
      withAgentsProfile(agents, { name: plan.name, about: files.about }),
    )
    .catch(() => undefined);

  deps.onStage?.("access");
  const accessSet = await deps.putApps(projectId, plan.connectors).then(
    () => true,
    () => false,
  );
  if (!accessSet) {
    notes.push(
      `Uno couldn't set which apps ${plan.name} opens. Until it does, ${plan.name} reaches every app you connected. Check "Apps ${plan.name} can open" on its page.`,
    );
  }

  deps.onStage?.("schedule");
  let scheduleCreated = false;
  if (plan.schedule) {
    if (deps.createSchedule === null) {
      notes.push(
        `This computer can't wake ${plan.name} on a schedule. Ask ${plan.name} for reminders in the chat, or give it its own computer.`,
      );
    } else {
      scheduleCreated = await deps
        .createSchedule({
          name: `${plan.name}: ${plan.schedule.label}`,
          cron: plan.schedule.cron,
          command: assistantTurnCommand(plan.job, workspaceRoot),
        })
        .then(
          () => true,
          () => false,
        );
      if (!scheduleCreated) {
        notes.push(
          `Uno couldn't add the schedule (${plan.schedule.label.toLowerCase()}). Ask ${plan.name} in the chat to set it up.`,
        );
      }
    }
  }

  deps.onStage?.("done");
  return { projectId, accessSet, scheduleCreated, notes };
}
