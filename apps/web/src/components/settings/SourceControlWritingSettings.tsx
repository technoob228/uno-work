/**
 * Dev mode's Source Control sections: what happens when a pull request merges
 * and how generated commit and PR text is written.
 *
 * @module components/settings/SourceControlWritingSettings
 */
import {
  type EnvironmentId,
  type SourceControlWritingStyleMode,
  SourceControlWritingStyleMode as WritingModes,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { useCallback } from "react";

import {
  useEnvironmentSettings,
  useUpdateEnvironmentSettings,
} from "~/environments/settings/serverSettings";

import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

const WRITING_MODES: Record<
  SourceControlWritingStyleMode,
  { readonly label: string; readonly description: string }
> = {
  repo_conventions: {
    label: "Repository conventions",
    description: "Matches the recent commits of each project.",
  },
  conventional_commits: {
    label: "Conventional Commits",
    description: "Uses Conventional Commit prefixes and keeps PR text short.",
  },
  custom: {
    label: "Custom instructions",
    description: "Follows your own instructions.",
  },
};

function useSave(environmentId: EnvironmentId) {
  const { updateSettings } = useUpdateEnvironmentSettings(environmentId);
  return useCallback(
    (patch: Parameters<typeof updateSettings>[0]) => {
      void updateSettings(patch).catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not save",
          description: error instanceof Error ? error.message : String(error),
        });
      });
    },
    [updateSettings],
  );
}

export function PullRequestSettingsSection(props: { readonly environmentId: EnvironmentId }) {
  const settings = useEnvironmentSettings(props.environmentId) ?? DEFAULT_UNIFIED_SETTINGS;
  const save = useSave(props.environmentId);
  return (
    <SettingsSection title="Pull requests">
      <SettingsRow
        title="Move chats to Done after merge"
        description="A chat with a merged or closed PR moves to Done, unless you wrote in it afterwards. An open PR keeps the chat active."
        control={
          <Switch
            checked={settings.sidebarAutoSettleOnMerge}
            onCheckedChange={(checked) => save({ sidebarAutoSettleOnMerge: Boolean(checked) })}
            aria-label="Move chats to Done after merge"
          />
        }
      />
    </SettingsSection>
  );
}

export function WritingSettingsSection(props: { readonly environmentId: EnvironmentId }) {
  const settings = useEnvironmentSettings(props.environmentId) ?? DEFAULT_UNIFIED_SETTINGS;
  const save = useSave(props.environmentId);
  const style = settings.sourceControlWritingStyle;
  const defaults = DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle;
  const dirty = style.mode !== defaults.mode || style.customInstructions !== "";
  return (
    <SettingsSection title="Writing">
      <SettingsRow
        title="Commit and PR style"
        description={WRITING_MODES[style.mode].description}
        resetAction={
          dirty ? (
            <SettingResetButton
              label="writing style"
              onClick={() => save({ sourceControlWritingStyle: defaults })}
            />
          ) : null
        }
        control={
          <Select
            value={style.mode}
            onValueChange={(value) => {
              if (value === null) return;
              save({ sourceControlWritingStyle: { ...style, mode: value } });
            }}
          >
            <SelectTrigger size="sm" aria-label="Commit and PR style">
              <SelectValue>
                {(value: SourceControlWritingStyleMode) => WRITING_MODES[value].label}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {WritingModes.literals.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {WRITING_MODES[mode].label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {style.mode === "custom" ? (
        <SettingsRow
          title="Instructions"
          description="Added to the prompt for commit messages and PR text."
          control={
            <DraftInput
              className="w-full sm:w-72"
              value={style.customInstructions}
              onCommit={(next) =>
                save({ sourceControlWritingStyle: { ...style, customInstructions: next } })
              }
              placeholder="Short, imperative, no scope"
              aria-label="Writing instructions"
            />
          }
        />
      ) : null}
    </SettingsSection>
  );
}
