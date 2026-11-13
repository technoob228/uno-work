/**
 * The parts of "Your own computer" (Computers → Add computer), without the
 * window around them, so the guided setup can show the same flow inside its
 * page (13.11, "Move my projects here"):
 *
 *   ConnectOwnComputer — Mac / Windows: Download Uno Work, or one command;
 *                        Linux: the command; waits until the computer is in;
 *   PurposeCards       — "What is it for?" (tool for agents / a full computer);
 *   BringChoiceList    — "Bring your work?": chats, projects, key names.
 *
 * Each part takes its state from the caller: the Add computer window keeps it
 * in the lifecycle store (`useStorePairFlow`), a page in its own state
 * (`useLocalPairFlow`). What happens on the cloud computer is the same.
 */
import type {
  ComputerPurpose,
  EnvironmentId,
  FoundProject,
  ImportedChatTool,
  MyComputerImportTool,
  MyComputerPairing,
} from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronRightIcon,
  DownloadIcon,
  LaptopIcon,
  Loader2Icon,
  LockIcon,
  WrenchIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

import { lifecycleBackend } from "../../computersLifecycle/backend";
import type { BroughtWork } from "../../computersLifecycle/store";
import {
  errorText,
  useComputersHostId,
  useSetComputerPurpose,
} from "../../computersLifecycle/useComputers";
import { useComputerWork } from "../../computersLifecycle/useComputerWork";
import { DEMO } from "../../demo/demoFlag";
import { ensureEnvironmentApi } from "../../environmentApi";
import { cn } from "../../lib/utils";
import { liteLinks } from "../../lite/webLite";
import { useImportActions, useImportStatus } from "../../localComputer/useChatImport";
import {
  STATUS_POLL_PAIRING_MS,
  useMyComputers,
  usePairStatus,
  useRefreshMyComputers,
} from "../../localComputer/useMyComputers";
import { CopyButton } from "../computer/computerUi";
import { ClaudeAI, OpenAI, OpenCodeIcon } from "../Icons";
import { chatsLabel, offeredTools } from "../localComputer/chatImport.logic";
import {
  LOCAL_OS,
  LOCAL_OS_ORDER,
  pairProgress,
  type LocalOs,
} from "../localComputer/connectComputer.logic";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";

const TOOL_ICON = { claude: ClaudeAI, codex: OpenAI, opencode: OpenCodeIcon } as const;

