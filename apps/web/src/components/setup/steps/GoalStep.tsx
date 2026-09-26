/**
 * The first screen in Uno Work (`/setup?step=welcome`), goal first:
 *
 * 1. "What do you want to do?" — my assistant, a website, a Telegram bot,
 *    my own agent, just a server;
 * 2. "How do you want to work?" — Uno AI (default), my Claude/ChatGPT
 *    subscription here, or my agent on my laptop (assistant/site/bot only);
 * 3. the result: Telegram link to the assistant, a live site link, the bot
 *    being built, the line to paste into an agent, SSH.
 *
 * No project names, skills or connectors on the way: the project is made
 * for the goal and named after it, the goal's skills install quietly. The
 * old eight steps stay under Settings → "Full setup".
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { DEFAULT_RUNTIME_MODE } from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BotIcon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  FolderUpIcon,
  GlobeIcon,
  Loader2Icon,
  MessageCircleIcon,
  SparklesIcon,
  TerminalIcon,
  UserRoundIcon,
  WandSparklesIcon,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { getClientSettings, useUpdateSettings } from "../../../hooks/useSettings";
import { useFolderChats, useHomeFolderPath } from "../../../hooks/useFolderChats";
import { ensureEnvironmentApi } from "../../../environmentApi";
import { usePrimaryEnvironmentId } from "../../../environments/primary";
import { trackFunnel } from "../../../lib/funnel";
import { cn } from "../../../lib/utils";
import {
  pickFilesForProjectUpload,
  pickFolderForProjectUpload,
  readDroppedUploadFiles,
} from "../../../projectUploadPickers";
import type { ProjectUploadFile } from "../../../projectUpload";
import { useServerConfig } from "../../../rpc/serverState";
import { useAssistantChat } from "../../../assistant/useAssistantChat";
import { useHomeLaunchers } from "../../computer/useHomeLaunchers";
import { openInstallDocs } from "../../onboarding/harnessInstallLinks";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";
import {
  GOAL_COPY,
  GOAL_PATH_KEY,
  GOAL_PROJECT,
  GOAL_PROJECT_KEY,
  GOAL_SKILLS,
  GOALS,
  FIRST_RESULT_KEY,
  NEXT_STEP,
  goalAgentsMd,
  goalAsksHow,
  goalFirstPrompt,
  impliedConnectPath,
  withAnswer,
  withGoal,
  type ConnectPath,
  type GoalId,
} from "../goals";
import { AgentTab, SshTab } from "../OwnToolsDialog";
import { installSkill } from "../setupSkills";
import { SetupFrame } from "../SetupShell";
import { NoIndexHtmlError, droppedName, uploadAndPublishSite } from "../siteUpload";
import { useSetupNavigation } from "../useSetupNavigation";
import { useUpdateSetupProgress } from "../useSetupProgress";
import { AssistantTelegramPanel } from "./ChannelsStep";

const GOAL_ICON: Readonly<Record<GoalId, LucideIcon>> = {
  assistant: UserRoundIcon,
  site: GlobeIcon,
  bot: BotIcon,
  own_agent: SparklesIcon,
  server: TerminalIcon,
};

// ── shared plumbing ────────────────────────────────────────────────────

/** Onboarding is over once a goal is picked: here and on the machine. */
function useGoalActions() {
  const { updateSettings } = useUpdateSettings();
  const update = useUpdateSetupProgress();
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();

  const pickGoal = useCallback(
    async (goal: GoalId) => {
      trackFunnel("onboarding_goal_selected", { goal });
      await updateSettings({ onboardingCompleted: true, machineOnboarded: true });
      await update((current) => withGoal(current, goal));
      if (environmentId) {
        // The goal's skills, quietly; an older daemon without them just says no.
        for (const id of GOAL_SKILLS[goal]) {
          void installSkill(environmentId, id).catch(() => undefined);
        }
      }
      const implied = impliedConnectPath(goal);
      if (implied) {
        trackFunnel("connect_path", { goal, path: implied });
        await update((current) => withAnswer(current, GOAL_PATH_KEY, implied));
      }
      void navigate({
        to: "/setup",
        search: { step: "welcome", goal, ...(implied ? { via: implied } : {}) },
      });
    },
    [environmentId, navigate, update, updateSettings],
  );

  const pickPath = useCallback(
    async (goal: GoalId, path: ConnectPath) => {
      trackFunnel("connect_path", { goal, path });
      await update((current) => withAnswer(current, GOAL_PATH_KEY, path));
      // Signing in to Claude / ChatGPT is the AI step; it comes back here.
      if (path === "own_subscription") {
        void navigate({ to: "/setup", search: { step: "ai" } });
        return;
      }
      void navigate({ to: "/setup", search: { step: "welcome", goal, via: path } });
    },
    [navigate, update],
  );

  const recordFirstResult = useCallback(
    (goal: GoalId, props: Readonly<Record<string, string | number | boolean>> = {}) => {
      trackFunnel("first_result", { goal, props });
      void update((current) =>
        current.answers[FIRST_RESULT_KEY]
          ? current
          : withAnswer(current, FIRST_RESULT_KEY, new Date().toISOString()),
      );
    },
    [update],
  );

  return { pickGoal, pickPath, recordFirstResult };
}

