/**
 * The one "Add computer" window (Misha 02.11, SPEC "Один путь"): every entry —
 * Home's "Connect your AI or other computers", the computers menu, Settings,
 * Connectors, My Uno — lands here.
 *
 *   choose → Uno cloud computer (today's flow: plan, region)
 *          → Your own computer → own: Mac / Windows — Download Uno Work, or one
 *            command; Linux — the command → "MacBook is connected" →
 *            purpose: "What is it for?" → bring: chats, projects, key names → done
 *
 * All of it talks to the cloud computer that holds the person's own computers
 * (`useComputersHostId`): the pairing (`myComputer.pair` + `pairStatus`), what
 * the computer is for (`computers.setPurpose`), its chats (`myComputer.import*`)
 * and its projects and key names (`computers.workScan` / `bringWork`). Until the
 * backend has the projects part, "Bring your work?" offers chats only.
 * SSH / address + code: Dev Mode only.
 */
import type { FoundProject, ImportedChatTool, MyComputerImportTool } from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronRightIcon,
  CloudIcon,
  DownloadIcon,
  LaptopIcon,
  Loader2Icon,
  LockIcon,
  WrenchIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { lifecycleBackend } from "../../computersLifecycle/backend";
import { type ComputerPurpose, lifecycle, useLifecycle } from "../../computersLifecycle/store";
import {
  errorText,
  useComputersHostId,
  useSetComputerPurpose,
} from "../../computersLifecycle/useComputers";
import { useComputerWork } from "../../computersLifecycle/useComputerWork";
import { DEMO } from "../../demo/demoFlag";
import { useDevMode } from "../../devMode";
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
import { AddEnvModal } from "../AddEnvModal";
import { ThisMacPrompt } from "./ThisMacPrompt";
import { CopyButton } from "../computer/computerUi";
import { ClaudeAI, OpenAI, OpenCodeIcon } from "../Icons";
import { chatsLabel, offeredTools } from "../localComputer/chatImport.logic";
import { LOCAL_OS, LOCAL_OS_ORDER, pairProgress } from "../localComputer/connectComputer.logic";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

const TOOL_ICON = { claude: ClaudeAI, codex: OpenAI, opencode: OpenCodeIcon } as const;

function Card(props: {
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

function BackTitle({ children, onBack }: { children: ReactNode; onBack?: () => void }) {
  return (
    <DialogTitle className="flex items-center gap-2 text-lg">
      {onBack ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Back"
          onClick={onBack}
          data-testid="lc-back"
        >
          <ArrowLeftIcon />
        </Button>
      ) : null}
      {children}
    </DialogTitle>
  );
}

// ── choose ──────────────────────────────────────────────────────────────

function ChooseStep() {
  const devMode = useDevMode();
  return (
    <div className="flex min-h-0 flex-col" data-testid="lc-add-choose">
      <DialogHeader>
        <BackTitle>Add computer</BackTitle>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-2">
        <Card
          icon={<CloudIcon />}
          title="Uno cloud computer"
          detail="Always on, agents ready."
          testId="lc-add-cloud"
          onClick={lifecycle.openCloud}
        />
        <Card
          icon={<LaptopIcon />}
          title="Your own computer"
          detail="Mac, Windows or Linux."
          testId="lc-add-own"
          onClick={() => lifecycle.go("own")}
        />
        {devMode ? (
          <button
            type="button"
            onClick={lifecycle.openCustom}
            data-testid="lc-add-ssh"
            className="mt-1 self-start text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            Connect by SSH or address
          </button>
        ) : null}
      </DialogPanel>
    </div>
  );
}

// ── own: download or one command ────────────────────────────────────────

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

function OwnStep() {
  const environmentId = useComputersHostId();
  const os = useLifecycle((state) => state.os);
  const showCommand = useLifecycle((state) => state.showCommand);
  const pairing = useLifecycle((state) => state.pairing);
  const pairError = useLifecycle((state) => state.pairError);
  const [downloaded, setDownloaded] = useState(false);

  // A code for the command (and for the app to link itself with), once.
  useEffect(() => {
    if (pairing !== null || environmentId === null) return;
    let gone = false;
    ensureEnvironmentApi(environmentId)
      .myComputer.pair()
      .then(
        (next) => {
          if (!gone) lifecycle.paired(next);
        },
        (cause: unknown) => {
          if (!gone) lifecycle.pairFailed(errorText(cause));
        },
      );
    return () => {
      gone = true;
    };
  }, [environmentId, pairing]);

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
  // computer that turns up new while this window is open is the one.
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
    lifecycle.connected(connectedId);
  }, [connectedId, refresh]);
  // A code lives 15 minutes: an expired one is replaced, the command with it.
  const expired = progress?.kind === "expired";
  useEffect(() => {
    if (expired) lifecycle.repair();
  }, [expired]);
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
    <div className="flex min-h-0 flex-col" data-testid="lc-add-own-step">
      <DialogHeader>
        <BackTitle onBack={() => lifecycle.go("choose")}>Your own computer</BackTitle>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-4">
        <div role="tablist" aria-label="Your system" className="flex gap-1.5">
          {LOCAL_OS_ORDER.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={id === os}
              onClick={() => lifecycle.setOs(id)}
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
                onClick={lifecycle.showCommand}
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
              <Button size="xs" variant="outline" className="self-start" onClick={lifecycle.repair}>
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
      </DialogPanel>
    </div>
  );
}

