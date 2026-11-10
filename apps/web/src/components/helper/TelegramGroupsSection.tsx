/**
 * "Groups" on the Telegram page (10.11): who the assistant listens to in each
 * Telegram group — only the owner, the people the owner picks, or everyone.
 *
 * The daemon keeps the choice per group and the list of people it has seen
 * writing there (`apps/server/src/manager/telegramGroups.ts`); a group the
 * owner called the bot in shows up here as waiting, added with one button.
 * A daemon that does not know the route yet (older computer) answers 404 and
 * the section is not shown.
 */
import { useCallback, useEffect, useState } from "react";
import { CheckIcon, UsersRoundIcon } from "lucide-react";
import type {
  EnvironmentId,
  ManagerTelegramGroupMembers,
  ManagerTelegramGroupsResult,
  ManagerTelegramGroupView,
  ProjectId,
} from "@t3tools/contracts";

import {
  isManagerApiError,
  listTelegramGroups,
  setTelegramGroupAccess,
} from "../../lib/managerApi";
import { cn } from "../../lib/utils";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { helperCopy } from "./helperCopy";
import {
  groupDisplayName,
  pickablePeople,
  selectedIds,
  togglePerson,
} from "./telegramGroups.logic";

const MEMBER_OPTIONS: ReadonlyArray<{
  readonly value: ManagerTelegramGroupMembers;
  readonly label: string;
}> = [
  { value: "owners", label: helperCopy.groups.optionOwners },
  { value: "selected", label: helperCopy.groups.optionSelected },
  { value: "anyone", label: helperCopy.groups.optionAnyone },
];

