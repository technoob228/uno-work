/**
 * Reading and writing settings for a scope: one project, one computer, or all
 * of them. Ported from T3 Code. Pure, so what a write reaches can be tested.
 *
 * Two things differ from T3. There is no t3.json layer. And the model for new
 * chats has one more layer than the rest: "All computers" is the app's own
 * "New chats start on", which also reaches computers that are asleep.
 *
 * @module components/settings/scopedSettings
 */
import {
  type ClientSettingsPatch,
  ClientSettingsSchema,
  type EnvironmentId,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  type ProjectScopedServerSettingKey,
  type ProjectSettingsOverrides,
  ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  clearProjectSettingsOverrides,
  resolveProjectSettings,
  type ProjectSettingSource,
} from "@t3tools/shared/projectSettings";
import * as Equal from "effect/Equal";

import type { ResolvedSettingsScope } from "./settingsScope";

export type ScopedSettingsPatch = ServerSettingsPatch & ClientSettingsPatch;

export interface ScopedSettingsEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  readonly serverConfig: { readonly settings: ServerSettings } | null;
}

const SERVER_KEYS = new Set<string>(Object.keys(ServerSettings.fields));
const CLIENT_KEYS = new Set<string>(Object.keys(ClientSettingsSchema.fields));
const PROJECT_SCOPED_KEYS = new Set<string>(PROJECT_SCOPED_SERVER_SETTING_KEYS);