/** The goal's own folder in the home folder: my-website, my-website-2, … */
async function freeFolder(
  environmentId: EnvironmentId,
  home: string,
  slug: string,
): Promise<string> {
  const listing = await ensureEnvironmentApi(environmentId)
    .filesystem.browse({ partialPath: `${home}/` })
    .catch(() => null);
  const taken = new Set(listing?.entries.map((entry) => entry.name) ?? []);
  let name = slug;
  for (let n = 2; taken.has(name) && n < 100; n += 1) name = `${slug}-${n}`;
  return `${home.replace(/\/+$/, "")}/${name}`;
}

/** Makes the goal's project (folder, AGENTS.md) and remembers it. */
function useGoalProject(goal: GoalId) {
  const environmentId = usePrimaryEnvironmentId();
  const home = useHomeFolderPath(environmentId);
  const { ensureFolderProject } = useFolderChats(environmentId);
  const update = useUpdateSetupProgress();
  const made = useRef<string | null>(null);

  return useCallback(async (): Promise<string> => {
    if (made.current) return made.current;
    const spec = GOAL_PROJECT[goal];
    if (!environmentId || !home || !spec) throw new Error("Your computer isn't ready yet.");
    const folder = await freeFolder(environmentId, home, spec.slug);
    const ref = await ensureFolderProject(folder, spec.name, {
      createFolder: true,
      defaultModelSelection: null,
    });
    await ensureEnvironmentApi(environmentId)
      .projects.writeFile({
        cwd: folder,
        relativePath: "AGENTS.md",
        contents: goalAgentsMd(goal, spec.name),
      })
      .catch(() => undefined);
    await update((current) => ({
      ...withAnswer(current, GOAL_PROJECT_KEY, folder),
      project: { id: ref.projectId, path: folder, name: spec.name, kind: spec.kind },
    }));
    made.current = folder;
    return folder;
  }, [ensureFolderProject, environmentId, goal, home, update]);
}

// ── layout bits ────────────────────────────────────────────────────────

function Page({
  title,
  lead,
  onBack,
  children,
  footer,
}: {
  title: string;
  lead?: ReactNode;
  onBack?: (() => void) | undefined;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { goHome } = useSetupNavigation();
  return (
    <SetupFrame
      title="Start"
      icon={false}
      progress={null}
      headerAction={
        <Button size="xs" variant="ghost" onClick={goHome} data-testid="goal-home">
          Go to Home
        </Button>
      }
      footer={footer}
    >
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-5 pt-10 pb-12 sm:px-8 sm:pt-14">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeftIcon className="size-3.5" />
            Back
          </button>
        ) : null}
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight" data-testid="goal-title">
            {title}
          </h1>
          {lead ? <p className="text-base text-muted-foreground">{lead}</p> : null}
        </div>
        {children}
      </div>
    </SetupFrame>
  );
}