export function LifecycleCard(props: {
  icon: ReactNode;
  title: string;
  detail: string;
  testId: string;
  busy?: boolean;
  disabled?: boolean;
  /** A pick to confirm (the desktop app's path), not a click that goes on. */
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      data-testid={props.testId}
      data-selected={props.selected ? "true" : undefined}
      aria-pressed={props.selected}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl border bg-card/40 p-3.5 text-left transition-colors enabled:hover:bg-accent disabled:opacity-60",
        props.selected ? "border-primary/70 bg-primary/5" : "border-border/70",
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">
        {props.icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">{props.title}</span>
        <span className="text-xs text-muted-foreground">{props.detail}</span>
      </span>
      {props.busy ? (
        <Loader2Icon className="size-4 shrink-0 animate-spin text-muted-foreground" />
      ) : props.selected ? (
        <CheckIcon className="size-4 shrink-0 text-primary" />
      ) : props.selected === false ? null : (
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
      )}
    </button>
  );
}

export function useComputerName(computerId: string | null): string {
  const { computers } = useMyComputers(useComputersHostId());
  return computers.find((one) => one.id === computerId)?.name ?? "Your computer";
}

// ── connect: download or one command ────────────────────────────────────

/** What connecting a computer keeps while it waits for it. */
export interface PairFlow {
  readonly os: LocalOs;
  /** Mac / Windows: "or paste one command" was opened. */
  readonly showCommand: boolean;
  readonly pairing: MyComputerPairing | null;
  readonly pairError: string | null;
  readonly setOs: (os: LocalOs) => void;
  readonly revealCommand: () => void;
  readonly paired: (pairing: MyComputerPairing) => void;
  readonly pairFailed: (message: string) => void;
  /** A code expired or failed: the next one is asked for. */
  readonly repair: () => void;
  /** The computer is in (a `MyComputer` id). */
  readonly connected: (computerId: string) => void;
}

/** A page's own pairing state (the window keeps it in the lifecycle store). */
export function useLocalPairFlow(onConnected: (computerId: string) => void): PairFlow {
  const [os, setOs] = useState<LocalOs>("mac");
  const [showCommand, setShowCommand] = useState(false);
  const [pairing, setPairing] = useState<MyComputerPairing | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const connected = useCallback((computerId: string) => onConnected(computerId), [onConnected]);
  return useMemo(
    () => ({
      os,
      showCommand,
      pairing,
      pairError,
      setOs,
      revealCommand: () => setShowCommand(true),
      paired: (next: MyComputerPairing) => {
        setPairing(next);
        setPairError(null);
      },
      pairFailed: setPairError,
      repair: () => {
        setPairing(null);
        setPairError(null);
      },
      connected,
    }),
    [connected, os, pairError, pairing, showCommand],
  );
}

function CommandBox({ command }: { command: string }) {
  return (
    <div
      className="flex items-center gap-2 rounded-xl border bg-muted/40 py-1.5 pr-1.5 pl-3"
      onClickCapture={lifecycleBackend.installStarted}
      data-testid="lc-command"
    >
      <code className="min-w-0 flex-1 truncate font-mono text-xs" title={command}>
        {command}
      </code>
      <CopyButton value={command} label="command" />
    </div>
  );
}

/** "Your own computer": the system, Download or the command, and the wait for it. */
export function ConnectOwnComputer({ flow }: { flow: PairFlow }) {
  const environmentId = useComputersHostId();
  const { os, showCommand, pairing, pairError } = flow;
  const { paired, pairFailed, repair, connected } = flow;
  const [downloaded, setDownloaded] = useState(false);

  // A code for the command (and for the app to link itself with), once.
  useEffect(() => {
    if (pairing !== null || environmentId === null) return;
    let gone = false;
    ensureEnvironmentApi(environmentId)
      .myComputer.pair()
      .then(
        (next) => {
          if (!gone) paired(next);
        },
        (cause: unknown) => {
          if (!gone) pairFailed(errorText(cause));
        },
      );
    return () => {
      gone = true;
    };
  }, [environmentId, pairing, paired, pairFailed]);

  const pairStatus = usePairStatus(environmentId, pairing);
  const { computers, settled } = useMyComputers(environmentId, {
    pollMs: STATUS_POLL_PAIRING_MS,
  });
  const refresh = useRefreshMyComputers();
  const progress =
    pairing === null
      ? null
      : pairProgress({
          status: pairStatus.data,
          computers,
          expiresAt: pairing.expiresAt,
          nowMs: Date.now(),
        });
  // Downloaded the app: the app links this computer with its own code, so the
  // computer that turns up new while this is open is the one.
  const [knownIds, setKnownIds] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => {
    if (settled && knownIds === null) setKnownIds(new Set(computers.map((one) => one.id)));
  }, [computers, knownIds, settled]);
  const appeared =
    downloaded && knownIds !== null
      ? (computers.find((one) => one.online && !knownIds.has(one.id))?.id ?? null)
      : null;
  const connectedId = progress?.kind === "connected" ? progress.computerId : (appeared ?? null);
  useEffect(() => {
    if (connectedId === null) return;
    void refresh();
    connected(connectedId);
  }, [connectedId, connected, refresh]);
  // A code lives 15 minutes: an expired one is replaced, the command with it.
  const expired = progress?.kind === "expired";
  useEffect(() => {
    if (expired) repair();
  }, [expired, repair]);
  const failure = progress?.kind === "failed" ? progress : null;

  const app = os !== "linux";
  const download = () => {
    setDownloaded(true);
    lifecycleBackend.installStarted();
    // The demo answers the helper itself; a real page opens the download.
    if (!DEMO) window.open(liteLinks.download, "_blank", "noopener");
  };
  const waiting =
    progress?.kind === "finishing" ? "Finishing setup…" : "Waiting for your computer…";

  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label="Your system" className="flex gap-1.5">
        {LOCAL_OS_ORDER.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={id === os}
            onClick={() => flow.setOs(id)}
            data-testid={`lc-os-${id}`}
            className={cn(
              "cursor-pointer rounded-full border px-3 py-1 text-sm transition-colors",
              id === os
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border hover:bg-muted/60",
            )}
          >
            {LOCAL_OS[id].label}
          </button>
        ))}
      </div>
      {app ? (
        <div className="flex flex-col gap-2">
          <Button size="lg" onClick={download} data-testid="lc-download">
            <DownloadIcon />
            Download Uno Work
          </Button>
          {showCommand ? null : (
            <button
              type="button"
              onClick={flow.revealCommand}
              data-testid="lc-show-command"
              className="self-center text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              or paste one command
            </button>
          )}
        </div>
      ) : null}
      {(!app || showCommand) && pairing ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm text-muted-foreground">Paste into {LOCAL_OS[os].terminal}:</p>
          <CommandBox command={pairing.commands[os]} />
        </div>
      ) : null}
      {pairError !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {pairError}
        </p>
      ) : null}
      {failure !== null ? (
        <div role="alert" className="flex flex-col gap-1.5 text-sm" data-testid="lc-pair-failed">
          <p className="text-destructive">
            {failure.message ?? "It didn’t connect. Try the command again."}
          </p>
          {failure.codeUsable ? null : (
            <Button size="xs" variant="outline" className="self-start" onClick={repair}>
              Get a new command
            </Button>
          )}
        </div>
      ) : null}
      <p
        className="flex items-center gap-2 text-sm text-muted-foreground"
        data-testid="lc-waiting"
        aria-live="polite"
      >
        <Loader2Icon className="size-3.5 animate-spin" />
        {downloaded && app ? "Open Uno Work and sign in…" : waiting}
      </p>
    </div>
  );
}

