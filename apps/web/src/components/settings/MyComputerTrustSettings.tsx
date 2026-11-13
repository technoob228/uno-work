/**
 * Settings → My computer: what agents may do on the person's own computers
 * without asking. The daemon decides each call's tier in code (free, one Allow
 * per chat, asks, always asks, blocked); here the person sets the folders and
 * commands behind the first two, how long a chat's Allow lasts and when agents
 * pause, revokes chats' Allows, stops everything, and reads the journal.
 *
 * Every change saves at once: `setTrust` takes the whole settings object.
 */
import type {
  EnvironmentId,
  MyComputer,
  MyComputerChatGrant,
  MyComputerTrustSettings as TrustSettings,
  MyComputerTrustState,
} from "@t3tools/contracts";
import { LaptopIcon, OctagonXIcon, PauseCircleIcon, PlayIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useSettings } from "../../hooks/useSettings";
import { localComputer } from "../../localComputer/localComputerStore";
import {
  myComputerErrorText,
  STATUS_POLL_SCREEN_MS,
  TRUST_POLL_MS,
  useMyComputers,
  useMyComputerTrust,
  useMyComputerTrustActions,
} from "../../localComputer/useMyComputers";
import { formatElapsedAgoLabel, formatShortTimestamp } from "../../timestampFormat";
import { MyComputerJournal } from "../localComputer/MyComputerJournal";
import {
  addToList,
  computersLabel,
  GRANT_HOURS,
  grantUntilLabel,
  IDLE_HOURS,
  parseHours,
  pauseLine,
  sameList,
} from "../localComputer/myComputerTrust.logic";
import { StopAllAgentsDialog } from "../localComputer/StopAllAgents";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

const JOURNAL_LIMIT = 100;

function useSave(environmentId: EnvironmentId | null, settings: TrustSettings | undefined) {
  const { setTrust } = useMyComputerTrustActions(environmentId);
  return (patch: Partial<TrustSettings>) => {
    if (settings === undefined) return;
    setTrust({ ...settings, ...patch }).catch((cause: unknown) =>
      toastManager.add({
        type: "error",
        title: "Couldn’t save",
        description: myComputerErrorText(cause),
      }),
    );
  };
}

// ── Status ─────────────────────────────────────────────────────────────

function activityDescription(trust: MyComputerTrustState, nowMs: number): string {
  if (trust.running > 0) {
    return `${trust.running} ${trust.running === 1 ? "call is" : "calls are"} running now.`;
  }
  if (trust.lastActivityAt !== null && !Number.isNaN(Date.parse(trust.lastActivityAt))) {
    return `Last agent activity ${formatElapsedAgoLabel(trust.lastActivityAt, nowMs)}.`;
  }
  return "No agent activity yet.";
}

