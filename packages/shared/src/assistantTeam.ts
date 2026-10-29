/**
 * The team of assistants (decisions 14.10, 16.10): who may give whom what.
 *
 * An assistant's rights are three things the daemon already enforces — its
 * preset (Full / Helper / Observer, on its token), the projects it works in
 * (its token's allowlist) and a level per connected app (`apps.json`). This
 * module compares two such grants, so that
 *
 * - an assistant setting up a helper (`assistant_create`) never gives it
 *   more than it has itself (decision 14.10 (3): child ⊆ parent, checked by
 *   the daemon, not the prompt);
 * - an assistant saving its own setup (`assistant_profile_set`) only narrows
 *   its rights — widening is the person's, on its page;
 * - cutting an assistant's rights cuts everything it set up, all the way
 *   down, and says who lost what (decision 16.10 (3) A).
 *
 * The same functions serve the UI's warnings ("Scout will lose: …"), so the
 * two can't drift. Pure: no I/O.
 */
import type {
  AssistantAppLevel,
  AssistantPreset,
  AssistantSetupStepId,
  ManagerProjectAllowlist,
} from "@t3tools/contracts";
import { ASSISTANT_PROJECT_ID_PREFIX } from "@t3tools/contracts";

import { ASSISTANT_PRESET_COPY, capAppLevel, defaultAppLevel } from "./assistantPreset.ts";

/** What an assistant may do and reach — the parts the daemon enforces. */
export interface TeamGrant {
  readonly preset: AssistantPreset;
  /**
   * Projects beyond its own workspace: "all" (new ones too) or ids. Never an
   * assistant's workspace: each one's own is implied, the others' aren't given.
   */
  readonly projects: "all" | ReadonlyArray<string>;
  /** Level per app provider; an app not listed is at its default (`defaultAppLevel`: full, Outlook reads). */
  readonly apps: Readonly<Record<string, AssistantAppLevel>>;
}

/** The four apps of the Uno account (other providers compare the same way). */
export const TEAM_APP_PROVIDERS = ["gmail", "google-drive", "notion", "github"] as const;

export const TEAM_APP_NAME: Readonly<Record<string, string>> = {
  gmail: "Gmail & Calendar",
  "google-drive": "Google Drive",
  notion: "Notion",
  github: "GitHub",
  microsoft: "Outlook & Teams calendar",
};

const appName = (provider: string) => TEAM_APP_NAME[provider] ?? provider;

const PRESET_RANK: Readonly<Record<AssistantPreset, number>> = { observer: 0, helper: 1, full: 2 };
const LEVEL_RANK: Readonly<Record<AssistantAppLevel, number>> = { none: 0, read: 1, write: 2 };

export function presetRank(preset: AssistantPreset): number {
  return PRESET_RANK[preset];
}

/** The level an app is really at for this grant: what is set, at most the preset's cap. */
export function grantAppLevel(grant: TeamGrant, provider: string): AssistantAppLevel {
  return capAppLevel(grant.apps[provider] ?? defaultAppLevel(provider), grant.preset);
}

/** Projects without assistant workspaces (those are never given to another assistant). */
export function teamProjects(allowlist: ManagerProjectAllowlist): "all" | ReadonlyArray<string> {
  if (allowlist === "all") return "all";
  return [...new Set(allowlist as ReadonlyArray<string>)].filter(
    (id) => !id.startsWith(ASSISTANT_PROJECT_ID_PREFIX),
  );
}

/** A grant from what the daemon keeps: the token's scopes → preset, its allowlist, `apps.json`. */
export function teamGrant(input: {
  readonly preset: AssistantPreset;
  readonly allowlist: ManagerProjectAllowlist;
  readonly apps: Readonly<Record<string, AssistantAppLevel>>;
}): TeamGrant {
  return { preset: input.preset, projects: teamProjects(input.allowlist), apps: input.apps };
}

const providersOf = (...grants: ReadonlyArray<TeamGrant>) => [
  ...new Set<string>([
    ...TEAM_APP_PROVIDERS,
    ...grants.flatMap((grant) => Object.keys(grant.apps)),
  ]),
];

/**
 * What `child` would have beyond `parent`, in plain words (empty = within).
 * Also "what would this change widen", with the current grant as `parent`.
 */
export function grantBeyond(parent: TeamGrant, child: TeamGrant): ReadonlyArray<string> {
  const beyond: string[] = [];
  if (PRESET_RANK[child.preset] > PRESET_RANK[parent.preset]) {
    beyond.push(
      `"${ASSISTANT_PRESET_COPY[child.preset].name}" is more than "${ASSISTANT_PRESET_COPY[parent.preset].name}"`,
    );
  }
  if (parent.projects !== "all") {
    if (child.projects === "all") beyond.push("every project");
    else {
      const allowed = new Set(parent.projects);
      for (const id of child.projects) if (!allowed.has(id)) beyond.push(`project ${id}`);
    }
  }
  for (const provider of providersOf(parent, child)) {
    const want = grantAppLevel(child, provider);
    const has = grantAppLevel(parent, provider);
    if (LEVEL_RANK[want] > LEVEL_RANK[has]) {
      beyond.push(has === "none" ? appName(provider) : `changes in ${appName(provider)}`);
    }
  }
  return beyond;
}

