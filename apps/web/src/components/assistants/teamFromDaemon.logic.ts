/**
 * The team as the daemon keeps it (decisions 14.10, 16.10; 22.10: the
 * prototype's screens on real data): each assistant's summary from
 * `GET /api/manager/assistants` — its token (preset, projects), its app
 * levels, its team record (face, role, character, setup, who set it up) —
 * read as the `AssistantProfile` the sidebar block and the assistant's page
 * show. The demo (`?demo=w0138`) keeps its own profiles in the browser.
 *
 * Pure: no I/O, no React.
 */
import {
  ASSISTANT_PROJECT_ID,
  ASSISTANT_SETUP_STEP_IDS,
  type AssistantAppLevel,
  isAssistantProjectId,
  type ManagerAssistantSummary,
  type ManagerAssistantTeam,
} from "@t3tools/contracts";
import { presetOfScopes } from "@t3tools/shared/assistantPreset";
import { TEAM_APP_PROVIDERS } from "@t3tools/shared/assistantTeam";

import {
  type ActivityKind,
  type AssistantAccess,
  type AssistantActivityEntry,
  type AssistantChannel,
  type AssistantProfile,
  type AvatarTone,
  AVATARS,
  type ConnectorAccess,
  assistantKeyOf,
  FULL_ACCESS,
} from "./assistantTeam.logic";

const TONES: ReadonlySet<string> = new Set(AVATARS.map((avatar) => avatar.tone).concat("violet"));

/** A stable tone for a face without one (an assistant from before the team). */
export function toneFor(projectId: string): AvatarTone {
  let hash = 0;
  for (const char of projectId) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return AVATARS[Math.abs(hash) % AVATARS.length]!.tone;
}

/** Where the person talks to it: a linked bot or Slack wins over what the setup said. */
export function channelOf(summary: Pick<ManagerAssistantSummary, "telegram" | "slack" | "team">): {
  readonly channel: AssistantChannel;
  readonly handle: string | null;
} {
  if (summary.telegram.configured) {
    return {
      // Uno's bot (the relay "Connect with Uno's bot" sets up), or one the person made.
      channel: summary.telegram.shared ? "uno-bot" : "own-bot",
      handle: summary.telegram.botUsername ? `@${summary.telegram.botUsername}` : null,
    };
  }
  if (summary.slack.configured) {
    return { channel: "slack", handle: summary.slack.botUserName ?? null };
  }
  const wanted = summary.team?.team.channel ?? null;
  return { channel: wanted === "slack" ? "slack" : "own-bot", handle: null };
}

/** Its projects beyond its own folder, by title ("all" = every project, new ones too). */
export function projectsOf(
  summary: Pick<ManagerAssistantSummary, "token" | "projectId">,
  titles: ReadonlyMap<string, string>,
): "all" | ReadonlyArray<string> {
  const allowlist = summary.token?.projectAllowlist ?? "all";
  if (allowlist === "all") return "all";
  return allowlist
    .filter((id) => id !== summary.projectId && !isAssistantProjectId(id))
    .map((id) => titles.get(id) ?? id);
}

/** The app levels it was given (an app never set is at "Reads & changes"). */
export function accessOfApps(
  apps: {
    readonly restricted: boolean;
    readonly permissions: Readonly<Record<string, string>>;
  } | null,
): AssistantAccess {
  if (apps === null || !apps.restricted || Object.keys(apps.permissions).length === 0) {
    return FULL_ACCESS;
  }
  const connectors: Record<string, "none" | "read" | "write"> = {};
  for (const [provider, level] of Object.entries(apps.permissions)) {
    if (level === "none" || level === "read" || level === "write") connectors[provider] = level;
  }
  return { ...FULL_ACCESS, connectors };
}

const ACTIVITY_KIND: Readonly<Record<string, ActivityKind>> = {
  teammate: "teammate",
  access: "access",
  denied: "denied",
  note: "note",
  setup: "note",
};

/** Set up — or in use already before the setup existed (a chat the person wrote in). */
export function isConfigured(team: ManagerAssistantTeam | null, personWroteToIt: boolean): boolean {
  if (team !== null && team.setup.state !== "not-started") return true;
  return personWroteToIt;
}

