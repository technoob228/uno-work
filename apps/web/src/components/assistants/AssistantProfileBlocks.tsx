/**
 * The assistant's page, v2 (Misha 22.10: "role, tasks, access, name,
 * connectors, its own mail, its computer — all at once, very simple"): the
 * blocks that edit who it is, what is always on it, its own email and where
 * it works, in place, on what its computer keeps (`team.json`, its mailbox,
 * the person's computers). The prototype's look: a titled card of rows.
 *
 * Its setup chat asks the same things (`ASSISTANT_SETUP_STEPS`), so the page
 * and the chat edit one record.
 */
import { ASSISTANT_MAIL_DAILY_MAX, type EnvironmentId } from "@t3tools/contracts";
import { mailPolicyLine } from "@t3tools/shared/assistantMail";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  CheckIcon,
  CloudIcon,
  CopyIcon,
  LaptopIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  MonitorIcon,
  PencilIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { useMachineRows } from "../../hooks/useMachineRows";
import {
  createAssistant,
  deleteLocalAssistant,
  getAssistantApps,
  getAssistantMail,
  listProjectsForAccessPicker,
  putAssistantApps,
  readAssistantFile,
  updateAssistantTeam,
  writeAssistantFile,
} from "../../lib/managerApi";
import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { AssistantAvatar } from "./AssistantAvatar";
import {
  DUTY_EXAMPLES,
  editDuties,
  MAIL_RECIPIENT_CHOICES,
  parseAddresses,
  parseDailyLimit,
  type WorksOnOption,
  worksOnOptions,
  worksOnWishLine,
} from "./assistantPage.logic";
import { AVATARS, type AvatarTone } from "./assistantTeam.logic";
import { moveAssistantToComputer } from "./moveAssistant";
import type { TeamMember } from "./useAssistantTeam";
import { ASSISTANT_COMPUTERS_KEY } from "./useAssistants";
import { useTeamActions } from "./useTeamActions";

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/** Saves one change of its team record, with a toast either way. */
function useTeamSave(member: TeamMember) {
  const actions = useTeamActions();
  const [saving, setSaving] = useState(false);
  const save = async (
    input: Parameters<ReturnType<typeof useTeamActions>["update"]>[1],
    done: string,
  ): Promise<boolean> => {
    setSaving(true);
    try {
      await actions.update(member, input);
      toastManager.add({ type: "success", title: done, description: "From its next step." });
      return true;
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Couldn't save it",
        description: errorText(cause, "Its computer didn't answer."),
      });
      return false;
    } finally {
      setSaving(false);
    }
  };
  return { save, saving };
}

function FieldRow(props: {
  readonly label: string;
  readonly children: ReactNode;
  readonly last?: boolean;
  readonly testId?: string;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[7.5rem_1fr] items-start gap-3 px-3 py-2 text-sm",
        !props.last && "border-b border-border/70",
      )}
      data-testid={props.testId}
    >
      <span className="pt-1 text-xs text-muted-foreground">{props.label}</span>
      <div className="min-w-0">{props.children}</div>
    </div>
  );
}

function Chip(props: {
  readonly selected: boolean;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly children: ReactNode;
  readonly testId?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected}
      disabled={props.disabled}
      onClick={props.onClick}
      data-testid={props.testId}
      className={cn(
        "h-6 cursor-pointer rounded-md border px-2 text-xs transition-colors disabled:cursor-default disabled:opacity-60",
        props.selected
          ? "border-primary/50 bg-primary/10 text-foreground"
          : "border-border text-muted-foreground hover:bg-accent",
      )}
    >
      {props.children}
    </button>
  );
}

// ── Who it is ─────────────────────────────────────────────────────────────