export function isProjectScopedSettingKey(key: string): key is ProjectScopedServerSettingKey {
  return PROJECT_SCOPED_KEYS.has(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isConnectedWithConfig(
  environment: Pick<ScopedSettingsEnvironment, "connected" | "serverConfig">,
) {
  return environment.connected && environment.serverConfig !== null;
}

/** The representative supplies display values, never the set of write targets. */
export function selectScopedSettingsEnvironments<T extends ScopedSettingsEnvironment>(
  scope: ResolvedSettingsScope,
  available: readonly T[],
  primaryEnvironmentId: EnvironmentId | null,
) {
  const selectedIds = new Set(scope.environmentIds);
  const environments = available.filter((environment) =>
    selectedIds.has(environment.environmentId),
  );
  const connectedEnvironments = environments.filter(isConnectedWithConfig);
  const unreachableEnvironments = environments.filter(
    (environment) => !isConnectedWithConfig(environment),
  );
  const environment =
    connectedEnvironments.find((candidate) => candidate.environmentId === primaryEnvironmentId) ??
    connectedEnvironments[0] ??
    null;
  return { environments, connectedEnvironments, unreachableEnvironments, environment };
}

export interface ScopedSettingsTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly projectId: string | null;
  readonly settings: ServerSettings;
  readonly sources: Readonly<Record<ProjectScopedServerSettingKey, ProjectSettingSource>>;
}

export function resolveScopedSettingsTargets(
  scope: ResolvedSettingsScope,
  connectedEnvironments: readonly ScopedSettingsEnvironment[],
): readonly ScopedSettingsTarget[] {
  const byId = new Map(
    connectedEnvironments.map((environment) => [environment.environmentId, environment]),
  );
  if (scope.kind === "project") {
    return scope.members.flatMap((member) => {
      const environment = byId.get(member.environmentId);
      if (!environment?.serverConfig) return [];
      const resolved = resolveProjectSettings(environment.serverConfig.settings, member.id);
      return [
        {
          environmentId: member.environmentId,
          label: environment.label,
          projectId: member.id,
          settings: resolved.settings,
          sources: resolved.sources,
        },
      ];
    });
  }
  return connectedEnvironments.flatMap((environment) =>
    environment.serverConfig
      ? [
          {
            environmentId: environment.environmentId,
            label: environment.label,
            projectId: null,
            settings: environment.serverConfig.settings,
            sources: resolveProjectSettings(environment.serverConfig.settings, null).sources,
          },
        ]
      : [],
  );
}

export function scopedSettingsAreMixed(
  targets: readonly Pick<ScopedSettingsTarget, "settings">[],
  keys: readonly (keyof ServerSettings)[],
): boolean {
  const first = targets[0];
  return (
    first !== undefined &&
    targets.some((candidate) =>
      keys.some((key) => !Equal.equals(first.settings[key], candidate.settings[key])),
    )
  );
}

export type ScopedSettingSource = ProjectSettingSource | "mixed";

export function scopedSettingsSource(
  targets: readonly Pick<ScopedSettingsTarget, "sources">[],
  keys: readonly (keyof ServerSettings)[],
): ScopedSettingSource {
  const scoped = keys.filter(isProjectScopedSettingKey);
  if (scoped.length === 0 || targets.length === 0) return "environment";
  const sources = new Set(targets.flatMap((target) => scoped.map((key) => target.sources[key])));
  return sources.size > 1 ? "mixed" : sources.has("project") ? "project" : "environment";
}

export interface ScopedServerWrite {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly patch: ServerSettingsPatch;
  readonly previous: ServerSettings;
}

export interface ScopedSettingsPlan {
  readonly clientPatch: ClientSettingsPatch;
  readonly hasClientWrite: boolean;
  readonly serverWrites: readonly ScopedServerWrite[];
  /** Computers in the scope that this write can't reach now. */
  readonly skipped: readonly string[];
  readonly unavailableReason: string | null;
}

function projectOverrideWrites(
  scope: Extract<ResolvedSettingsScope, { kind: "project" }>,
  environments: readonly ScopedSettingsEnvironment[],
  update: (
    current: ProjectSettingsOverrides,
    settings: ServerSettings,
    projectId: string,
  ) => ProjectSettingsOverrides | null,
): ScopedServerWrite[] {
  const byId = new Map(environments.map((environment) => [environment.environmentId, environment]));
  const writes = new Map<EnvironmentId, ScopedServerWrite>();
  for (const member of scope.members) {
    const environment = byId.get(member.environmentId);
    if (!environment?.serverConfig || !environment.connected) continue;
    const settings = environment.serverConfig.settings;
    const entry = update(settings.projectSettingsOverrides[member.id] ?? {}, settings, member.id);
    const existing = writes.get(member.environmentId);
    writes.set(member.environmentId, {
      environmentId: member.environmentId,
      label: environment.label,
      previous: settings,
      patch: {
        projectSettingsOverrides: {
          ...existing?.patch.projectSettingsOverrides,
          [member.id]: entry,
        },
      },
    });
  }
  return [...writes.values()];
}

function skippedComputers(
  scope: ResolvedSettingsScope,
  environments: readonly ScopedSettingsEnvironment[],
): readonly string[] {
  const { unreachableEnvironments } = selectScopedSettingsEnvironments(scope, environments, null);
  return unreachableEnvironments.map((environment) => environment.label);
}

/**
 * "All computers" for the new-chat model is the app's own setting, and it
 * clears what a computer has set for itself: all means all. Everything else
 * goes to each computer.
 */
function moveAllComputersModel(
  scope: ResolvedSettingsScope,
  patch: ScopedSettingsPatch,
): { readonly patch: ScopedSettingsPatch; readonly clearComputerModel: boolean } {
  if (scope.kind !== "all" || !("defaultModelSelection" in patch)) {
    return { patch, clearComputerModel: false };
  }
  const { defaultModelSelection, ...rest } = patch;
  return {
    patch: { ...rest, newChatModelSelection: defaultModelSelection ?? null },
    clearComputerModel: true,
  };
}

export function planScopedSettingsPatch(
  scope: ResolvedSettingsScope,
  environments: readonly ScopedSettingsEnvironment[],
  rawPatch: ScopedSettingsPatch,
): ScopedSettingsPlan {
  const { patch, clearComputerModel } = moveAllComputersModel(scope, rawPatch);
  const clientPatch = Object.fromEntries(
    Object.entries(patch).filter(([key]) => CLIENT_KEYS.has(key) && !SERVER_KEYS.has(key)),
  ) as ClientSettingsPatch;
  const serverPatch = Object.fromEntries(
    Object.entries(patch).filter(([key]) => SERVER_KEYS.has(key)),
  ) as ServerSettingsPatch;
  const serverKeys = Object.keys(serverPatch);
  const { connectedEnvironments } = selectScopedSettingsEnvironments(scope, environments, null);
  const isProjectScope = scope.kind === "project";
  const unscopableKeys = isProjectScope
    ? serverKeys.filter((key) => !isProjectScopedSettingKey(key))
    : [];

  const computerWrites = (): ScopedServerWrite[] =>
    connectedEnvironments.flatMap((environment) => {
      const previous = environment.serverConfig?.settings;
      if (!previous) return [];
      const next: ServerSettingsPatch = {
        ...serverPatch,
        ...(clearComputerModel && previous.defaultModelSelection !== null
          ? { defaultModelSelection: null }
          : {}),
      };
      return Object.keys(next).length === 0
        ? []
        : [
            {
              environmentId: environment.environmentId,
              label: environment.label,
              previous,
              patch: next,
            },
          ];
    });

  const serverWrites: ScopedServerWrite[] =
    scope.kind === "project"
      ? serverKeys.length === 0 || unscopableKeys.length > 0
        ? []
        : projectOverrideWrites(scope, environments, (current) => {
            const next: Record<string, unknown> = { ...current };
            for (const [key, value] of Object.entries<unknown>(serverPatch)) {
              // Overrides can't store null: it means "inherit".
              if (value === null) delete next[key];
              else next[key] = value;
            }
            return Object.keys(next).length === 0 ? null : (next as ProjectSettingsOverrides);
          })
      : scope.kind === "all" || scope.kind === "environment"
        ? computerWrites()
        : [];

  const hasClientWrite = Object.keys(clientPatch).length > 0;
  const hasWrite = hasClientWrite || serverWrites.length > 0;
  const unavailableReason =
    hasWrite || Object.keys(patch).length === 0
      ? null
      : scope.kind === "unavailable"
        ? scope.message
        : unscopableKeys.length > 0
          ? "This setting is for the whole computer. A project can't change it."
          : isProjectScope
            ? "Turn on a computer with this project to save it."
            : `Turn on ${scope.kind === "environment" ? scope.label : "a computer"} to save this.`;
  return {
    clientPatch,
    hasClientWrite,
    serverWrites,
    skipped: skippedComputers(scope, environments),
    unavailableReason,
  };
}

export function planScopedSettingsClear(
  scope: ResolvedSettingsScope,
  environments: readonly ScopedSettingsEnvironment[],
  keys: readonly ProjectScopedServerSettingKey[],
): ScopedSettingsPlan {
  const serverWrites =
    scope.kind === "project"
      ? projectOverrideWrites(scope, environments, (_current, settings, projectId) =>
          clearProjectSettingsOverrides(settings, projectId, keys),
        )
      : [];
  return {
    clientPatch: {},
    hasClientWrite: false,
    serverWrites,
    skipped: skippedComputers(scope, environments),
    unavailableReason:
      serverWrites.length > 0 ? null : "Turn on a computer with this project to reset it.",
  };
}

export interface ProjectOverrideEntry {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
}

export function listProjectOverrides(
  environments: readonly ScopedSettingsEnvironment[],
  keys: readonly (keyof ServerSettings)[],
): readonly ProjectOverrideEntry[] {
  const scoped = keys.filter(isProjectScopedSettingKey);
  if (scoped.length === 0) return [];
  return environments.flatMap((environment) => {
    const overrides = environment.serverConfig?.settings.projectSettingsOverrides;
    if (!overrides) return [];
    return Object.entries(overrides).flatMap(([projectId, entry]) =>
      scoped.some((key) => Object.hasOwn(entry, key))
        ? [{ environmentId: environment.environmentId, projectId }]
        : [],
    );
  });
}

export function planProjectOverridesClear(
  environments: readonly ScopedSettingsEnvironment[],
  entries: readonly ProjectOverrideEntry[],
  keys: readonly ProjectScopedServerSettingKey[],
): ScopedSettingsPlan {
  const byId = new Map(environments.map((environment) => [environment.environmentId, environment]));
  const writes = new Map<EnvironmentId, ScopedServerWrite>();
  for (const { environmentId, projectId } of entries) {
    const environment = byId.get(environmentId);
    if (!environment?.serverConfig || !environment.connected) continue;
    const settings = environment.serverConfig.settings;
    const existing = writes.get(environmentId);
    writes.set(environmentId, {
      environmentId,
      label: environment.label,
      previous: settings,
      patch: {
        projectSettingsOverrides: {
          ...existing?.patch.projectSettingsOverrides,
          [projectId]: clearProjectSettingsOverrides(settings, projectId, keys),
        },
      },
    });
  }
  const serverWrites = [...writes.values()];
  return {
    clientPatch: {},
    hasClientWrite: false,
    serverWrites,
    skipped: [],
    unavailableReason: serverWrites.length > 0 ? null : "Turn on the computers to reset these.",
  };
}

function writeWasDropped(value: unknown, before: unknown, saved: unknown): boolean {
  if (value === null) return before != null && Equal.equals(saved, before);
  if (isPlainObject(value) && !Array.isArray(before) && !Array.isArray(saved)) {
    const field = (source: unknown, key: string) =>
      isPlainObject(source) ? source[key] : undefined;
    return Object.entries(value).some(([key, next]) =>
      writeWasDropped(next, field(before, key), field(saved, key)),
    );
  }
  const unchanged =
    typeof value === "string" && typeof before === "string"
      ? value.trim() === before
      : Equal.equals(value, before);
  return !unchanged && Equal.equals(saved, before);
}

/** An older computer silently drops keys it doesn't know; say so instead of showing it saved. */
function droppedSettingKeys(write: ScopedServerWrite, saved: ServerSettings | undefined) {
  if (saved === undefined) return [];
  return Object.entries(write.patch).flatMap(([key, value]) =>
    writeWasDropped(
      value,
      write.previous[key as keyof ServerSettings],
      saved[key as keyof ServerSettings],
    )
      ? [key]
      : [],
  );
}

export interface ScopedSettingsOutcome {
  readonly failed: readonly { readonly label: string; readonly message: string }[];
  readonly saved: readonly string[];
}

export async function persistScopedSettingsPatch(
  plan: ScopedSettingsPlan,
  persistServer: (
    environmentId: EnvironmentId,
    patch: ServerSettingsPatch,
  ) => Promise<ServerSettings | undefined>,
  persistClient: (patch: ClientSettingsPatch) => void,
): Promise<ScopedSettingsOutcome> {
  if (plan.hasClientWrite) persistClient(plan.clientPatch);
  const results = await Promise.allSettled(
    plan.serverWrites.map(({ environmentId, patch }) => persistServer(environmentId, patch)),
  );
  const failed: { label: string; message: string }[] = [];
  const saved: string[] = [];
  plan.serverWrites.forEach((write, index) => {
    const result = results[index];
    if (result?.status === "rejected") {
      const error: unknown = result.reason;
      failed.push({
        label: write.label,
        message: error instanceof Error ? error.message : "Try reconnecting and saving again.",
      });
    } else if (droppedSettingKeys(write, result?.value).length > 0) {
      failed.push({ label: write.label, message: "Update Uno Work on it to use this setting." });
    } else {
      saved.push(write.label);
    }
  });
  return { failed, saved };
}
