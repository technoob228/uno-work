/**
 * "Groups" on the Telegram page (10.11): who the assistant listens to in each
 * Telegram group — only the owner, the people the owner picks, or everyone.
 *
 * The daemon keeps the choice per group and the list of people it has seen
 * writing there (`apps/server/src/manager/telegramGroups.ts`); a group the
 * owner called the bot in shows up here as waiting, added with one button.
 * A daemon that does not know the route yet (older computer) answers 404 and
 * the section is not shown.
 *
 * Through Uno's assistant bot groups work when the console has them on for
 * the account (T57, 20.11); otherwise the section says so plainly and offers
 * the assistant's own bot — the page's Connect Telegram token field. With
 * Uno's bot a group the owner added the bot to is listed at once, and each
 * group has "Hear everything" (Misha 23.11): the console then passes the
 * group's other messages too, once Telegram sends them (`readsAll`).
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
import { Switch } from "../ui/switch";
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
  onConnectOwnBot,
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
  /** Open the page's own-bot connect flow (token field + how to get one). */
  readonly onConnectOwnBot: () => void;
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
      hearAll?: boolean,
    ) => {
      if (!canMutate) return;
      setBusyChatId(target.chatId);
      setTelegramGroupAccess({
        environmentId,
        projectId,
        chatId: target.chatId,
        members,
        ...(userIds !== undefined ? { userIds } : {}),
        ...(hearAll !== undefined ? { hearAll } : {}),
      })
        .then((next) => {
          setView(next);
          const name = groupDisplayName(target, chatLabels);
          onNotice(
            added
              ? helperCopy.groups.added(name)
              : hearAll === true
                ? helperCopy.groups.hearAllOn(name)
                : hearAll === false
                  ? helperCopy.groups.hearAllOff(name)
                  : helperCopy.groups.saved(name),
          );
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
        <div
          className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5"
          data-testid="telegram-groups-unsupported"
        >
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <UsersRoundIcon className="size-4" />
            </span>
            <div className="min-w-0 space-y-1">
              <h3 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">
                {helperCopy.groups.unsupportedTitle}
              </h3>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {helperCopy.groups.unsupportedBody}
              </p>
            </div>
          </div>
          <Button
            size="sm"
            className="shrink-0 self-start sm:self-center"
            disabled={!canMutate}
            data-testid="telegram-groups-connect-own-bot"
            onClick={onConnectOwnBot}
          >
            {helperCopy.groups.connectOwnBot}
          </Button>
        </div>
      ) : view.groups.length === 0 && view.pending.length === 0 ? (
        <>
          <SettingsRow
            title={helperCopy.groups.intro}
            description={
              view.bot === "shared"
                ? helperCopy.groups.sharedEmpty(bot)
                : helperCopy.groups.empty(bot)
            }
          />
          {view.bot === "shared" ? (
            <div className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
              {helperCopy.groups.sharedHint(bot)}
            </div>
          ) : null}
        </>
      ) : (
        <>
          {view.groups.map((group) => (
            <GroupRow
              key={group.chatId}
              group={group}
              name={groupDisplayName(group, chatLabels)}
              bot={bot}
              disabled={!canMutate || busyChatId === group.chatId}
              shared={view.bot === "shared"}
              readsAll={view.readsAll}
              onMembers={(members) => change(group, members, undefined, false)}
              onHearAll={(on) => change(group, group.members, undefined, false, on)}
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
            {view.bot === "shared"
              ? helperCopy.groups.sharedHint(bot)
              : helperCopy.groups.privacyHint}
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
  shared,
  readsAll,
  onMembers,
  onHearAll,
  onToggle,
}: {
  readonly group: ManagerTelegramGroupView;
  readonly name: string;
  readonly bot: string;
  readonly disabled: boolean;
  /** Uno's bot: the group has "Hear everything". */
  readonly shared: boolean;
  /** Telegram gives Uno's bot whole groups; undefined — not known. */
  readonly readsAll: boolean | undefined;
  readonly onMembers: (members: ManagerTelegramGroupMembers) => void;
  readonly onHearAll: (on: boolean) => void;
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
      {shared ? (
        <div className="mt-3 flex items-start justify-between gap-4 rounded-lg bg-muted/40 px-3 py-2.5">
          <div className="min-w-0 space-y-0.5">
            <p className="text-xs font-medium text-foreground">{helperCopy.groups.hearAll}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {helperCopy.groups.hearAllBody(bot)}
            </p>
            {readsAll === false && group.hearAll === true ? (
              <p
                className="text-xs leading-relaxed text-muted-foreground"
                data-testid={`telegram-group-${group.chatId}-hear-all-waiting`}
              >
                {helperCopy.groups.hearAllWaiting}
              </p>
            ) : null}
          </div>
          <Switch
            checked={group.hearAll === true}
            disabled={disabled}
            aria-label={`${helperCopy.groups.hearAll}: ${name}`}
            data-testid={`telegram-group-${group.chatId}-hear-all`}
            onCheckedChange={(on) => onHearAll(on)}
          />
        </div>
      ) : null}
    </div>
  );
}