export function grantWithin(parent: TeamGrant, child: TeamGrant): boolean {
  return grantBeyond(parent, child).length === 0;
}

/**
 * `child` cut down to what `parent` has; `lost` says what went, in plain
 * words. Unchanged parts stay exactly as they were.
 */
export function clampGrant(
  parent: TeamGrant,
  child: TeamGrant,
): { readonly grant: TeamGrant; readonly lost: ReadonlyArray<string> } {
  const lost: string[] = [];
  let preset = child.preset;
  if (PRESET_RANK[child.preset] > PRESET_RANK[parent.preset]) {
    lost.push(
      `"${ASSISTANT_PRESET_COPY[child.preset].name}" → "${ASSISTANT_PRESET_COPY[parent.preset].name}"`,
    );
    preset = parent.preset;
  }
  let projects = child.projects;
  if (parent.projects !== "all") {
    const allowed = parent.projects;
    if (child.projects === "all") {
      lost.push(allowed.length === 0 ? "every project" : "projects beyond its creator's");
      projects = allowed;
    } else {
      const kept = child.projects.filter((id) => allowed.includes(id));
      for (const id of child.projects) if (!allowed.includes(id)) lost.push(`project ${id}`);
      projects = kept;
    }
  }
  const apps: Record<string, AssistantAppLevel> = { ...child.apps };
  for (const provider of providersOf(parent, child)) {
    const was = grantAppLevel({ ...child, preset }, provider);
    const max = grantAppLevel(parent, provider);
    if (LEVEL_RANK[was] > LEVEL_RANK[max]) {
      apps[provider] = max;
      lost.push(max === "none" ? appName(provider) : `changes in ${appName(provider)}`);
    }
  }
  return { grant: { preset, projects, apps }, lost };
}

/** Everything `id` set up, and what those set up, all the way down (nearest first). */
export function teamDescendants(
  items: ReadonlyArray<{ readonly id: string; readonly createdBy: string | null }>,
  id: string,
): ReadonlyArray<string> {
  const out: string[] = [];
  const queue = [id];
  const seen = new Set([id]);
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const item of items) {
      if (item.createdBy === parent && !seen.has(item.id)) {
        seen.add(item.id);
        out.push(item.id);
        queue.push(item.id);
      }
    }
  }
  return out;
}

/**
 * The setup an assistant runs in its chat (Misha 16.10, "like Grok's
 * companions"): one question at a time, each answer saved at once, any one
 * skippable. The instructions list these; its page shows how far it got.
 * No "routine" step since 28.10 (Misha): recurring work is an automation,
 * made later on the Automations page or by asking (the id stays known so
 * older saved progress still reads).
 */
export const ASSISTANT_SETUP_STEPS: ReadonlyArray<{
  readonly id: AssistantSetupStepId;
  readonly header: string;
  readonly ask: string;
}> = [
  {
    id: "role",
    header: "My job",
    ask: "what it should take off the person's plate (its area: Personal, Finance, Sales, Dev, YouTube & content — or their own words)",
  },
  {
    id: "duties",
    header: "Always on me",
    ask: "what it is always responsible for — standing duties, one line each (watch CI on a project, a morning plan at 9, answer support mail)",
  },
  { id: "character", header: "How I talk", ask: "how it should talk (its character)" },
  { id: "channel", header: "Where we talk", ask: "where the person wants to reach it" },
  {
    id: "access",
    header: "What I may do",
    ask: 'how much it does on its own — "Autonomous" (preset full) or "Cautious" (preset helper: asks before email out, sites, deploys, share links, deleting, new databases / computers / assistants) — and which projects are its',
  },
  { id: "apps", header: "Apps", ask: "what it may do in each connected app" },
  {
    id: "mail",
    header: "My email",
    ask: "its own email: on or off, who it may write to (anyone / only the person / a list) and how many letters a day",
  },
  {
    id: "computer",
    header: "Where I work",
    ask: "where it should work: this computer (stops when a laptop sleeps), one of their cloud computers (always on) or a new computer of its own — moving is the person's click on its page",
  },
  { id: "first-task", header: "First task", ask: "its first task" },
];

/** Steps neither answered nor skipped yet, in order. */
export function setupStepsLeft(progress: {
  readonly answered: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<string>;
}): ReadonlyArray<AssistantSetupStepId> {
  const done = new Set([...progress.answered, ...progress.skipped]);
  return ASSISTANT_SETUP_STEPS.map((step) => step.id).filter((id) => !done.has(id));
}
