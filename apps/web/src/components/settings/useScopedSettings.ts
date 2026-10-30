/**
 * Hooks over `scopedSettings`: read the value a scope shows, write it to every
 * computer the scope covers, and tell the person what didn't land. Ported from
 * T3 Code.
 *
 * @module components/settings/useScopedSettings
 */
import {
  DEFAULT_SERVER_SETTINGS,
  type ProjectScopedServerSettingKey,
  type ServerSettings,
} from "@t3tools/contracts";
import { useMemo } from "react";

import { updateEnvironmentSettings } from "../../environments/settings/serverSettings";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { toastManager } from "../ui/toast";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import {
  persistScopedSettingsPatch,
  planProjectOverridesClear,
  planScopedSettingsClear,
  planScopedSettingsPatch,
  type ProjectOverrideEntry,
  scopedSettingsAreMixed,
  scopedSettingsSource,
  type ScopedSettingsPatch,
  type ScopedSettingsPlan,
} from "./scopedSettings";

/** The scope's settings, shown from one representative computer. */
export function useScopedSettings(): ServerSettings {
  const { target, environments } = useSettingsScope();
  // A computer that is off shows what it last reported, not the defaults.
  const lastKnown = environments.find((entry) => entry.serverConfig)?.serverConfig?.settings;
  return target?.settings ?? lastKnown ?? DEFAULT_SERVER_SETTINGS;
}

export function useScopedSettingsMixed(keys: readonly (keyof ServerSettings)[]): boolean {
  const { targets } = useSettingsScope();
  return scopedSettingsAreMixed(targets, keys);
}

export function useScopedSettingSource(keys: readonly (keyof ServerSettings)[]) {
  const { targets } = useSettingsScope();
  return scopedSettingsSource(targets, keys);
}

function useRunScopedPlan() {
  const { updateSettings } = useUpdateSettings();
  return (plan: ScopedSettingsPlan, onFailed?: () => void) => {
    if (plan.unavailableReason) {
      toastManager.add({
        type: "warning",
        title: "Not saved",
        description: plan.unavailableReason,
      });
      onFailed?.();
      return;
    }
    void persistScopedSettingsPatch(plan, updateEnvironmentSettings, (patch) => {
      void updateSettings(patch);
    }).then(({ failed, saved }) => {
      const missed = plan.hasClientWrite ? [] : plan.skipped;
      if (failed.length === 0 && missed.length === 0) return;
      if (failed.length > 0) onFailed?.();
      toastManager.add({
        type: failed.length > 0 ? "error" : "warning",
        title: saved.length > 0 ? `Saved on ${saved.join(", ")}` : "Not saved",
        description: [
          ...failed.map(({ label, message }) => `${label}: ${message}`),
          ...(missed.length > 0 ? [`${missed.join(", ")} is off and keeps its value.`] : []),
        ].join("\n"),
      });
    });
  };
}

export function useUpdateScopedSettings() {
  const { scope, allEnvironments } = useSettingsScope();
  const run = useRunScopedPlan();
  /** `onFailed` runs when a computer rejects or drops the patch, so a draft can fall back. */
  return (patch: ScopedSettingsPatch, options?: { readonly onFailed?: () => void }) =>
    run(planScopedSettingsPatch(scope, allEnvironments, patch), options?.onFailed);
}

export function useClearScopedSettings() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  return (keys: readonly ProjectScopedServerSettingKey[]) => {
    if (context === null) return;
    run(planScopedSettingsClear(context.scope, context.allEnvironments, keys));
  };
}

export function useClearProjectOverrides() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  return (
    entries: readonly ProjectOverrideEntry[],
    keys: readonly ProjectScopedServerSettingKey[],
  ) => {
    if (context === null) return;
    run(planProjectOverridesClear(context.allEnvironments, entries, keys));
  };
}

/** Where the model for new chats comes from at this scope, the app's own layer included. */
export function useScopedNewChatModel() {
  const { targets, target, scope } = useSettingsScope();
  const appChoice = useSettings((settings) => settings.newChatModelSelection);
  return useMemo(() => {
    const effective = (candidate: (typeof targets)[number]) =>
      candidate.settings.defaultModelSelection ?? appChoice;
    const first = target ? effective(target) : appChoice;
    const key = (value: typeof first) => (value ? `${value.instanceId}\u0000${value.model}` : "");
    const mixed = targets.some((candidate) => key(effective(candidate)) !== key(first));
    const setHere =
      scope.kind === "project"
        ? targets.some((candidate) => candidate.sources.defaultModelSelection === "project")
        : scope.kind === "environment"
          ? targets.some((candidate) => candidate.settings.defaultModelSelection !== null)
          : appChoice !== null;
    return { effective: first, mixed, setHere, appChoice };
  }, [appChoice, scope.kind, target, targets]);
}