/** The profile the prototype's screens read, from the daemon's summary. */
export function profileFromDaemon(input: {
  readonly environmentId: string;
  readonly summary: ManagerAssistantSummary;
  /** Project id → title on that computer. */
  readonly projectTitles: ReadonlyMap<string, string>;
}): AssistantProfile {
  const { summary, environmentId } = input;
  const team = summary.team?.team ?? null;
  const isUno = summary.projectId === ASSISTANT_PROJECT_ID;
  const { channel, handle } = channelOf(summary);
  const tone = team?.tone && TONES.has(team.tone) ? (team.tone as AvatarTone) : null;
  const createdAt = team?.createdAt ?? summary.profile?.createdAt ?? summary.token?.createdAt;
  return {
    environmentId,
    projectId: summary.projectId,
    name: team?.name ?? (isUno ? "Uno" : summary.title),
    emoji: isUno ? null : (summary.profile?.emoji ?? "🙂"),
    avatar: isUno ? null : (summary.profile?.avatar ?? null),
    tone: tone ?? (isUno ? "violet" : toneFor(summary.projectId)),
    roles: team?.roles ?? (isUno ? ["Personal assistant"] : []),
    character: team?.character ?? "",
    skills: team?.skills ?? [],
    preset: summary.token ? presetOfScopes(summary.token.scopes) : "full",
    // One AI per computer for now: the page reads it from the computer.
    brain: "uno",
    channel,
    channelHandle: handle,
    projects: projectsOf(summary, input.projectTitles),
    computers: [environmentId],
    createdBy: team?.createdBy ? assistantKeyOf(environmentId, team.createdBy) : null,
    createdAt: createdAt ?? new Date(0).toISOString(),
    setUpAt: team?.setup.state === "done" ? (team.setup.updatedAt ?? createdAt ?? null) : null,
    revokedAt: team?.revokedAt ?? null,
    access: accessOfApps(summary.team?.apps ?? null),
    activity: (team?.activity ?? []).map((entry): AssistantActivityEntry => {
      const kind = ACTIVITY_KIND[entry.kind] ?? "note";
      return entry.by
        ? { at: entry.at, kind, text: entry.text, by: entry.by }
        : { at: entry.at, kind, text: entry.text };
    }),
  };
}

/** Project ids for titles the page shows (the preset API takes ids). */
export function projectIdsOf(
  projects: "all" | ReadonlyArray<string>,
  titles: ReadonlyMap<string, string>,
): "all" | ReadonlyArray<string> {
  if (projects === "all") return "all";
  const byTitle = new Map([...titles].map(([id, title]) => [title, id]));
  return projects.map((name) => byTitle.get(name) ?? name);
}

/** Setup progress for its page: "3 of 7 answered". */
export function setupProgressLine(
  team: ManagerAssistantTeam | null,
  options: { readonly isUno?: boolean } = {},
): string | null {
  if (team === null || team.setup.state === "not-started") return null;
  if (team.setup.state === "done") return null;
  // Uno isn't asked where it works: it is its computer's own.
  const steps = ASSISTANT_SETUP_STEP_IDS.filter((id) => !(options.isUno && id === "computer"));
  const done = steps.filter(
    (id) => team.setup.answered.includes(id) || team.setup.skipped.includes(id),
  ).length;
  return `Setup: ${done} of ${steps.length} answered — it goes on where it stopped`;
}

/** Every app at one level, or a level per app — as `apps.json` keeps it. */
export function appPermissionsOf(
  connectors: ConnectorAccess,
): Readonly<Record<string, AssistantAppLevel>> {
  if (typeof connectors === "string") {
    return Object.fromEntries(TEAM_APP_PROVIDERS.map((provider) => [provider, connectors]));
  }
  return { ...connectors };
}

/** "Ada lost project Site; Milo lost GitHub" — the daemon's losses by name. */
export function daemonLossLine(
  losses: ReadonlyArray<{ readonly projectId: string; readonly lost: ReadonlyArray<string> }>,
  nameOf: (projectId: string) => string,
): string | null {
  if (losses.length === 0) return null;
  return losses.map((loss) => `${nameOf(loss.projectId)} lost ${loss.lost.join(", ")}`).join("; ");
}