function BigChoice({
  icon: Icon,
  title,
  sub,
  onClick,
  recommended,
  disabled,
  testId,
}: {
  icon: LucideIcon;
  title: string;
  sub: string;
  onClick: () => void;
  recommended?: boolean;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={cn(
        "group flex w-full items-center gap-4 rounded-2xl border bg-card px-4 py-4 text-left transition-colors hover:border-primary/60 hover:bg-primary/[0.03] disabled:opacity-60",
        recommended ? "border-primary/50" : "border-border",
      )}
    >
      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Icon className="size-5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-base font-medium">
          {title}
          {recommended ? (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
              Recommended
            </span>
          ) : null}
        </span>
        <span className="text-sm text-muted-foreground">{sub}</span>
      </span>
      <ArrowRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

function NextStepCard({ goal, onClick }: { goal: GoalId; onClick?: () => void }) {
  const idea = NEXT_STEP[goal];
  useEffect(() => {
    trackFunnel("next_step_shown", { goal });
  }, [goal]);
  return (
    <div
      className="flex flex-col gap-3 rounded-2xl border border-dashed border-primary/40 bg-primary/[0.03] p-4 sm:flex-row sm:items-center"
      data-testid="goal-next-step"
    >
      <WandSparklesIcon className="size-5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1 text-sm">
        <div className="font-medium">Next step</div>
        <div className="text-muted-foreground">{idea.title}</div>
      </div>
      {onClick ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            trackFunnel("next_step_clicked", { goal });
            onClick();
          }}
        >
          Do it
        </Button>
      ) : null}
    </div>
  );
}

// ── screen 1 ───────────────────────────────────────────────────────────

function GoalPicker() {
  const { pickGoal } = useGoalActions();
  const [busy, setBusy] = useState<GoalId | null>(null);
  const { goHome } = useSetupNavigation();
  const { updateSettings } = useUpdateSettings();

  // The same computer already set up elsewhere goes straight in.
  const machineOnboarded = useServerConfig()?.settings.machineOnboarded === true;
  const decided = useRef(getClientSettings().onboardingCompleted);
  useEffect(() => {
    if (!machineOnboarded || decided.current) return;
    decided.current = true;
    void updateSettings({ onboardingCompleted: true });
    goHome();
  }, [machineOnboarded, goHome, updateSettings]);

  return (
    <Page
      title="What do you want to do?"
      lead="Pick one. Uno sets it up. You can do everything else later."
    >
      <div className="flex flex-col gap-3" role="list">
        {GOALS.map((goal) => (
          <BigChoice
            key={goal}
            icon={GOAL_ICON[goal]}
            title={GOAL_COPY[goal].title}
            sub={GOAL_COPY[goal].sub}
            disabled={busy !== null}
            testId={`goal-${goal}`}
            onClick={() => {
              decided.current = true;
              setBusy(goal);
              void pickGoal(goal).finally(() => setBusy(null));
            }}
          />
        ))}
      </div>
    </Page>
  );
}

// ── screen 2 ───────────────────────────────────────────────────────────

function HowPicker({ goal }: { goal: GoalId }) {
  const { pickPath } = useGoalActions();
  const navigate = useNavigate();
  const doer = goal === "assistant" ? "Your assistant runs on" : "Uno does it with";
  return (
    <Page
      title="How do you want to work?"
      lead={`${GOAL_COPY[goal].title}. ${doer} Uno AI unless you pick your own.`}
      onBack={() => void navigate({ to: "/setup", search: { step: "welcome" } })}
    >
      <div className="flex flex-col gap-3">
        <BigChoice
          icon={SparklesIcon}
          title="Uno AI"
          sub="Included in your plan. Nothing to set up."
          recommended
          testId="how-uno-ai"
          onClick={() => void pickPath(goal, "uno_ai")}
        />
        <BigChoice
          icon={UserRoundIcon}
          title="My Claude or ChatGPT subscription"
          sub="Sign in once. The work runs here on your plan."
          testId="how-own-subscription"
          onClick={() => void pickPath(goal, "own_subscription")}
        />
        <BigChoice
          icon={TerminalIcon}
          title="My agent on my laptop"
          sub="Claude Code, Codex or Cursor gets this computer. One line to paste."
          testId="how-own-agent"
          onClick={() => void pickPath(goal, "own_agent")}
        />
      </div>
    </Page>
  );
}

// ── screen 3: results ──────────────────────────────────────────────────

