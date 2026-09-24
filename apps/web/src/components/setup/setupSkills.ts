/**
 * Skills setup offers: two picked for the kind of work, the rest under
 * "More skills". The files ship with the app (`public/skills/<id>/`, a copy
 * of the approved catalog in ~/uno-project/skills) and the daemon installs a
 * folder for every agent on the machine (`skills.install`, see
 * apps/server/src/skills/skillInstaller.ts) — so it works offline.
 */
import type { EnvironmentId } from "@t3tools/contracts";

import { ensureEnvironmentApi } from "../../environmentApi";

export type SetupSkillId =
  | "up-to-date-docs"
  | "impeccable"
  | "presentations"
  | "sales-copy"
  | "server-safety"
  | "deck-critic"
  | "code-security-review";

export type SetupSkillIcon = "book" | "palette" | "slides" | "feather" | "shield" | "check" | "bug";

export interface SetupSkill {
  /** Folder name = the `name:` in its SKILL.md. */
  readonly id: SetupSkillId;
  readonly name: string;
  readonly by: string;
  readonly description: string;
  readonly example: string;
  readonly icon: SetupSkillIcon;
}

export const SETUP_SKILLS: Readonly<Record<SetupSkillId, SetupSkill>> = {
  "up-to-date-docs": {
    id: "up-to-date-docs",
    name: "Up-to-date docs",
    by: "Uno · uses Context7",
    description:
      "Reads the current docs of a library before it writes code, so it doesn’t use old APIs.",
    example: "“Add a contact form” → checks today’s docs for the form library first.",
    icon: "book",
  },
  impeccable: {
    id: "impeccable",
    name: "Frontend design",
    by: "impeccable.style · Apache-2.0",
    description: "Makes pages that look designed, not like a template: type, spacing, color.",
    example: "“Make the landing page” → a real layout, not a generic hero with three cards.",
    icon: "palette",
  },
  presentations: {
    id: "presentations",
    name: "Presentations",
    by: "Uno · Apache-2.0",
    description: "Slides with a point on every page: clear titles, real charts, sources.",
    example: "“Make a deck for the investor call” → ten slides you can present as is.",
    icon: "slides",
  },
  "sales-copy": {
    id: "sales-copy",
    name: "Clear writing",
    by: "Uno",
    description: "Short, concrete texts for customers: pages, emails, posts, buttons.",
    example: "“Write the newsletter” → half the words, all the facts, no filler.",
    icon: "feather",
  },
  "server-safety": {
    id: "server-safety",
    name: "Server safety",
    by: "Uno",
    description: "Keeps secrets, ports and installs safe while it works on your computer.",
    example: "“Deploy the bot” → keys in .env, no open ports it doesn’t need.",
    icon: "shield",
  },
  "deck-critic": {
    id: "deck-critic",
    name: "Deck critic",
    by: "Sruthi Reddy · MIT",
    description: "Reviews a deck or document before you send it: a grade and the top 3 fixes.",
    example: "“Check my pitch” → what’s weak, section by section.",
    icon: "check",
  },
  "code-security-review": {
    id: "code-security-review",
    name: "Security review",
    by: "Sentry · Apache-2.0",
    description: "Checks code for real vulnerabilities, and reports only what it’s sure of.",
    example: "“Review the login code” → injection, auth and secrets, with fixes.",
    icon: "bug",
  },
};

export const ALL_SETUP_SKILLS: ReadonlyArray<SetupSkill> = Object.values(SETUP_SKILLS);

/** The second card fits the work; up-to-date docs is always first. */
export function offeredSkills(kind: string | null | undefined): ReadonlyArray<SetupSkill> {
  const second: SetupSkillId =
    kind === "site"
      ? "impeccable"
      : kind === "docs"
        ? "presentations"
        : kind === "bot"
          ? "server-safety"
          : "sales-copy";
  return [SETUP_SKILLS["up-to-date-docs"], SETUP_SKILLS[second]];
}

export function moreSkills(kind: string | null | undefined): ReadonlyArray<SetupSkill> {
  const offered = new Set(offeredSkills(kind).map((skill) => skill.id));
  return ALL_SETUP_SKILLS.filter((skill) => !offered.has(skill.id));
}

export interface SkillsStatus {
  readonly installed: ReadonlySet<string>;
  /** What this daemon build can install; an older daemon reports nothing. */
  readonly available: ReadonlySet<string>;
}

export async function readSkillsStatus(environmentId: EnvironmentId): Promise<SkillsStatus> {
  const result = await ensureEnvironmentApi(environmentId).skills.status({
    ids: ALL_SETUP_SKILLS.map((skill) => skill.id),
  });
  return { installed: new Set(result.installed), available: new Set(result.available) };
}

export async function installSkill(environmentId: EnvironmentId, id: SetupSkillId): Promise<void> {
  await ensureEnvironmentApi(environmentId).skills.install({ id });
}

export async function removeSkill(environmentId: EnvironmentId, id: SetupSkillId): Promise<void> {
  await ensureEnvironmentApi(environmentId).skills.remove({ id });
}
