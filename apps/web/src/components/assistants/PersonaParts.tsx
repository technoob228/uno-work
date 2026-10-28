/**
 * Small pieces the persona setup and Uno's first-run screen share: a field
 * label, a chip, a choice card, the two modes, where it works and where it
 * can look (a project limit is a real lock only on its own computer).
 */
import { isAssistantProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  CloudIcon,
  HandIcon,
  LaptopIcon,
  LockIcon,
  MoonIcon,
  TriangleAlertIcon,
  ZapIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";

import { useEnvironmentSupportsAssistantSandbox } from "../../environments/assistantChatSupport";
import { useMachineRows } from "../../hooks/useMachineRows";
import { cn } from "../../lib/utils";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { Button } from "../ui/button";

import { MODE_COPY, type AssistantMode } from "./PersonaMode";
import { type PersonaWorksOn, personaWorksOn, projectLockOn } from "./personaChannels";

export function Label(props: { readonly children: ReactNode; readonly hint?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-baseline gap-2">
      <span className="text-[13px] font-semibold">{props.children}</span>
      {props.hint ? <span className="text-xs text-muted-foreground">{props.hint}</span> : null}
    </div>
  );
}

export function Chip(props: {
  readonly on: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-pressed={props.on}
      data-testid={props.testId}
      className={cn(
        "cursor-pointer rounded-full border px-2.5 py-1 text-xs transition-colors",
        props.on
          ? "border-primary bg-primary/10 font-medium text-primary"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {props.children}
    </button>
  );
}

export function ModeCard(props: {
  readonly on: boolean;
  readonly onClick: () => void;
  readonly title: ReactNode;
  readonly line: ReactNode;
  readonly testId: string;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-pressed={props.on}
      disabled={props.disabled}
      data-testid={props.testId}
      className={cn(
        "flex cursor-pointer flex-col gap-0.5 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        props.on ? "border-primary bg-primary/[0.06]" : "border-border hover:bg-accent/50",
      )}
    >
      <span className="flex items-center gap-1.5 text-sm font-semibold">{props.title}</span>
      <span className="text-xs text-muted-foreground">{props.line}</span>
    </button>
  );
}

/** "Autonomous" / "Cautious" — the two modes, side by side. */
export function ModePicker(props: {
  readonly mode: AssistantMode;
  readonly onChange: (mode: AssistantMode) => void;
  readonly testIdPrefix: string;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <ModeCard
        on={props.mode === "itself"}
        onClick={() => props.onChange("itself")}
        title={
          <>
            <ZapIcon className="size-4 text-amber-500" /> {MODE_COPY.itself.label}
          </>
        }
        line={MODE_COPY.itself.line}
        testId={`${props.testIdPrefix}-itself`}
      />
      <ModeCard
        on={props.mode === "asks-first"}
        onClick={() => props.onChange("asks-first")}
        title={
          <>
            <HandIcon className="size-4 text-amber-500" /> {MODE_COPY["asks-first"].label}
          </>
        }
        line={MODE_COPY["asks-first"].line}
        testId={`${props.testIdPrefix}-asks`}
      />
    </div>
  );
}

// ── Where it works ───────────────────────────────────────────────────────

/** The computers it can live on: its home, the account's other connected ones, a new one. */
export function useWorksOn(homeEnvironmentId: string | null): ReadonlyArray<PersonaWorksOn> {
  const rows = useMachineRows();
  return personaWorksOn({
    homeEnvironmentId,
    machines: rows.map((row) => ({
      environmentId: row.environmentId,
      boxId: row.box?.id ?? null,
      boxName: row.box?.name ?? null,
      label: row.label,
      kind: row.kind,
      status: row.status,
    })),
  });
}

export function WhereItWorks(props: {
  readonly homeEnvironmentId: string | null;
  readonly value: string | null;
  /** `null`: "a computer of its own" (made in My Uno first). */
  readonly onChange: (environmentId: string | null) => void;
}) {
  const navigate = useNavigate();
  const options = useWorksOn(props.homeEnvironmentId);
  const own = props.value === null;
  return (
    <div className="flex flex-col gap-2" data-testid="persona-works-on">
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => {
          const Icon = option.why ? MoonIcon : option.laptop ? LaptopIcon : CloudIcon;
          return (
            <ModeCard
              key={`${option.kind}:${option.target ?? "own"}`}
              on={
                option.kind === "own"
                  ? own
                  : option.target !== null && props.value === option.target
              }
              disabled={option.why !== null}
              onClick={() => props.onChange(option.target)}
              title={
                <>
                  <Icon className="size-4 text-muted-foreground" /> {option.label}
                </>
              }
              line={option.why ?? option.line}
              testId={`persona-works-on-${option.kind === "cloud" ? (option.target ?? "cloud") : option.kind}`}
            />
          );
        })}
      </div>
      {own ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">
            Make the computer in My Uno first; when it's on, pick it here.
          </span>
          <Button size="xs" variant="outline" onClick={() => void navigate({ to: "/my-uno" })}>
            Open My Uno
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ── Where it can look ────────────────────────────────────────────────────

interface ProjectOption {
  readonly key: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly title: string;
  readonly machine: string;
  readonly lock: "sandbox" | "note";
}

/** The person's projects (not assistants' folders, not the home folder), its computer's first. */
export function usePersonaProjects(homeEnvironmentId: string | null): ReadonlyArray<ProjectOption> {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const rows = useMachineRows();
  // A lock only where its commands run in a sandbox (bubblewrap on a cloud computer).
  const sandbox = useEnvironmentSupportsAssistantSandbox(homeEnvironmentId);
  const labelOf = (environmentId: string) =>
    rows.find((row) => row.environmentId === environmentId)?.label ?? "a computer";
  return projects
    .filter((project) => !isAssistantProjectId(project.id) && !/^home folder$/i.test(project.name))
    .map((project) => ({
      key: `${project.environmentId}:${project.id}`,
      environmentId: project.environmentId,
      projectId: project.id,
      title: project.name,
      machine: labelOf(project.environmentId),
      lock: sandbox
        ? projectLockOn({
            projectEnvironmentId: project.environmentId,
            personaEnvironmentId: homeEnvironmentId ?? "",
          })
        : ("note" as const),
    }))
    .toSorted((a, b) => (a.lock === b.lock ? 0 : a.lock === "sandbox" ? -1 : 1));
}

export function WhereItLooks(props: {
  readonly name: string;
  readonly homeEnvironmentId: string | null;
  readonly homeLabel: string;
  readonly limited: boolean;
  readonly onLimited: (limited: boolean) => void;
  readonly picked: ReadonlySet<string>;
  readonly onToggle: (key: string) => void;
}) {
  const options = usePersonaProjects(props.homeEnvironmentId);
  const notes = options.filter((option) => option.lock === "note" && props.picked.has(option.key));
  const who = props.name.trim() || "it";
  return (
    <div className="flex flex-col gap-2" data-testid="persona-where">
      <div className="grid gap-2 sm:grid-cols-2">
        <ModeCard
          on={!props.limited}
          onClick={() => props.onLimited(false)}
          title="All my projects"
          line="Like Uno: every project, new ones too."
          testId="persona-where-all"
        />
        <ModeCard
          on={props.limited}
          onClick={() => props.onLimited(true)}
          title="Only some projects"
          line="Pick them below."
          testId="persona-where-some"
        />
      </div>
      {props.limited ? (
        <div className="flex flex-col rounded-xl border border-border">
          {options.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">No projects yet.</p>
          ) : null}
          {options.map((option) => (
            <label
              key={option.key}
              className="flex cursor-pointer items-center gap-2 border-t border-border/70 px-3 py-2 text-sm first:border-t-0"
              data-testid={`persona-project-${option.projectId}`}
            >
              <input
                type="checkbox"
                className="accent-primary"
                checked={props.picked.has(option.key)}
                onChange={() => props.onToggle(option.key)}
              />
              <span className="min-w-0 flex-1 truncate">{option.title}</span>
              <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                {option.lock === "sandbox" ? (
                  <>
                    <CloudIcon className="size-3" /> {option.machine} ·
                    <LockIcon className="size-3 text-success" /> locked
                  </>
                ) : (
                  <>
                    <LaptopIcon className="size-3" /> {option.machine} · a note, not a lock
                  </>
                )}
              </span>
            </label>
          ))}
        </div>
      ) : null}
      {notes.length > 0 ? (
        <div
          className="flex gap-2 rounded-xl border border-warning/40 bg-warning/[0.06] px-3 py-2.5 text-xs leading-snug"
          data-testid="persona-lock-note"
        >
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>
            <b className="font-semibold">On your {notes[0]!.machine} this is a note, not a lock.</b>{" "}
            {who} lives on {props.homeLabel}. Chats {who} starts on the {notes[0]!.machine} can
            still open other folders there — we'll only ask it to stay in{" "}
            {notes.map((note) => note.title).join(", ")}. A real lock: pick projects on{" "}
            {props.homeLabel}, or give {who} a computer of its own later.
          </span>
        </div>
      ) : props.limited && props.picked.size > 0 ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <LockIcon className="size-3 text-success" /> Locked by a sandbox on {props.homeLabel}:{" "}
          {who} can't open anything else there.
        </p>
      ) : null}
    </div>
  );
}