function AssistantResult() {
  const { recordFirstResult } = useGoalActions();
  const assistant = useAssistantChat();
  const launchers = useHomeLaunchers(usePrimaryEnvironmentId());
  const [connected, setConnected] = useState(false);
  const { goHome } = useSetupNavigation();
  return (
    <Page
      title="Your assistant is already on"
      lead="Its name is Uno. Open Telegram, press Start and say hi. It answers there, day and night, even when your laptop is closed."
      footer={
        <>
          <span className="flex-1" />
          <Button size="sm" variant={connected ? "default" : "outline"} onClick={goHome}>
            Go to Home
          </Button>
        </>
      }
    >
      <div className="rounded-2xl border border-border p-4" data-testid="goal-assistant-telegram">
        <AssistantTelegramPanel
          onConnected={(username) => {
            setConnected(true);
            recordFirstResult("assistant", { via: "telegram", bot: username ?? "" });
          }}
        />
      </div>
      <button
        type="button"
        className="flex items-center gap-1.5 self-start text-sm text-primary hover:underline"
        onClick={() => void assistant.open()}
      >
        <MessageCircleIcon className="size-4" />
        Or talk to it here
      </button>
      {connected ? (
        <NextStepCard
          goal="assistant"
          onClick={() => void launchers.askUno(NEXT_STEP.assistant.prompt)}
        />
      ) : null}
    </Page>
  );
}

type SitePhase =
  | { kind: "idle" }
  | { kind: "uploading"; done: number; total: number }
  | { kind: "publishing" }
  | { kind: "done"; url: string; seconds: number }
  | { kind: "no-index"; folder: string }
  | { kind: "error"; message: string };