/** Name, face, role and character, edited in place of the page's header lines. */
export function TeamWhoEditor(props: {
  readonly member: TeamMember;
  readonly onClose: () => void;
  /** The face row (off where the face picker edits it: `AssistantFacePicker.tsx`). */
  readonly withFace?: boolean;
}) {
  const withFace = props.withFace ?? true;
  const { member } = props;
  const { profile } = member;
  const { save, saving } = useTeamSave(member);
  const [name, setName] = useState(profile.name);
  const [emoji, setEmoji] = useState(profile.emoji ?? "");
  const [tone, setTone] = useState<AvatarTone>(profile.tone);
  const [roles, setRoles] = useState(profile.roles.join(", "));
  const [character, setCharacter] = useState(profile.character);

  const submit = async () => {
    const roleList = roles
      .split(",")
      .map((role) => role.trim())
      .filter((role) => role.length > 0)
      .slice(0, 8)
      .map((role) => role.slice(0, 60));
    const saved = await save(
      {
        ...(member.isUno || name.trim().length === 0 || name.trim() === profile.name
          ? {}
          : { name: name.trim().slice(0, 60) }),
        ...(member.isUno || !withFace
          ? {}
          : { emoji: emoji.trim().length > 0 ? emoji.trim().slice(0, 16) : null, tone }),
        roles: roleList,
        character: character.trim().slice(0, 200),
      },
      `${name.trim() || profile.name} is saved`,
    );
    if (saved) props.onClose();
  };

  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-border bg-card/40 p-3"
      data-testid="assistant-profile-who-editor"
    >
      {member.isUno || !withFace ? null : (
        <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Face">
          {AVATARS.map((avatar) => (
            <button
              key={avatar.emoji}
              type="button"
              role="radio"
              aria-checked={emoji === avatar.emoji}
              onClick={() => {
                setEmoji(avatar.emoji);
                setTone(avatar.tone);
              }}
              className={cn(
                "cursor-pointer rounded-full p-0.5 ring-offset-1",
                emoji === avatar.emoji && "ring-2 ring-primary/60",
              )}
            >
              <AssistantAvatar
                emoji={avatar.emoji}
                tone={avatar.tone}
                className="size-7"
                emojiClassName="text-sm"
              />
            </button>
          ))}
          <Input
            size="sm"
            value={emoji}
            onChange={(event) => setEmoji(event.target.value)}
            placeholder="Any emoji"
            aria-label="Its emoji"
            className="w-24"
          />
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Name
          <Input
            size="sm"
            value={name}
            disabled={member.isUno}
            onChange={(event) => setName(event.target.value)}
            data-testid="assistant-profile-who-name"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Role
          <Input
            size="sm"
            value={roles}
            placeholder="Dev, Sales…"
            onChange={(event) => setRoles(event.target.value)}
            data-testid="assistant-profile-who-role"
          />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        How it talks
        <Input
          size="sm"
          value={character}
          placeholder="Calm and brief"
          onChange={(event) => setCharacter(event.target.value)}
          data-testid="assistant-profile-who-character"
        />
      </label>
      {member.isUno ? (
        <p className="text-xs text-muted-foreground">
          Uno keeps its name and face on every computer.
        </p>
      ) : null}
      <div className="flex items-center gap-1.5">
        <Button size="xs" onClick={() => void submit()} disabled={saving}>
          {saving ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}
          Save
        </Button>
        <Button size="xs" variant="ghost" disabled={saving} onClick={props.onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ── Always on it (duties) ─────────────────────────────────────────────────

function DutyLine(props: {
  readonly text: string;
  readonly disabled: boolean;
  readonly onSave: (text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.text);
  if (editing) {
    return (
      <div className="flex items-center gap-1.5 border-t border-border/70 px-3 py-1.5 first:border-t-0">
        <Input
          size="sm"
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              props.onSave(draft);
              setEditing(false);
            }
            if (event.key === "Escape") {
              setDraft(props.text);
              setEditing(false);
            }
          }}
        />
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Save"
          onClick={() => {
            props.onSave(draft);
            setEditing(false);
          }}
        >
          <CheckIcon className="size-3.5" />
        </Button>
      </div>
    );
  }
  return (
    <div
      className="group flex min-h-8 items-center gap-2 border-t border-border/70 px-3 text-sm first:border-t-0"
      data-testid="assistant-profile-duty"
    >
      <ListChecksIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{props.text}</span>
      {props.disabled ? null : (
        <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <Button size="icon-xs" variant="ghost" aria-label="Edit" onClick={() => setEditing(true)}>
            <PencilIcon className="size-3" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Remove"
            onClick={() => props.onSave("")}
          >
            <XIcon className="size-3" />
          </Button>
        </span>
      )}
    </div>
  );
}

/** What it is always responsible for: lines it reads in its context, edited here. */
export function TeamDuties(props: { readonly member: TeamMember }) {
  const { member } = props;
  const { save, saving } = useTeamSave(member);
  const saved = member.summary?.team?.team.duties ?? [];
  const [shown, setShown] = useState<ReadonlyArray<string> | null>(null);
  const duties = shown ?? saved;
  const [adding, setAdding] = useState("");

  const change = async (index: number | null, text: string) => {
    const next = editDuties(duties, index, text);
    setShown(next);
    await save(
      { duties: [...next] },
      index === null ? "Duty added" : text.trim() ? "Duty changed" : "Duty removed",
    );
    setShown(null);
  };

  return (
    <div data-testid="assistant-profile-duties">
      <p className="px-3 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Always on it
      </p>
      {duties.map((duty, index) => (
        <DutyLine
          key={duty}
          text={duty}
          disabled={member.revoked || saving}
          onSave={(text) => void change(index, text)}
        />
      ))}
      {member.revoked ? null : (
        <form
          className="flex items-center gap-1.5 border-t border-border/70 px-3 py-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (adding.trim().length === 0) return;
            void change(null, adding);
            setAdding("");
          }}
        >
          <PlusIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <Input
            size="sm"
            unstyled
            value={adding}
            onChange={(event) => setAdding(event.target.value)}
            placeholder={
              duties.length === 0 ? `Add a duty — e.g. ${DUTY_EXAMPLES[0]}` : "Add a duty"
            }
            className="text-sm"
            data-testid="assistant-profile-duty-add"
          />
        </form>
      )}
    </div>
  );
}

