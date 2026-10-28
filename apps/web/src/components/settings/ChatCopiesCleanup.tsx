/**
 * Settings → Computer → "Chat copies": the daemon cleans the separate copies
 * chats work in (git worktrees) by itself. One quiet line says so; the rules,
 * "Clean up now" and the last report sit under a collapsed Advanced.
 *
 * Shown only when the daemon advertises `worktreeCleanup`.
 */
import type {
  EnvironmentId,
  ServerSettingsPatch,
  StorageCleanupSettings,
  StorageCleanupStatus,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { ensureEnvironmentApi } from "../../environmentApi";
import {
  useEnvironmentSettings,
  useUpdateEnvironmentSettings,
} from "../../environments/settings/serverSettings";
import { useEnvironmentSupportsWorktreeCleanup } from "../../environments/worktreeCleanupSupport";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  IDLE_DAY_CHOICES,
  SETTLED_DAY_CHOICES,
  cleanupSummaryLine,
  dayChoiceLabel,
  decodeDayChoice,
  encodeDayChoice,
  reportEntryLine,
  reportHeadline,
  withCurrentChoice,
} from "./chatCopiesCleanup.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const REPORT_LINES_SHOWN = 12;
const STATUS_REFETCH_MS = 5 * 60_000;

const statusQueryKey = (environmentId: EnvironmentId) =>
  ["uno-computer", "worktree-cleanup", environmentId] as const;