function SiteResult() {
  const environmentId = usePrimaryEnvironmentId();
  const makeProject = useGoalProject("site");
  const launchers = useHomeLaunchers(environmentId);
  const { recordFirstResult } = useGoalActions();
  const [phase, setPhase] = useState<SitePhase>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const [description, setDescription] = useState("");
  const [starting, setStarting] = useState(false);
  const [copied, setCopied] = useState(false);
  const projectFolder = useRef<string | null>(null);
  const busy = phase.kind === "uploading" || phase.kind === "publishing" || starting;

  const publish = async (files: ProjectUploadFile[]) => {
    if (!environmentId || files.length === 0 || busy) return;
    setPhase({ kind: "uploading", done: 0, total: files.length });
    try {
      const folder = await makeProject();
      projectFolder.current = folder;
      const result = await uploadAndPublishSite({
        environmentId,
        projectPath: folder,
        files,
        name: droppedName(files),
        onPhase: (next, done, total) =>
          setPhase(
            next === "publishing"
              ? { kind: "publishing" }
              : { kind: "uploading", done: done ?? 0, total: total ?? files.length },
          ),
      });
      setPhase({ kind: "done", url: result.url, seconds: result.seconds });
      recordFirstResult("site", { via: "upload", seconds: result.seconds });
    } catch (cause) {
      if (cause instanceof NoIndexHtmlError && projectFolder.current) {
        setPhase({ kind: "no-index", folder: `${projectFolder.current}/site` });
        return;
      }
      setPhase({
        kind: "error",
        message: cause instanceof Error ? cause.message : "Couldn't publish the site.",
      });
    }
  };

  const askUno = async (prompt: string) => {
    if (starting) return;
    setStarting(true);
    try {
      const folder = projectFolder.current ?? (await makeProject());
      projectFolder.current = folder;
      await launchers.startTask(prompt, {
        folder,
        modelSelection: null,
        runtimeMode: DEFAULT_RUNTIME_MODE,
      });
    } catch (cause) {
      setPhase({
        kind: "error",
        message: cause instanceof Error ? cause.message : "Couldn't start Uno.",
      });
    } finally {
      setStarting(false);
    }
  };

  if (phase.kind === "done") {
    return (
      <Page
        title="Your site is online"
        lead={`Published in ${phase.seconds} s. Anyone with the link can open it.`}
      >
        <div
          className="flex flex-col gap-3 rounded-2xl border border-success/40 bg-success/[0.06] p-4"
          data-testid="goal-site-live"
        >
          <a
            href={phase.url}
            target="_blank"
            rel="noreferrer"
            className="truncate text-lg font-medium text-foreground hover:underline"
          >
            {phase.url.replace(/^https:\/\//, "").replace(/\/$/, "")}
          </a>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => openInstallDocs(phase.url)}>
              <ExternalLinkIcon className="size-3.5" />
              Open
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void navigator.clipboard?.writeText(phase.url).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                })
              }
            >
              {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
              {copied ? "Copied" : "Copy link"}
            </Button>
          </div>
        </div>
        <NextStepCard goal="site" onClick={() => void askUno(NEXT_STEP.site.prompt)} />
      </Page>
    );
  }

  return (
    <Page
      title="Put your site online"
      lead="Drop the folder or the .zip with your site. You get a link in seconds. No GitHub, no settings."
    >
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void readDroppedUploadFiles(event.dataTransfer).then(publish);
        }}
        className={cn(
          "flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors",
          dragging ? "border-primary bg-primary/[0.05]" : "border-border",
        )}
        data-testid="goal-site-drop"
      >
        {phase.kind === "uploading" || phase.kind === "publishing" ? (
          <div className="flex items-center gap-2 text-sm">
            <Loader2Icon className="size-4 animate-spin" />
            {phase.kind === "uploading"
              ? `Uploading ${phase.done} of ${phase.total} files…`
              : "Publishing…"}
          </div>
        ) : (
          <>
            <FolderUpIcon className="size-8 text-muted-foreground" />
            <div className="text-sm font-medium">Drop a folder or a .zip here</div>
            <div className="flex flex-wrap justify-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => pickFolderForProjectUpload((files) => void publish(files))}
              >
                Choose a folder
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => pickFilesForProjectUpload((files) => void publish(files))}
              >
                Choose a .zip
              </Button>
            </div>
            <div className="text-xs text-muted-foreground">
              It needs an index.html. Up to 50 MB.
            </div>
          </>
        )}
      </div>
      {phase.kind === "no-index" ? (
        <div className="flex flex-col gap-2 rounded-xl bg-muted/50 p-3 text-sm">
          <span>There's no index.html in these files, so there's no home page yet.</span>
          <Button
            size="sm"
            className="self-start"
            disabled={starting}
            onClick={() => void askUno(goalFirstPrompt("site", { folder: phase.folder }))}
          >
            Let Uno make it a site
          </Button>
        </div>
      ) : null}
      {phase.kind === "error" ? (
        <p className="text-sm text-destructive-foreground" data-testid="goal-site-error">
          {phase.message}
        </p>
      ) : null}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or describe it
        <span className="h-px flex-1 bg-border" />
      </div>
      <div className="flex flex-col gap-2">
        <Textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="A page for my yoga classes: the schedule, prices and a way to sign up"
          rows={3}
          data-testid="goal-site-describe"
        />
        <Button
          className="self-start"
          disabled={busy || !description.trim()}
          onClick={() => void askUno(goalFirstPrompt("site", { description }))}
          data-testid="goal-site-make"
        >
          {starting ? <Loader2Icon className="size-4 animate-spin" /> : null}
          Make my site
        </Button>
        <p className="text-xs text-muted-foreground">
          Uno asks a couple of questions, makes the page and sends you the link.
        </p>
      </div>
    </Page>
  );
}