// ── Its own email ─────────────────────────────────────────────────────────

/**
 * Its own email: its address in the computer's mailbox, on/off, who it may
 * write to, its daily limit and its newest letters. Not there (the account
 * hasn't got it, a laptop): the page shows no Mail block at all.
 */
export function TeamMail(props: {
  readonly member: TeamMember;
  readonly section: (body: ReactNode) => ReactNode;
}) {
  const { member } = props;
  const queryClient = useQueryClient();
  const mailKey = ["uno-assistant", "mail", member.environmentId, member.projectId] as const;
  const mail = useQuery({
    queryKey: mailKey,
    queryFn: () =>
      getAssistantMail({
        environmentId: member.environmentId as EnvironmentId,
        projectId: member.projectId,
      }),
    retry: false,
    staleTime: 30_000,
  });
  const { save, saving } = useTeamSave(member);
  const [limitDraft, setLimitDraft] = useState<string | null>(null);
  const [adding, setAdding] = useState("");
  const [copied, setCopied] = useState(false);
  const view = mail.data;
  if (!view?.available || view.address === null) return null;
  const { policy } = view;
  const disabled = member.revoked || saving;
  const name = member.profile.name;

  const change = async (patch: Parameters<typeof save>[0]["mail"], done: string) => {
    if (await save({ mail: patch }, done)) {
      await queryClient.invalidateQueries({ queryKey: mailKey });
    }
  };
  const addAddresses = () => {
    const { addresses, invalid } = parseAddresses(adding);
    if (invalid.length > 0) {
      toastManager.add({
        type: "error",
        title: "Not an address",
        description: `${invalid.join(", ")} — use plain addresses like ann@example.com.`,
      });
      return;
    }
    if (addresses.length === 0) return;
    setAdding("");
    void change(
      { recipients: "list", allow: [...new Set([...policy.allow, ...addresses])] },
      `${name} may write to ${addresses.join(", ")}`,
    );
  };
  const copy = async () => {
    await navigator.clipboard?.writeText(view.address!).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return props.section(
    <>
      <FieldRow label="Address" testId="assistant-profile-mail-address">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[13px]">{view.address}</span>
          <Button size="icon-xs" variant="ghost" aria-label="Copy" onClick={() => void copy()}>
            {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          </Button>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {member.isUno
            ? "This computer's mailbox. Every assistant here has its own address in it."
            : `Its own address in this computer's mailbox — letters to it reach only ${name}. Its letters go out from ${view.computerAddress} with its name.`}
        </p>
      </FieldRow>
      <FieldRow label="On">
        <div className="flex items-center gap-2">
          <Switch
            checked={policy.enabled}
            disabled={disabled}
            onCheckedChange={(enabled) =>
              void change({ enabled }, enabled ? `${name}'s email is on` : `${name}'s email is off`)
            }
            data-testid="assistant-profile-mail-on"
          />
          <span className="text-xs text-muted-foreground">
            {policy.enabled
              ? mailPolicyLine(policy, view.ownerEmail)
              : "It can't read or send mail."}
          </span>
        </div>
      </FieldRow>
      {policy.enabled ? (
        <>
          <FieldRow label="Writes to">
            <div
              className="flex flex-wrap gap-1"
              role="radiogroup"
              aria-label="Who it may write to"
            >
              {MAIL_RECIPIENT_CHOICES.map((choice) => (
                <Chip
                  key={choice.id}
                  selected={policy.recipients === choice.id}
                  disabled={disabled}
                  onClick={() =>
                    void change(
                      { recipients: choice.id },
                      `${name}: writes to ${choice.label.toLowerCase()}`,
                    )
                  }
                  testId={`assistant-profile-mail-${choice.id}`}
                >
                  {choice.label}
                </Chip>
              ))}
            </div>
            {policy.recipients === "owner" ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {view.ownerEmail
                  ? `Only to ${view.ownerEmail}, your Uno account's address.`
                  : "Only to your Uno account's address."}
              </p>
            ) : null}
            {policy.recipients === "list" ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                {policy.allow.map((address) => (
                  <span
                    key={address}
                    className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-muted/50 pl-2 pr-1 text-xs"
                  >
                    {address}
                    <button
                      type="button"
                      aria-label={`Remove ${address}`}
                      disabled={disabled}
                      className="cursor-pointer rounded-full p-0.5 hover:bg-accent"
                      onClick={() =>
                        void change(
                          { allow: policy.allow.filter((item) => item !== address) },
                          `${name} no longer writes to ${address}`,
                        )
                      }
                    >
                      <XIcon className="size-3" />
                    </button>
                  </span>
                ))}
                <form
                  className="min-w-48 flex-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    addAddresses();
                  }}
                >
                  <Input
                    size="sm"
                    value={adding}
                    disabled={disabled}
                    onChange={(event) => setAdding(event.target.value)}
                    onBlur={() => adding.trim() && addAddresses()}
                    placeholder="ann@example.com"
                    data-testid="assistant-profile-mail-allow"
                  />
                </form>
                <span className="w-full text-xs text-muted-foreground">
                  You are always allowed.
                </span>
              </div>
            ) : null}
          </FieldRow>
          <FieldRow label="A day">
            <div className="flex items-center gap-2">
              <Input
                size="sm"
                nativeInput
                inputMode="numeric"
                className="w-16"
                value={limitDraft ?? String(policy.dailyLimit)}
                disabled={disabled}
                onChange={(event) => setLimitDraft(event.target.value)}
                onBlur={() => {
                  if (limitDraft === null) return;
                  const value = parseDailyLimit(limitDraft, ASSISTANT_MAIL_DAILY_MAX);
                  setLimitDraft(null);
                  if (value === null || value === policy.dailyLimit) return;
                  void change({ dailyLimit: value }, `${name}: up to ${value} letters a day`);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
                aria-label="Letters a day"
                data-testid="assistant-profile-mail-limit"
              />
              <span className="text-xs text-muted-foreground">
                letters at most (up to {ASSISTANT_MAIL_DAILY_MAX}) · sent today {view.sentToday}
              </span>
            </div>
          </FieldRow>
        </>
      ) : null}
      <div data-testid="assistant-profile-mail-letters">
        {view.letters.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            No letters yet — it uses this address for sign-ups, codes and letters as itself.
          </p>
        ) : (
          view.letters.map((letter) => (
            <div
              key={letter.id}
              className="flex h-8 items-center gap-2 border-t border-border/70 px-3 text-sm first:border-t-0"
            >
              {letter.direction === "out" ? (
                <ArrowUpRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ArrowDownLeftIcon className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span
                className={cn(
                  "w-40 shrink-0 truncate text-xs",
                  !letter.read && letter.direction === "in" && "font-medium",
                )}
              >
                {letter.direction === "out" ? `To ${letter.to[0] ?? ""}` : (letter.from ?? "")}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {letter.subject || "(no subject)"}
                {letter.suspicious ? (
                  <span className="ml-2 text-xs text-amber-700 dark:text-amber-400">
                    ⚠ not verified sender
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {letter.receivedAt ? formatRelativeTimeLabel(letter.receivedAt) : ""}
              </span>
            </div>
          ))
        )}
      </div>
    </>,
  );
}

// ── Where it works ────────────────────────────────────────────────────────

const OPTION_ICON: Readonly<Record<WorksOnOption["kind"], typeof LaptopIcon>> = {
  here: LaptopIcon,
  cloud: CloudIcon,
  own: MonitorIcon,
};

/**
 * This computer / one of the person's cloud computers / a new computer of
 * its own, each with what it means in one line. Moving to another computer
 * the app is connected to happens here (`moveAssistant.ts`); a new computer
 * of its own is the existing flow on its settings page.
 */
export function TeamWorksOn(props: { readonly member: TeamMember }) {
  const { member } = props;
  const machines = useMachineRows();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const actions = useTeamActions();
  const [confirm, setConfirm] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const here = machines.find((machine) => machine.environmentId === member.environmentId);
  const hereIsLaptop = here === undefined || here.kind === "computer";
  const options = worksOnOptions({
    isUno: member.isUno,
    hereEnvironmentId: member.environmentId,
    hereLabel: member.computerLabel || null,
    machines: machines.map((machine) => ({
      environmentId: machine.environmentId,
      boxId: machine.box?.id ?? null,
      boxName: machine.box?.name ?? null,
      label: machine.label,
      kind: machine.kind,
      status: machine.status,
    })),
  });
  const wish = worksOnWishLine(member.summary?.team?.team.worksOnWish ?? null);
  const name = member.profile.name;

  const move = async (environmentId: string, label: string) => {
    setMoving(true);
    try {
      const result = await moveAssistantToComputer(
        {
          from: {
            environmentId: member.environmentId,
            projectId: member.projectId,
            name,
            emoji: member.profile.emoji,
            preset: member.profile.preset,
            projects: member.profile.projects,
            team: member.summary?.team?.team ?? null,
          },
          toEnvironmentId: environmentId,
        },
        {
          readFile: (env, projectId, file) =>
            readAssistantFile({ environmentId: env as EnvironmentId, projectId, name: file }).then(
              (read) => read.content,
            ),
          getApps: (env, projectId) =>
            getAssistantApps({ environmentId: env as EnvironmentId, projectId }),
          listProjects: (env) =>
            listProjectsForAccessPicker({ environmentId: env as EnvironmentId }),
          createAssistant: (env, input) =>
            createAssistant({
              environmentId: env as EnvironmentId,
              name: input.name,
              ...(input.emoji ? { emoji: input.emoji } : {}),
              access: input.access as never,
            }),
          writeFile: (env, projectId, file, content) =>
            writeAssistantFile({
              environmentId: env as EnvironmentId,
              projectId,
              name: file,
              content,
            }).then(() => undefined),
          putApps: (env, projectId, permissions) =>
            putAssistantApps({ environmentId: env as EnvironmentId, projectId, permissions }).then(
              () => undefined,
            ),
          updateTeam: (env, projectId, input) =>
            updateAssistantTeam({ environmentId: env as EnvironmentId, projectId, ...input }).then(
              () => undefined,
            ),
          deleteAssistant: (env, projectId) =>
            deleteLocalAssistant({ environmentId: env as EnvironmentId, projectId }).then(
              () => undefined,
            ),
        },
      );
      await actions.refresh();
      void queryClient.invalidateQueries({ queryKey: ASSISTANT_COMPUTERS_KEY });
      toastManager.add({
        type: "success",
        title: `${name} works on ${label} now`,
        description:
          result.missingProjects.length > 0
            ? `${result.missingProjects.join(", ")} ${result.missingProjects.length === 1 ? "isn't" : "aren't"} there yet — give ${result.missingProjects.length === 1 ? "it" : "them"} on its page once synced. Link Telegram or Slack there again.`
            : "Its memory, rules and apps went along. Link Telegram or Slack there again; the one here is kept 7 days.",
      });
      await navigate({
        to: "/assistants",
        search: { view: "profile", env: environmentId, project: result.projectId },
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: `Couldn't move ${name}`,
        description: errorText(cause, "The other computer didn't answer. Nothing changed here."),
      });
    } finally {
      setMoving(false);
      setConfirm(null);
    }
  };

  return (
    <div data-testid="assistant-profile-works-on">
      {options.map((option) => {
        const Icon = option.kind === "here" && !hereIsLaptop ? CloudIcon : OPTION_ICON[option.kind];
        const key =
          option.kind === "cloud" ? `cloud:${option.environmentId ?? option.label}` : option.kind;
        const current = option.kind === "here";
        return (
          <div
            key={key}
            className="flex items-start gap-2.5 border-t border-border/70 px-3 py-2 first:border-t-0"
            data-testid={`assistant-works-on-${option.kind}`}
          >
            <span
              aria-hidden
              className={cn(
                "mt-1 flex size-3.5 shrink-0 items-center justify-center rounded-full border",
                current ? "border-primary" : "border-border",
              )}
            >
              {current ? <span className="size-1.5 rounded-full bg-primary" /> : null}
            </span>
            <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm">
                {option.label}
                {current ? (
                  <span className="ml-2 text-xs text-muted-foreground">works here now</span>
                ) : null}
              </span>
              <span className="block text-xs text-muted-foreground">
                {option.kind === "cloud" && option.blocked ? option.blocked : option.line}
              </span>
              {confirm === key ? (
                <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                  Move {name} to {option.label}? Its memory, rules, apps, duties and mail rules go
                  there; its chats stay here. The one here is kept 7 days.
                  <Button
                    size="xs"
                    disabled={moving}
                    onClick={() =>
                      option.kind === "cloud" && option.environmentId
                        ? void move(option.environmentId, option.label)
                        : undefined
                    }
                    data-testid="assistant-works-on-move-confirm"
                  >
                    {moving ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}
                    Move
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={moving}
                    onClick={() => setConfirm(null)}
                  >
                    Cancel
                  </Button>
                </span>
              ) : null}
            </span>
            {current || member.revoked || confirm === key ? null : option.kind === "cloud" ? (
              <Button
                size="xs"
                variant="outline"
                disabled={option.blocked !== null || moving}
                onClick={() => setConfirm(key)}
              >
                Move here
              </Button>
            ) : (
              // A computer of its own is made in My Uno (size, exit IP), then "Move here".
              <Button size="xs" variant="outline" onClick={() => void navigate({ to: "/my-uno" })}>
                Make one
              </Button>
            )}
          </div>
        );
      })}
      {member.isUno ? (
        <p className="border-t border-border/70 px-3 py-2 text-xs text-muted-foreground">
          Uno is this computer's own assistant: every computer has its own Uno.
        </p>
      ) : wish ? (
        <p className="border-t border-border/70 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          {wish}
        </p>
      ) : null}
    </div>
  );
}