function StatusSection({
  environmentId,
  computers,
  trust,
  nowMs,
}: {
  environmentId: EnvironmentId | null;
  computers: ReadonlyArray<MyComputer>;
  trust: MyComputerTrustState | undefined;
  nowMs: number;
}) {
  const { resume } = useMyComputerTrustActions(environmentId);
  const [resuming, setResuming] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const onResume = async () => {
    setResuming(true);
    try {
      await resume();
      toastManager.add({ type: "success", title: "Agents can use your computer again" });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Couldn’t resume",
        description: myComputerErrorText(cause),
      });
    } finally {
      setResuming(false);
    }
  };
  const label = computersLabel(computers);
  return (
    <SettingsSection title="Status" icon={<LaptopIcon className="size-3" />}>
      {trust?.paused ? (
        <div
          className="flex flex-col gap-3 border-b border-warning/20 bg-warning/8 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5"
          role="status"
          data-testid="my-computer-paused"
        >
          <div className="flex min-w-0 items-start gap-2.5">
            <PauseCircleIcon className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="min-w-0 space-y-0.5">
              <p className="text-[13px] font-semibold text-foreground">Agents are paused</p>
              <p className="text-xs text-muted-foreground">
                {pauseLine(trust.paused, trust.settings.idleHours)} They can’t reach {label} until
                you resume.
              </p>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={resuming}
            onClick={() => void onResume()}
            data-testid="my-computer-resume"
          >
            <PlayIcon />
            {resuming ? "Resuming…" : "Resume"}
          </Button>
        </div>
      ) : null}
      {computers.length === 0 ? (
        <SettingsRow
          title="No computer connected"
          description="Connect your own computer and agents can use it. These rules apply once it’s connected."
          control={
            <Button size="xs" variant="outline" onClick={localComputer.openConnect}>
              Connect computer
            </Button>
          }
        />
      ) : trust !== undefined && trust.paused === null ? (
        <SettingsRow
          title={`Agents can use ${label}`}
          description={activityDescription(trust, nowMs)}
        />
      ) : null}
      <SettingsRow
        title="Stop all agents on my computer"
        description="Stops everything agents run there and disconnects it. Agents stay paused until you resume."
        control={
          <Button
            size="xs"
            variant="destructive-outline"
            onClick={() => setStopOpen(true)}
            data-testid="my-computer-stop-all"
          >
            <OctagonXIcon className="size-3.5" />
            Stop all agents
          </Button>
        }
      />
      <StopAllAgentsDialog open={stopOpen} onOpenChange={setStopOpen} />
    </SettingsSection>
  );
}

// ── Allowed folders and commands ──────────────────────────────────────