// ── purpose: what is it for ─────────────────────────────────────────────

function useComputerName(computerId: string | null): string {
  const { computers } = useMyComputers(useComputersHostId());
  return computers.find((one) => one.id === computerId)?.name ?? "Your computer";
}

function PurposeStep() {
  const computerId = useLifecycle((state) => state.computerId);
  const preselect = useLifecycle((state) => state.preselect);
  const name = useComputerName(computerId);
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
      lifecycle.chosePurpose(purpose);
    } catch (cause) {
      setError(errorText(cause, "Couldn’t save it. Try again."));
    } finally {
      setBusy(null);
    }
  };
  // The desktop app's path comes with a pick: a click changes it, Continue goes on.
  const confirming = preselect !== null;
  const click = (purpose: ComputerPurpose) =>
    confirming ? setPicked(purpose) : void choose(purpose);
  return (
    <div className="flex min-h-0 flex-col" data-testid="lc-add-purpose">
      <DialogHeader>
        <BackTitle>
          <span className="grid size-7 place-items-center rounded-lg bg-emerald-500/12 text-emerald-600 dark:text-emerald-400">
            <CheckIcon className="size-4" />
          </span>
          {name} is connected
        </BackTitle>
        <DialogDescription>What is it for?</DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-2">
        <Card
          icon={<WrenchIcon />}
          title="Tool for your agents"
          detail="Agents run commands and read files here."
          testId="lc-purpose-tool"
          busy={busy === "tool"}
          disabled={busy !== null}
          {...(confirming ? { selected: picked === "tool" } : {})}
          onClick={() => click("tool")}
        />
        <Card
          icon={<LaptopIcon />}
          title="A full computer"
          detail="Start chats on it. The agent runs in your cloud, commands and files here."
          testId="lc-purpose-full"
          busy={busy === "full"}
          disabled={busy !== null}
          {...(confirming ? { selected: picked === "full" } : {})}
          onClick={() => click("full")}
        />
        <p className="mt-1 text-xs text-muted-foreground">You can change this later.</p>
        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </DialogPanel>
      {confirming ? (
        <DialogFooter variant="bare">
          <Button
            disabled={picked === null || busy !== null}
            onClick={() => picked && void choose(picked)}
            data-testid="lc-purpose-continue"
          >
            {busy !== null ? <Loader2Icon className="animate-spin" /> : null}
            Continue
          </Button>
        </DialogFooter>
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

function BringStep() {
  const environmentId = useComputersHostId();
  const computerId = useLifecycle((state) => state.computerId);
  const status = useImportStatus(environmentId, computerId, { watch: true }).data;
  const actions = useImportActions(environmentId, computerId);
  useEffect(() => {
    if (environmentId !== null && computerId !== null) actions.scan().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computerId, environmentId]);
  const work = useComputerWork(computerId, { scan: true });
  const projects = work.status?.scan.projects ?? [];
  const projectsSearching = work.searching;
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
  const anyKeys = pickedProjects.some((project) => project.keys.length > 0);

  const toggle = <T,>(set: ReadonlySet<T>, value: T): ReadonlySet<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  const bring = async () => {
    if (computerId === null) return;
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
      lifecycle.brought({
        chats: chatCount,
        projects: pickedProjects.map((project) => project.name),
        keys: keyCount,
      });
    } catch (cause) {
      setError(errorText(cause, "Couldn’t bring it. Try again."));
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

  return (
    <div className="flex min-h-0 flex-col" data-testid="lc-add-bring">
      <DialogHeader>
        <BackTitle>Bring your work?</BackTitle>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-3">
        <div className="flex flex-col">
          <SectionLabel>Chats</SectionLabel>
          {searching ? (
            <p className="flex items-center gap-2 px-1 py-1.5 text-sm text-muted-foreground">
              <Loader2Icon className="size-3.5 animate-spin" />
              Looking for chats…
            </p>
          ) : tools.length === 0 ? (
            <p className="px-1 py-1.5 text-sm text-muted-foreground">No chats found.</p>
          ) : (
            tools.map((tool) => (
              <ToolRow
                key={tool.id}
                tool={tool}
                on={!untickedTools.has(tool.id)}
                onToggle={() => setUntickedTools((current) => toggle(current, tool.id))}
              />
            ))
          )}
        </div>
        <div className="flex flex-col" data-testid="lc-bring-projects">
          <SectionLabel>Projects</SectionLabel>
          {projectsSearching && projects.length === 0 ? (
            <p className="flex items-center gap-2 px-1 py-1.5 text-sm text-muted-foreground">
              <Loader2Icon className="size-3.5 animate-spin" />
              Looking in ~/projects…
            </p>
          ) : work.status?.scan.state === "failed" || (work.failed && !work.status) ? (
            <p className="px-1 py-1.5 text-sm text-muted-foreground">
              {work.status?.scan.message ?? "Couldn’t look for projects."}
            </p>
          ) : projects.length === 0 ? (
            <p className="px-1 py-1.5 text-sm text-muted-foreground">
              No projects in ~/projects.
            </p>
          ) : (
            projects.map((project) => (
              <ProjectRow
                key={project.path}
                project={project}
                on={isOn(project)}
                offKeys={offKeys.get(project.path) ?? new Set()}
                onToggle={() => setFlipped((current) => toggle(current, project.path))}
                onToggleKey={(key) =>
                  setOffKeys((current) => {
                    const next = new Map(current);
                    next.set(project.path, toggle(current.get(project.path) ?? new Set(), key));
                    return next;
                  })
                }
              />
            ))
          )}
          {anyKeys ? (
            <p
              className="mt-1 flex items-center gap-1.5 px-1 text-xs text-muted-foreground"
              data-testid="lc-keys-note"
            >
              <LockIcon className="size-3 shrink-0" />
              Keys are kept encrypted, never in the project’s files.
            </p>
          ) : null}
        </div>
        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button variant="ghost" onClick={() => lifecycle.brought(null)} data-testid="lc-bring-skip">
          Skip
        </Button>
        <Button
          disabled={busy || label === ""}
          onClick={() => void bring()}
          data-testid="lc-bring-start"
        >
          {busy ? <Loader2Icon className="animate-spin" /> : null}
          {label === "" ? "Bring" : `Bring ${label}`}
        </Button>
      </DialogFooter>
    </div>
  );
}

// ── done ────────────────────────────────────────────────────────────────

function DoneStep() {
  const computerId = useLifecycle((state) => state.computerId);
  const purpose = useLifecycle((state) => state.purposeChosen) ?? "tool";
  const brought = useLifecycle((state) => state.brought);
  const name = useComputerName(computerId);
  // Bringing goes on after the window closes; while it's open, it shows how it went.
  const bring = useComputerWork(brought && brought.projects.length > 0 ? computerId : null).status
    ?.bring;
  const bringing = bring?.state === "running";
  const failed = bring?.results.filter((result) => !result.ok) ?? [];
  return (
    <div className="flex min-h-0 flex-col" data-testid="lc-add-done">
      <DialogHeader>
        <BackTitle>
          <span className="grid size-7 place-items-center rounded-lg bg-emerald-500/12 text-emerald-600 dark:text-emerald-400">
            <CheckIcon className="size-4" />
          </span>
          {name} is ready
        </BackTitle>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-1.5 text-sm">
        <p className="text-muted-foreground">
          {purpose === "full"
            ? `Start a chat “on ${name}” from Home.`
            : "Your agents can use it while it’s on."}
        </p>
        {brought && brought.projects.length > 0 ? (
          <p data-testid="lc-done-projects">
            {brought.projects.join(", ")}
            <span className="text-muted-foreground">
              {bringing ? " · copying…" : " · On all my computers"}
            </span>
          </p>
        ) : null}
        {failed.map((result) => (
          <p key={result.path} role="alert" className="text-destructive">
            {result.name}: {result.message ?? "didn’t come over."}
          </p>
        ))}
        {brought && brought.chats > 0 ? (
          <p className="text-muted-foreground">{chatsLabel(brought.chats)} on their way.</p>
        ) : null}
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button onClick={lifecycle.close} data-testid="lc-done">
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}

/** One for the whole app (mounted in the root, next to "Connect my computer"). */
export function AddComputerWindow() {
  const addOpen = useLifecycle((state) => state.addOpen);
  const step = useLifecycle((state) => state.step);
  const cloudOpen = useLifecycle((state) => state.cloudOpen);
  const customOpen = useLifecycle((state) => state.customOpen);
  return (
    <>
      <Dialog
        open={addOpen}
        onOpenChange={(next) => {
          if (!next) lifecycle.close();
        }}
      >
        <DialogPopup className="max-w-md" data-testid="lc-add-window">
          {step === "choose" ? <ChooseStep /> : null}
          {step === "own" ? <OwnStep /> : null}
          {step === "purpose" ? <PurposeStep /> : null}
          {step === "bring" ? <BringStep /> : null}
          {step === "done" ? <DoneStep /> : null}
        </DialogPopup>
      </Dialog>
      <ThisMacPrompt />
      <AddEnvModal open={cloudOpen} initialStep="uno" onOpenChange={lifecycle.setCloudOpen} />
      <AddEnvModal open={customOpen} initialStep="custom" onOpenChange={lifecycle.setCustomOpen} />
    </>
  );
}
