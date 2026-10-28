/**
 * One click on "+" makes an assistant (Misha 23.10: "click create, click
 * Telegram, done"): no dialog, no questions. It gets
 *
 * - a name of its own and a random persona face (a person, an animal, a
 *   robot, an alien — never a generic smiley), both editable on its page;
 * - "Does it itself" on every project of this computer (Full);
 * - every app the person connected (nothing restricted) and its own email
 *   where the computer has mail (on by default, `DEFAULT_ASSISTANT_MAIL_POLICY`);
 * - "set up": its first click opens a chat, not a setup.
 *
 * With a plan from Home's quiz it also writes who it is from that plan
 * (`createLocalAssistant`). The steps are injected so this is unit-tested.
 */
import type { AssistantPresetAccess } from "@t3tools/contracts";

import { randomPersonaFace } from "./assistantAvatar.logic";
import { type AvatarTone, suggestName, uniqueName } from "./assistantTeam.logic";
import type { AssistantPlan } from "./assistantTemplates";

/** Full on every project: the one-click default. */
export const QUICK_ASSISTANT_ACCESS: AssistantPresetAccess = { preset: "full", projects: "all" };

export interface QuickCreateDeps {
  /** A new assistant folder on this computer (the daemon issues its token with `access`). */
  readonly createAssistant: (input: {
    readonly name: string;
    readonly emoji: string;
    readonly access: AssistantPresetAccess;
  }) => Promise<{ readonly projectId: string }>;
  /** The same, plus who it is from Home's plan (its files and apps). */
  readonly createFromPlan: (plan: AssistantPlan) => Promise<{ readonly projectId: string }>;
  /** Its team record: the face's tone, and "set up" so its first click opens a chat. */
  readonly finish: (
    projectId: string,
    input: { readonly tone: AvatarTone; readonly setup: "done" },
  ) => Promise<void>;
  readonly random: () => number;
}

export interface QuickCreateResult {
  readonly projectId: string;
  readonly name: string;
  readonly emoji: string;
}

export async function quickCreateAssistant(
  deps: QuickCreateDeps,
  input: {
    /** Who is on the team already (names are not repeated, faces preferably not). */
    readonly existing: ReadonlyArray<{ readonly name: string; readonly emoji: string | null }>;
    readonly plan?: AssistantPlan | null;
  },
): Promise<QuickCreateResult> {
  const names = input.existing.map((member) => member.name);
  const face = randomPersonaFace(
    deps.random,
    input.existing.map((member) => member.emoji),
  );
  const planName = input.plan?.name.trim();
  const name = planName ? uniqueName(planName, names) : suggestName(names);
  const { projectId } = input.plan
    ? await deps.createFromPlan({
        ...input.plan,
        name,
        emoji: face.emoji,
        access: QUICK_ASSISTANT_ACCESS,
      })
    : await deps.createAssistant({ name, emoji: face.emoji, access: QUICK_ASSISTANT_ACCESS });
  // Its face's tone and "set up" are cosmetic: the assistant is made either way.
  await deps.finish(projectId, { tone: face.tone, setup: "done" }).catch(() => undefined);
  return { projectId, name, emoji: face.emoji };
}