// ── purpose: what is it for ─────────────────────────────────────────────

export interface PurposeChoice {
  readonly busy: ComputerPurpose | null;
  readonly error: string | null;
  /** The desktop app's path comes with a pick: a click changes it, Continue goes on. */
  readonly confirming: boolean;
  readonly picked: ComputerPurpose | null;
  readonly click: (purpose: ComputerPurpose) => void;
  readonly confirm: () => void;
}

export function usePurposeChoice(input: {
  readonly computerId: string | null;
  readonly preselect: ComputerPurpose | null;
  readonly onChosen: (purpose: ComputerPurpose) => void;
}): PurposeChoice {
  const { computerId, preselect, onChosen } = input;
  const setPurpose = useSetComputerPurpose();
  const [busy, setBusy] = useState<ComputerPurpose | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<ComputerPurpose | null>(preselect);
  const choose = async (purpose: ComputerPurpose) => {
    if (computerId === null) return;
    setBusy(purpose);
    setError(null);
    try {
      await setPurpose(computerId, purpose);
      onChosen(purpose);
    } catch (cause) {
      setError(errorText(cause, "Couldn’t save it. Try again."));
    } finally {
      setBusy(null);
    }
  };
  const confirming = preselect !== null;
  return {
    busy,
    error,
    confirming,
    picked,
    click: (purpose) => (confirming ? setPicked(purpose) : void choose(purpose)),
    confirm: () => {
      if (picked) void choose(picked);
    },
  };
}

/** "Tool for your agents" / "A full computer", and what went wrong saving it. */
export function PurposeCards({ choice }: { choice: PurposeChoice }) {
  const { busy, confirming, picked } = choice;
  return (
    <div className="flex flex-col gap-2">
      <LifecycleCard
        icon={<WrenchIcon />}
        title="Tool for your agents"
        detail="Agents run commands and read files here."
        testId="lc-purpose-tool"
        busy={busy === "tool"}
        disabled={busy !== null}
        {...(confirming ? { selected: picked === "tool" } : {})}
        onClick={() => choice.click("tool")}
      />
      <LifecycleCard
        icon={<LaptopIcon />}
        title="A full computer"
        detail="Start chats on it. The agent runs in your cloud, commands and files here."
        testId="lc-purpose-full"
        busy={busy === "full"}
        disabled={busy !== null}
        {...(confirming ? { selected: picked === "full" } : {})}
        onClick={() => choice.click("full")}
      />
      <p className="mt-1 text-xs text-muted-foreground">You can change this later.</p>
      {choice.error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {choice.error}
        </p>
      ) : null}
    </div>
  );
}

// ── bring: chats, projects, key names ───────────────────────────────────

function ToolRow({
  tool,
  on,
  onToggle,
}: {
  tool: MyComputerImportTool;
  on: boolean;
  onToggle: () => void;
}) {
  const Icon = TOOL_ICON[tool.id];
  if (!tool.available) {
    return (
      <div className="flex items-center gap-3 px-1 py-1.5 text-muted-foreground">
        <Checkbox checked={false} disabled />
        <Icon className="size-4 shrink-0 opacity-60" />
        <span className="min-w-0 flex-1 truncate text-sm">{tool.name}</span>
        <span className="shrink-0 text-xs">{tool.unavailableReason}</span>
      </div>
    );
  }
  return (
    <label
      className="flex cursor-pointer items-center gap-3 rounded-lg px-1 py-1.5 hover:bg-accent/60"
      data-testid={`lc-bring-tool-${tool.id}`}
    >
      <Checkbox checked={on} onCheckedChange={onToggle} />
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-sm">{tool.name}</span>
      <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
        {chatsLabel(tool.newChats)}
      </span>
    </label>
  );
}

