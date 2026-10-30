/**
 * Dev mode's Worktrees page: how new branches are named, when chat copies are
 * cleaned up, and which copies this computer holds.
 *
 * @module components/settings/WorktreesSettings
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import { BranchNamingMode, type EnvironmentId } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  useEnvironmentSettings,
  useUpdateEnvironmentSettings,
} from "~/environments/settings/serverSettings";

import { selectSidebarThreadsForEnvironment, useStore } from "../../store";
import { formatWorktreePathForDisplay } from "../../worktreeCleanup";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { ChatCopiesCleanupSection } from "./ChatCopiesCleanup";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

const NAMING_MODES: Record<
  BranchNamingMode,
  { readonly label: string; readonly description: string }
> = {
  static: {
    label: "Static prefix",
    description: "Every new branch starts with the same prefix.",
  },
  semantic: {
    label: "Semantic prefix",
    description: "The model picks a prefix that describes the work: feat/add-search, fix/login.",
  },
  custom: {
    label: "Custom instructions",
    description: "The model returns the whole name by your instructions.",
  },
};

function BranchNamingSection(props: { readonly environmentId: EnvironmentId }) {
  const settings = useEnvironmentSettings(props.environmentId) ?? DEFAULT_UNIFIED_SETTINGS;
  const { updateSettings } = useUpdateEnvironmentSettings(props.environmentId);
  const save = useCallback(
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
  const mode = settings.branchNamingMode;
  const defaults = DEFAULT_UNIFIED_SETTINGS;
  return (
    <SettingsSection title="Branches">
      <SettingsRow
        title="Branch naming"
        description={NAMING_MODES[mode].description}
        resetAction={
          mode !== defaults.branchNamingMode ? (
            <SettingResetButton
              label="branch naming"
              onClick={() => save({ branchNamingMode: defaults.branchNamingMode })}
            />
          ) : null
        }
        control={
          <Select
            value={mode}
            onValueChange={(value) => {
              if (value !== null) save({ branchNamingMode: value });
            }}
          >
            <SelectTrigger size="sm" aria-label="Branch naming">
              <SelectValue>{(value: BranchNamingMode) => NAMING_MODES[value].label}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {BranchNamingMode.literals.map((value) => (
                <SelectItem key={value} value={value}>
                  {NAMING_MODES[value].label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {mode === "static" ? (
        <SettingsRow
          title="Branch prefix"
          description="Leave empty for no prefix."
          resetAction={
            settings.branchNamePrefix !== defaults.branchNamePrefix ? (
              <SettingResetButton
                label="branch prefix"
                onClick={() => save({ branchNamePrefix: defaults.branchNamePrefix })}
              />
            ) : null
          }
          control={
            <DraftInput
              className="w-full sm:w-48"
              value={settings.branchNamePrefix}
              onCommit={(next) => save({ branchNamePrefix: next.trim() })}
              placeholder="No prefix"
              spellCheck={false}
              autoCapitalize="none"
              aria-label="Branch prefix"
            />
          }
        />
      ) : null}
      {mode === "custom" ? (
        <SettingsRow
          title="Instructions"
          description="No prefix or suffix is added to the name."
          control={
            <DraftInput
              className="w-full sm:w-72"
              value={settings.branchNameInstructions}
              onCommit={(next) => save({ branchNameInstructions: next })}
              placeholder="JIRA key, then a short slug"
              aria-label="Branch naming instructions"
            />
          }
        />
      ) : null}
    </SettingsSection>
  );
}

function CopiesSection(props: { readonly environmentId: EnvironmentId }) {
  const navigate = useNavigate();
  const threads = useStore(
    useShallow((state) => selectSidebarThreadsForEnvironment(state, props.environmentId)),
  );
  const copies = useMemo(
    () => threads.filter((thread) => thread.worktreePath && thread.archivedAt === null),
    [threads],
  );
  return (
    <SettingsSection title="Chat copies on this computer">
      {copies.length === 0 ? (
        <SettingsRow title="No copies" description="Chats that work in a copy show up here." />
      ) : (
        copies.map((thread) => (
          <SettingsRow
            key={scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))}
            title={
              <button
                type="button"
                className="text-left hover:underline"
                onClick={() =>
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId: thread.environmentId, threadId: thread.id },
                  })
                }
              >
                {thread.title}
              </button>
            }
            description={
              <span className="font-mono">
                {thread.branch ? `${thread.branch} · ` : ""}
                {formatWorktreePathForDisplay(thread.worktreePath ?? "")}
              </span>
            }
          />
        ))
      )}
    </SettingsSection>
  );
}

export function WorktreesSettingsPanel(props: { readonly environmentId: EnvironmentId }) {
  return (
    <SettingsPageContainer>
      <BranchNamingSection environmentId={props.environmentId} />
      <ChatCopiesCleanupSection environmentId={props.environmentId} />
      <CopiesSection environmentId={props.environmentId} />
    </SettingsPageContainer>
  );
}