function DaysSelect({
  label,
  value,
  choices,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: number | null;
  readonly choices: ReadonlyArray<number | null>;
  readonly disabled: boolean;
  readonly onChange: (days: number | null) => void;
}) {
  return (
    <Select
      value={encodeDayChoice(value)}
      disabled={disabled}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(decodeDayChoice(next));
      }}
    >
      <SelectTrigger className="w-full sm:w-40" aria-label={label}>
        <SelectValue>{dayChoiceLabel(value)}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {withCurrentChoice(choices, value).map((choice) => (
          <SelectItem key={encodeDayChoice(choice)} hideIndicator value={encodeDayChoice(choice)}>
            {dayChoiceLabel(choice)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function ChatCopiesCleanupSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  const supported = useEnvironmentSupportsWorktreeCleanup(environmentId);
  if (!supported || environmentId === null) return null;
  return <ChatCopiesCleanup environmentId={environmentId} />;
}

function ChatCopiesCleanup({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const serverSettings = useEnvironmentSettings(environmentId);
  const { updateSettings, mutationBlockedReason } = useUpdateEnvironmentSettings(environmentId);
  const settings: StorageCleanupSettings =
    serverSettings?.storageCleanup ?? DEFAULT_SERVER_SETTINGS.storageCleanup;
  const status = useQuery({
    queryKey: statusQueryKey(environmentId),
    queryFn: () => ensureEnvironmentApi(environmentId).unoComputer.worktreeCleanupStatus(),
    refetchInterval: STATUS_REFETCH_MS,
  });
  const runNow = useMutation({
    mutationKey: ["uno-computer", "worktree-cleanup-run", environmentId] as const,
    mutationFn: () => ensureEnvironmentApi(environmentId).unoComputer.worktreeCleanupRun(),
    onSuccess: (next: StorageCleanupStatus) => {
      queryClient.setQueryData(statusQueryKey(environmentId), next);
      void queryClient.invalidateQueries({ queryKey: ["uno-computer", "disk", environmentId] });
    },
    onError: (error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Couldn't clean up chat copies",
        description: error instanceof Error ? error.message : String(error),
      }),
  });
  const report = status.data?.report ?? null;
  const saving = mutationBlockedReason !== null;
  const save = (patch: NonNullable<ServerSettingsPatch["storageCleanup"]>) => {
    void updateSettings({ storageCleanup: patch }).catch((error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Couldn't save the cleanup setting",
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };
  const shown = report?.entries.slice(0, REPORT_LINES_SHOWN) ?? [];
  const more = report === null ? 0 : report.entries.length - shown.length + report.omittedCount;

  return (
    <SettingsSection title="Chat copies">
      <SettingsRow
        title="Cleaned up automatically"
        description={cleanupSummaryLine(settings, report)}
      />
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          className="group flex w-full items-center justify-between gap-3 border-t border-border/60 px-4 py-3 text-left text-[13px] font-semibold text-foreground transition-colors hover:bg-muted/40 sm:px-5"
          aria-label={open ? "Hide advanced cleanup settings" : "Show advanced cleanup settings"}
        >
          Advanced
          <ChevronDownIcon
            className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <SettingsRow
            title="When a chat is deleted"
            description="Remove its copy right away."
            control={
              <Switch
                checked={settings.worktreeOnDelete}
                disabled={saving}
                onCheckedChange={(checked) => save({ worktreeOnDelete: Boolean(checked) })}
                aria-label="Remove the copy when a chat is deleted"
              />
            }
          />
          <SettingsRow
            title="Done or archived chats"
            description="Remove the copy once the chat has been quiet this long."
            control={
              <DaysSelect
                label="Done or archived chats"
                value={settings.worktreeSettledAfterDays}
                choices={SETTLED_DAY_CHOICES}
                disabled={saving}
                onChange={(days) => save({ worktreeSettledAfterDays: days })}
              />
            }
          />
          <SettingsRow
            title="Any chat not used"
            description="A safety net for chats nobody finished."
            control={
              <DaysSelect
                label="Any chat not used"
                value={settings.worktreeAfterDays}
                choices={IDLE_DAY_CHOICES}
                disabled={saving}
                onChange={(days) => save({ worktreeAfterDays: days === 0 ? 1 : days })}
              />
            }
          />
          <SettingsRow
            title="Sooner when the disk is nearly full"
            description="Under 15% or 3 GB free: Done, archived and deleted chats right away, others after 3 days."
            control={
              <Switch
                checked={settings.worktreeLowDisk}
                disabled={saving}
                onCheckedChange={(checked) => save({ worktreeLowDisk: Boolean(checked) })}
                aria-label="Clean sooner when the disk is nearly full"
              />
            }
          />
          <SettingsRow
            title="Save changes first"
            description="Unsaved changes and .env files are kept and come back with the chat's next message. Off: copies with changes stay."
            control={
              <Switch
                checked={settings.worktreeSaveChanges}
                disabled={saving}
                onCheckedChange={(checked) => save({ worktreeSaveChanges: Boolean(checked) })}
                aria-label="Save changes before removing a copy"
              />
            }
          />
          <SettingsRow
            title="Clean up now"
            description={
              report === null
                ? "No cleanup has run since this computer started."
                : reportHeadline(report)
            }
            control={
              <Button
                size="sm"
                variant="outline"
                disabled={runNow.isPending || status.data?.running === true}
                onClick={() => runNow.mutate()}
              >
                {runNow.isPending ? "Cleaning…" : "Clean up now"}
              </Button>
            }
          >
            {shown.length > 0 ? (
              <ul className="space-y-1 pb-4 text-xs leading-relaxed text-muted-foreground">
                {shown.map((entry, index) => (
                  <li key={`${entry.path ?? "none"}-${index}`} className="break-words">
                    <span
                      className={
                        entry.outcome === "removed"
                          ? "text-foreground"
                          : entry.outcome === "failed"
                            ? "text-destructive"
                            : undefined
                      }
                    >
                      {entry.outcome === "removed"
                        ? "Removed"
                        : entry.outcome === "failed"
                          ? "Couldn't remove"
                          : "Kept"}
                    </span>
                    {" · "}
                    {reportEntryLine(entry)}
                  </li>
                ))}
                {more > 0 ? <li>And {more} more.</li> : null}
              </ul>
            ) : null}
          </SettingsRow>
        </CollapsiblePanel>
      </Collapsible>
    </SettingsSection>
  );
}