function ProjectRow({
  project,
  on,
  offKeys,
  onToggle,
  onToggleKey,
}: {
  project: FoundProject;
  on: boolean;
  offKeys: ReadonlySet<string>;
  onToggle: () => void;
  onToggleKey: (key: string) => void;
}) {
  return (
    <div className="flex flex-col" data-testid={`lc-bring-project-${project.name}`}>
      <label className="flex cursor-pointer items-center gap-3 rounded-lg px-1 py-1.5 hover:bg-accent/60">
        <Checkbox checked={on} onCheckedChange={onToggle} />
        <span className="min-w-0 flex-1 truncate text-sm">{project.name}</span>
        <span className="max-w-40 shrink-0 truncate text-xs text-muted-foreground">
          {project.synced ? "On all my computers" : project.displayPath}
        </span>
      </label>
      {on && project.keys.length > 0 ? (
        <div className="mb-1 ml-8 flex flex-wrap gap-1.5" data-testid="lc-bring-keys">
          {project.keys.map((key) => (
            <label
              key={key}
              className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border/70 px-1.5 py-0.5 font-mono text-[11px] hover:bg-accent/60"
            >
              <Checkbox
                className="size-3.5 sm:size-3.5"
                checked={!offKeys.has(key)}
                onCheckedChange={() => onToggleKey(key)}
              />
              {key}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-1 pt-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </div>
  );
}

/** Ticked unless the person changed it: projects a chat ran in, not synced yet. */
const tickedByDefault = (project: FoundProject) => project.fromChats && !project.synced;

const toggled = <T,>(set: ReadonlySet<T>, value: T): ReadonlySet<T> => {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
};

/** What "Bring" started: the window's summary, and the projects in the order shown. */
export interface BringStarted {
  readonly brought: BroughtWork;
  readonly projects: ReadonlyArray<{ readonly path: string; readonly name: string }>;
}

export interface BringChoice {
  readonly environmentId: EnvironmentId | null;
  readonly tools: ReadonlyArray<MyComputerImportTool>;
  /** Still looking for chats. */
  readonly searching: boolean;
  readonly untickedTools: ReadonlySet<ImportedChatTool>;
  readonly toggleTool: (tool: ImportedChatTool) => void;
  readonly projects: ReadonlyArray<FoundProject>;
  readonly projectsSearching: boolean;
  /** The scan didn't answer, or failed: its words. */
  readonly projectsFailure: string | null;
  readonly isOn: (project: FoundProject) => boolean;
  readonly toggleProject: (project: FoundProject) => void;
  readonly offKeysOf: (project: FoundProject) => ReadonlySet<string>;
  readonly toggleKey: (project: FoundProject, key: string) => void;
  readonly pickedProjects: ReadonlyArray<FoundProject>;
  readonly anyKeys: boolean;
  /** "6 chats, 3 projects"; "" when nothing is picked. */
  readonly label: string;
  readonly busy: boolean;
  readonly error: string | null;
  /** Starts bringing what is picked; null when it didn't start (`error` says why). */
  readonly bring: () => Promise<BringStarted | null>;
}

/** "Bring your work?" for one of the person's computers: what is found and what is picked. */
export function useBringChoice(computerId: string | null): BringChoice {
  const environmentId = useComputersHostId();
  const status = useImportStatus(environmentId, computerId, { watch: true }).data;
  const actions = useImportActions(environmentId, computerId);
  useEffect(() => {
    if (environmentId !== null && computerId !== null) actions.scan().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computerId, environmentId]);
  const work = useComputerWork(computerId, { scan: true });
  const projects = work.status?.scan.projects ?? [];
  const [untickedTools, setUntickedTools] = useState<ReadonlySet<ImportedChatTool>>(new Set());
  /** Projects whose tick differs from `tickedByDefault`. */
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
  const [offKeys, setOffKeys] = useState<ReadonlyMap<string, ReadonlySet<string>>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tools = status?.state === "ready" ? offeredTools(status.tools) : [];
  const searching = status === undefined || status.state === "scanning" || status.state === "idle";
  const pickedTools = tools.filter((tool) => tool.available && !untickedTools.has(tool.id));
  const chatCount = pickedTools.reduce((sum, tool) => sum + tool.newChats, 0);
  const isOn = (project: FoundProject) => tickedByDefault(project) !== flipped.has(project.path);
  const pickedProjects = projects.filter(isOn);
  const keysOf = (project: FoundProject) =>
    project.keys.filter((key) => !offKeys.get(project.path)?.has(key));
  const keyCount = pickedProjects.reduce((sum, project) => sum + keysOf(project).length, 0);

  const bring = async (): Promise<BringStarted | null> => {
    if (computerId === null) return null;
    setBusy(true);
    setError(null);
    try {
      if (pickedProjects.length > 0) {
        await work.bring(
          pickedProjects.map((project) => ({ path: project.path, keys: keysOf(project) })),
        );
      }
      if (pickedTools.length > 0) {
        await actions.start(pickedTools.map((tool) => tool.id));
      }
      return {
        brought: {
          chats: chatCount,
          projects: pickedProjects.map((project) => project.name),
          keys: keyCount,
        },
        projects: pickedProjects.map((project) => ({ path: project.path, name: project.name })),
      };
    } catch (cause) {
      setError(errorText(cause, "Couldn’t bring it. Try again."));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const label = [
    chatCount > 0 ? chatsLabel(chatCount) : null,
    pickedProjects.length > 0
      ? `${pickedProjects.length} ${pickedProjects.length === 1 ? "project" : "projects"}`
      : null,
  ]
    .filter(Boolean)
    .join(", ");

  const scanFailed = work.status?.scan.state === "failed" || (work.failed && !work.status);
  return {
    environmentId,
    tools,
    searching,
    untickedTools,
    toggleTool: (tool) => setUntickedTools((current) => toggled(current, tool)),
    projects,
    projectsSearching: work.searching,
    projectsFailure: scanFailed
      ? (work.status?.scan.message ?? "Couldn’t look for projects.")
      : null,
    isOn,
    toggleProject: (project) => setFlipped((current) => toggled(current, project.path)),
    offKeysOf: (project) => offKeys.get(project.path) ?? new Set(),
    toggleKey: (project, key) =>
      setOffKeys((current) => {
        const next = new Map(current);
        next.set(project.path, toggled(current.get(project.path) ?? new Set(), key));
        return next;
      }),
    pickedProjects,
    anyKeys: pickedProjects.some((project) => project.keys.length > 0),
    label,
    busy,
    error,
    bring,
  };
}

/** The lists of "Bring your work?": chats by tool, projects with their key names. */
export function BringChoiceList({ choice }: { choice: BringChoice }) {
  const { projects } = choice;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col">
        <SectionLabel>Chats</SectionLabel>
        {choice.searching ? (
          <p className="flex items-center gap-2 px-1 py-1.5 text-sm text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" />
            Looking for chats…
          </p>
        ) : choice.tools.length === 0 ? (
          <p className="px-1 py-1.5 text-sm text-muted-foreground">No chats found.</p>
        ) : (
          choice.tools.map((tool) => (
            <ToolRow
              key={tool.id}
              tool={tool}
              on={!choice.untickedTools.has(tool.id)}
              onToggle={() => choice.toggleTool(tool.id)}
            />
          ))
        )}
      </div>
      <div className="flex flex-col" data-testid="lc-bring-projects">
        <SectionLabel>Projects</SectionLabel>
        {choice.projectsSearching && projects.length === 0 ? (
          <p className="flex items-center gap-2 px-1 py-1.5 text-sm text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" />
            Looking for projects…
          </p>
        ) : choice.projectsFailure !== null ? (
          <p className="px-1 py-1.5 text-sm text-muted-foreground">{choice.projectsFailure}</p>
        ) : projects.length === 0 ? (
          <p className="px-1 py-1.5 text-sm text-muted-foreground" data-testid="lc-bring-none">
            No git projects in ~/projects, ~/code, ~/Developer or the other usual folders.
          </p>
        ) : (
          projects.map((project) => (
            <ProjectRow
              key={project.path}
              project={project}
              on={choice.isOn(project)}
              offKeys={choice.offKeysOf(project)}
              onToggle={() => choice.toggleProject(project)}
              onToggleKey={(key) => choice.toggleKey(project, key)}
            />
          ))
        )}
        {choice.anyKeys ? (
          <p
            className="mt-1 flex items-center gap-1.5 px-1 text-xs text-muted-foreground"
            data-testid="lc-keys-note"
          >
            <LockIcon className="size-3 shrink-0" />
            Keys are kept encrypted, never in the project’s files.
          </p>
        ) : null}
      </div>
      {choice.error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {choice.error}
        </p>
      ) : null}
    </div>
  );
}