function BotResult() {
  const environmentId = usePrimaryEnvironmentId();
  const makeProject = useGoalProject("bot");
  const launchers = useHomeLaunchers(environmentId);
  const [token, setToken] = useState("");
  const [description, setDescription] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tokenOk = /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token.trim());

  const start = async () => {
    if (!environmentId || starting) return;
    if (!tokenOk) {
      setError("That doesn't look like a bot token. It looks like 123456789:AAE…");
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const folder = await makeProject();
      const api = ensureEnvironmentApi(environmentId);
      await api.projects.writeFile({
        cwd: folder,
        relativePath: ".env",
        contents: `TELEGRAM_BOT_TOKEN=${token.trim()}\n`,
      });
      await api.projects.writeFile({
        cwd: folder,
        relativePath: ".gitignore",
        contents: ".env\nnode_modules/\n__pycache__/\n",
      });
      await launchers.startTask(goalFirstPrompt("bot", { description }), {
        folder,
        modelSelection: null,
        runtimeMode: DEFAULT_RUNTIME_MODE,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't start Uno.");
    } finally {
      setStarting(false);
    }
  };

  return (
    <Page
      title="Make your Telegram bot"
      lead="Two things from you: the bot's token and what it should do. Uno builds it and keeps it running 24/7."
    >
      <div className="flex flex-col gap-2 rounded-2xl border border-border p-4">
        <div className="text-sm font-medium">1. Get a token from @BotFather</div>
        <ol className="list-inside list-decimal text-sm text-muted-foreground">
          <li>Open @BotFather in Telegram.</li>
          <li>Send /newbot and pick a name.</li>
          <li>Copy the token it sends back.</li>
        </ol>
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          onClick={() => openInstallDocs("https://t.me/BotFather")}
        >
          <ExternalLinkIcon className="size-3.5" />
          Open @BotFather
        </Button>
        <Input
          type="password"
          autoComplete="off"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="Paste the token: 123456789:AAE…"
          data-testid="goal-bot-token"
        />
        <p className="text-xs text-muted-foreground">
          It stays on your computer in a .env file. Uno never shows it in the chat.
        </p>
      </div>
      <div className="flex flex-col gap-2 rounded-2xl border border-border p-4">
        <div className="text-sm font-medium">2. What should the bot do?</div>
        <Textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={3}
          placeholder="Take cake orders for my bakery: ask for the cake, the date and a phone number, then send the order to me."
          data-testid="goal-bot-describe"
        />
      </div>
      {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
      <Button
        className="self-start"
        disabled={starting || !token.trim() || !description.trim()}
        onClick={() => void start()}
        data-testid="goal-bot-make"
      >
        {starting ? <Loader2Icon className="size-4 animate-spin" /> : null}
        Make my bot
      </Button>
    </Page>
  );
}

function OwnAgentResult({ goal }: { goal: GoalId }) {
  const navigate = useNavigate();
  const followUp =
    goal === "site"
      ? "Then ask it: “Publish my website on this computer and send me the link.”"
      : goal === "bot"
        ? "Then ask it: “Make my Telegram bot on this computer and keep it running.”"
        : goal === "assistant"
          ? "Then ask it: “Set up an always-on assistant on this computer.”"
          : "Then give it any task. It works here even when your laptop is closed.";
  return (
    <Page
      title="Give this computer to your agent"
      lead="Paste one line where your agent lives. It gets this computer as a tool: commands, files, publishing sites."
      onBack={
        goal === "own_agent"
          ? () => void navigate({ to: "/setup", search: { step: "welcome" } })
          : undefined
      }
    >
      <div className="rounded-2xl border border-border p-4" data-testid="goal-own-agent">
        <AgentTab />
      </div>
      <p className="text-sm text-muted-foreground">{followUp}</p>
      <button
        type="button"
        className="self-start text-xs text-primary hover:underline"
        onClick={() =>
          void navigate({ to: "/setup", search: { step: "welcome", goal: "server", via: "ssh" } })
        }
      >
        Prefer SSH?
      </button>
    </Page>
  );
}

function ServerResult() {
  const environmentId = usePrimaryEnvironmentId();
  const launchers = useHomeLaunchers(environmentId);
  const { recordFirstResult } = useGoalActions();
  return (
    <Page
      title="Your server is ready"
      lead="A clean Linux computer in the cloud, always on. Add your SSH key or open the terminal right here."
    >
      <div className="rounded-2xl border border-border p-4" data-testid="goal-server-ssh">
        <SshTab />
      </div>
      <Button
        variant="outline"
        className="self-start"
        onClick={() => {
          recordFirstResult("server", { via: "terminal" });
          void launchers.openTerminal();
        }}
      >
        <TerminalIcon className="size-4" />
        Open the terminal
      </Button>
    </Page>
  );
}

// ── the route ──────────────────────────────────────────────────────────

export function GoalStep() {
  const search = useSearch({ from: "/_chat/setup" });
  const goal = search.goal ?? null;
  const via = search.via ?? null;
  if (!goal) return <GoalPicker />;
  if (goalAsksHow(goal) && !via) return <HowPicker goal={goal} />;
  if (via === "own_agent" || goal === "own_agent") return <OwnAgentResult goal={goal} />;
  if (goal === "server") return <ServerResult />;
  if (goal === "assistant") return <AssistantResult />;
  if (goal === "site") return <SiteResult />;
  return <BotResult />;
}