function EditableList({
  items,
  placeholder,
  addLabel,
  emptyText,
  onChange,
  testId,
}: {
  items: ReadonlyArray<string>;
  placeholder: string;
  addLabel: string;
  emptyText: string;
  onChange: (next: ReadonlyArray<string>) => void;
  testId: string;
}) {
  const [draft, setDraft] = useState("");
  const next = addToList(items, draft);
  const add = () => {
    if (next === null) return;
    onChange(next);
    setDraft("");
  };
  return (
    <div className="border-t border-border/60 px-4 py-3 first:border-t-0 sm:px-5">
      {items.length === 0 ? (
        <p className="py-1 text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="flex flex-col" data-testid={testId}>
          {items.map((item) => (
            <li key={item} className="group flex min-h-8 items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-xs" title={item}>
                {item}
              </code>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove ${item}`}
                className="text-muted-foreground hover:text-foreground"
                onClick={() => onChange(items.filter((one) => one !== item))}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-2 flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <Input
          size="sm"
          value={draft}
          placeholder={placeholder}
          aria-label={addLabel}
          className="font-mono text-xs"
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" size="xs" variant="outline" disabled={next === null}>
          <PlusIcon />
          Add
        </Button>
      </form>
    </div>
  );
}

function ListSection({
  title,
  helper,
  items,
  defaults,
  placeholder,
  addLabel,
  emptyText,
  onChange,
  testId,
}: {
  title: string;
  helper: string;
  items: ReadonlyArray<string>;
  defaults: ReadonlyArray<string>;
  placeholder: string;
  addLabel: string;
  emptyText: string;
  onChange: (next: ReadonlyArray<string>) => void;
  testId: string;
}) {
  return (
    <SettingsSection
      title={title}
      headerAction={
        sameList(items, defaults) ? null : (
          <Button
            size="xs"
            variant="ghost"
            className="h-5 px-1.5 text-[11px] text-muted-foreground"
            onClick={() => onChange(defaults)}
          >
            Reset to defaults
          </Button>
        )
      }
    >
      <div className="px-4 pt-3 sm:px-5">
        <p className="text-xs leading-relaxed text-muted-foreground/80">{helper}</p>
      </div>
      <EditableList
        items={items}
        placeholder={placeholder}
        addLabel={addLabel}
        emptyText={emptyText}
        onChange={onChange}
        testId={testId}
      />
    </SettingsSection>
  );
}

// ── Hours ───────────────────────────────────────────────────────────────

function HoursInput({
  value,
  bounds,
  label,
  onCommit,
}: {
  value: number;
  bounds: { readonly min: number; readonly max: number };
  label: string;
  onCommit: (hours: number) => void;
}) {
  const [text, setText] = useState(String(value));
  // A save or a poll brought another value: show it, unless it's being typed.
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(String(value));
  }, [editing, value]);
  const commit = () => {
    setEditing(false);
    const hours = parseHours(text, bounds);
    if (hours === null) {
      setText(String(value));
      return;
    }
    setText(String(hours));
    if (hours !== value) onCommit(hours);
  };
  return (
    <span className="flex items-center gap-1.5">
      <Input
        size="sm"
        type="number"
        inputMode="numeric"
        min={bounds.min}
        max={bounds.max}
        value={text}
        aria-label={label}
        className="w-16 tabular-nums"
        onFocus={() => setEditing(true)}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <span className="text-xs text-muted-foreground">h</span>
    </span>
  );
}

function HoursSection({
  settings,
  defaults,
  save,
}: {
  settings: TrustSettings;
  defaults: TrustSettings;
  save: (patch: Partial<TrustSettings>) => void;
}) {
  const reset = (key: "grantHours" | "idleHours", label: string): ReactNode =>
    settings[key] === defaults[key] ? null : (
      <SettingResetButton label={label} onClick={() => save({ [key]: defaults[key] })} />
    );
  return (
    <SettingsSection title="Timing">
      <SettingsRow
        title="One Allow lasts"
        description={`How long a chat may write in your folders and run your commands after you allow it once. ${GRANT_HOURS.min}–${GRANT_HOURS.max} h.`}
        resetAction={reset("grantHours", "One Allow lasts")}
        control={
          <HoursInput
            value={settings.grantHours}
            bounds={GRANT_HOURS}
            label="One Allow lasts, hours"
            onCommit={(grantHours) => save({ grantHours })}
          />
        }
      />
      <SettingsRow
        title="Pause agents after"
        description={`With no agent activity for this long, agents lose access until you resume. ${IDLE_HOURS.min}–${IDLE_HOURS.max} h.`}
        resetAction={reset("idleHours", "Pause agents after")}
        control={
          <HoursInput
            value={settings.idleHours}
            bounds={IDLE_HOURS}
            label="Pause agents after, hours idle"
            onCommit={(idleHours) => save({ idleHours })}
          />
        }
      />
    </SettingsSection>
  );
}

// ── Chat permissions ───────────────────────────────────────────────────

function GrantRow({
  grant,
  computerName,
  until,
  onRevoke,
}: {
  grant: MyComputerChatGrant;
  computerName: string;
  until: string;
  onRevoke: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  return (
    <SettingsRow
      title={grant.threadTitle.trim() || "Untitled chat"}
      description={[computerName, until].filter(Boolean).join(" · ")}
      control={
        <Button
          size="xs"
          variant="outline"
          disabled={pending}
          data-testid="my-computer-revoke"
          onClick={() => {
            setPending(true);
            void onRevoke().finally(() => setPending(false));
          }}
        >
          {pending ? "Revoking…" : "Revoke"}
        </Button>
      }
    />
  );
}

function GrantsSection({
  environmentId,
  grants,
  computers,
  nowMs,
}: {
  environmentId: EnvironmentId | null;
  grants: ReadonlyArray<MyComputerChatGrant>;
  computers: ReadonlyArray<MyComputer>;
  nowMs: number;
}) {
  const { revokeGrant } = useMyComputerTrustActions(environmentId);
  const timestampFormat = useSettings((settings) => settings.timestampFormat);
  const formatTime = (iso: string) => formatShortTimestamp(iso, timestampFormat);
  const nameOf = (computerId: string) =>
    computers.find((one) => one.id === computerId)?.name ?? "A computer that’s gone";
  return (
    <SettingsSection title="Chat permissions">
      {grants.length === 0 ? (
        <SettingsRow
          title="No chat has a standing Allow."
          description="When you allow a chat once, it shows here until its Allow runs out."
        />
      ) : (
        grants.map((grant) => (
          <GrantRow
            key={`${grant.threadId}:${grant.computerId}`}
            grant={grant}
            computerName={nameOf(grant.computerId)}
            until={grantUntilLabel(grant.expiresAt, nowMs, formatTime)}
            onRevoke={async () => {
              try {
                await revokeGrant({ threadId: grant.threadId, computerId: grant.computerId });
              } catch (cause) {
                toastManager.add({
                  type: "error",
                  title: "Couldn’t revoke",
                  description: myComputerErrorText(cause),
                });
              }
            }}
          />
        ))
      )}
    </SettingsSection>
  );
}

// ── Journal ─────────────────────────────────────────────────────────────

function JournalSection({
  environmentId,
  computer,
  titled,
}: {
  environmentId: EnvironmentId | null;
  computer: MyComputer;
  titled: boolean;
}) {
  return (
    <SettingsSection title={titled ? `Journal · ${computer.name}` : "Journal"}>
      <div className="px-4 py-4 sm:px-5">
        <MyComputerJournal
          environmentId={environmentId}
          computerId={computer.id}
          limit={JOURNAL_LIMIT}
          showChat
          className="max-h-[28rem]"
          testId="my-computer-journal"
        />
      </div>
    </SettingsSection>
  );
}

// ── The page ────────────────────────────────────────────────────────────

export function MyComputerTrustSettings() {
  const environmentId = usePrimaryEnvironmentId();
  const { computers, settled } = useMyComputers(environmentId, {
    pollMs: STATUS_POLL_SCREEN_MS,
  });
  const trust = useMyComputerTrust(environmentId, { pollMs: TRUST_POLL_MS });
  const state = trust.data;
  const save = useSave(environmentId, state?.settings);
  const nowMs = trust.dataUpdatedAt || Date.now();

  return (
    <SettingsPageContainer>
      {settled ? (
        <StatusSection
          environmentId={environmentId}
          computers={computers}
          trust={state}
          nowMs={nowMs}
        />
      ) : null}
      {state === undefined ? (
        trust.isError ? (
          <SettingsSection title="Agent permissions">
            <SettingsRow
              title="Couldn’t load agent permissions"
              description={myComputerErrorText(trust.error)}
              control={
                <Button size="xs" variant="outline" onClick={() => void trust.refetch()}>
                  Try again
                </Button>
              }
            />
          </SettingsSection>
        ) : null
      ) : (
        <>
          <ListSection
            title="Allowed folders"
            helper="Agents read here without asking, and write after one Allow per chat."
            items={state.settings.allowedFolders}
            defaults={state.defaults.allowedFolders}
            placeholder="~/projects"
            addLabel="Add a folder"
            emptyText="No folders yet."
            onChange={(allowedFolders) => save({ allowedFolders: [...allowedFolders] })}
            testId="my-computer-folders"
          />
          <ListSection
            title="Allowed commands"
            helper="Run after one Allow per chat. A command counts when it starts with one of these."
            items={state.settings.allowedCommands}
            defaults={state.defaults.allowedCommands}
            placeholder="bun run dev"
            addLabel="Add a command"
            emptyText="No commands yet."
            onChange={(allowedCommands) => save({ allowedCommands: [...allowedCommands] })}
            testId="my-computer-commands"
          />
          <HoursSection settings={state.settings} defaults={state.defaults} save={save} />
          <GrantsSection
            environmentId={environmentId}
            grants={state.grants}
            computers={computers}
            nowMs={nowMs}
          />
        </>
      )}
      {computers.map((computer) => (
        <JournalSection
          key={computer.id}
          environmentId={environmentId}
          computer={computer}
          titled={computers.length > 1}
        />
      ))}
    </SettingsPageContainer>
  );
}