export function TelegramGroupsSection({
  environmentId,
  projectId,
  canMutate,
  chatLabels,
  reloadKey,
  onGroupAdded,
  onTitles,
  onError,
  onNotice,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly canMutate: boolean;
  /** The owner's own labels for chats (device-local), by chat id. */
  readonly chatLabels: Readonly<Record<string, string>>;
  /** Changes when the page's list of chats changes: the section reloads. */
  readonly reloadKey: string;
  /** A waiting group was added: the page reloads its list of chats. */
  readonly onGroupAdded: () => void;
  /** Telegram's names of the groups, by chat id, for the page's other lists. */
  readonly onTitles: (titles: Readonly<Record<string, string>>) => void;
  readonly onError: (message: string) => void;
  readonly onNotice: (message: string) => void;
}) {
  // null: loading, or a daemon without the route (the section stays hidden).
  const [view, setView] = useState<ManagerTelegramGroupsResult | null>(null);
  const [busyChatId, setBusyChatId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listTelegramGroups({ environmentId, projectId })
      .then((next) => {
        if (!cancelled) setView(next);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setView(null);
        // 404: this computer runs an older Uno Work. Anything else is worth a line.
        if (!(isManagerApiError(cause) && cause.status === 404)) {
          onError(cause instanceof Error ? cause.message : "Failed to load Telegram groups.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [environmentId, projectId, reloadKey, onError]);

  const change = useCallback(
    (
      target: { readonly chatId: string; readonly title: string | null },
      members: ManagerTelegramGroupMembers,
      userIds: ReadonlyArray<string> | undefined,
      added: boolean,
    ) => {
      if (!canMutate) return;
      setBusyChatId(target.chatId);
      setTelegramGroupAccess({
        environmentId,
        projectId,
        chatId: target.chatId,
        members,
        ...(userIds !== undefined ? { userIds } : {}),
      })
        .then((next) => {
          setView(next);
          const name = groupDisplayName(target, chatLabels);
          onNotice(added ? helperCopy.groups.added(name) : helperCopy.groups.saved(name));
          if (added) onGroupAdded();
        })
        .catch((cause: unknown) =>
          onError(cause instanceof Error ? cause.message : "Failed to save the group."),
        )
        .finally(() => setBusyChatId(null));
    },
    [canMutate, environmentId, projectId, chatLabels, onNotice, onGroupAdded, onError],
  );

  useEffect(() => {
    if (view === null) return;
    onTitles(
      Object.fromEntries(
        [...view.groups, ...view.pending].flatMap((group) =>
          group.title === null ? [] : [[group.chatId, group.title] as const],
        ),
      ),
    );
  }, [view, onTitles]);

  if (view === null) return null;
  const bot = view.botUsername ? `@${view.botUsername}` : "your bot";

  return (
    <SettingsSection title={helperCopy.groups.title} icon={<UsersRoundIcon className="size-3.5" />}>
      {!view.supported ? (
        <SettingsRow title={helperCopy.groups.unsupported} description="" />
      ) : view.groups.length === 0 && view.pending.length === 0 ? (
        <SettingsRow title={helperCopy.groups.intro} description={helperCopy.groups.empty(bot)} />
      ) : (
        <>
          {view.groups.map((group) => (
            <GroupRow
              key={group.chatId}
              group={group}
              name={groupDisplayName(group, chatLabels)}
              bot={bot}
              disabled={!canMutate || busyChatId === group.chatId}
              onMembers={(members) => change(group, members, undefined, false)}
              onToggle={(personId) =>
                change(group, "selected", togglePerson(group, personId), false)
              }
            />
          ))}
          {view.pending.map((group) => (
            <SettingsRow
              key={group.chatId}
              title={groupDisplayName(group, chatLabels)}
              description={helperCopy.groups.waiting}
              control={
                <Button
                  size="xs"
                  disabled={!canMutate || busyChatId === group.chatId}
                  data-testid={`telegram-group-add-${group.chatId}`}
                  onClick={() => change(group, "owners", undefined, true)}
                >
                  {helperCopy.groups.add}
                </Button>
              }
            />
          ))}
          <div className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
            {helperCopy.groups.privacyHint}
          </div>
        </>
      )}
    </SettingsSection>
  );
}

function GroupRow({
  group,
  name,
  bot,
  disabled,
  onMembers,
  onToggle,
}: {
  readonly group: ManagerTelegramGroupView;
  readonly name: string;
  readonly bot: string;
  readonly disabled: boolean;
  readonly onMembers: (members: ManagerTelegramGroupMembers) => void;
  readonly onToggle: (personId: string) => void;
}) {
  const people = pickablePeople(group);
  const picked = selectedIds(group);
  return (
    <div
      className="border-t border-border/60 px-4 py-4 first:border-t-0 sm:px-5"
      data-testid={`telegram-group-${group.chatId}`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="min-w-0 truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">
          {name}
        </h3>
        <ToggleGroup
          variant="outline"
          size="xs"
          value={[group.members]}
          disabled={disabled}
          aria-label={`Who Uno listens to in ${name}`}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "owners" || next === "selected" || next === "anyone") onMembers(next);
          }}
        >
          {MEMBER_OPTIONS.map((option) => (
            <Toggle
              key={option.value}
              value={option.value}
              className="px-2.5 text-xs"
              data-testid={`telegram-group-${group.chatId}-${option.value}`}
            >
              {option.label}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
      {group.members === "selected" ? (
        people.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">{helperCopy.groups.nobodyYet(bot)}</p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="People">
            {people.map((person) => {
              const on = picked.includes(person.id);
              return (
                <button
                  key={person.id}
                  type="button"
                  aria-pressed={on}
                  disabled={disabled}
                  title={person.username ? `@${person.username}` : person.id}
                  data-testid={`telegram-group-${group.chatId}-person-${person.id}`}
                  onClick={() => onToggle(person.id)}
                  className={cn(
                    "inline-flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors disabled:cursor-default disabled:opacity-60",
                    on
                      ? "border-primary/50 bg-primary/10 text-foreground"
                      : "border-border/70 text-muted-foreground hover:bg-accent/40",
                  )}
                >
                  {on ? <CheckIcon className="size-3" /> : null}
                  {person.name}
                </button>
              );
            })}
          </div>
        )
      ) : null}
      {group.members === "anyone" || (group.members === "selected" && picked.length > 0) ? (
        <p className="mt-2 text-xs text-muted-foreground">{helperCopy.groups.othersNote}</p>
      ) : null}
    </div>
  );
}
