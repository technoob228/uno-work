/**
 * Variant D (28.10): a new persona, the way Grok makes companions — Misha
 * 27.10: "name, personality and role set like in the Grok bot".
 *
 * 1. A gallery of three roles (Misha 28.10 evening): Developer, Accounts
 *    manager, Helper — each with its default character. The role is the
 *    choice of what it does.
 * 2. Make it yours: face (emoji / a drawn portrait / a picture), name,
 *    character with sliders and tags (never a prompt).
 * 3. Where it works (this computer, another computer of the account, a new
 *    one), what it thinks with (the one AI picker), where it can look (a
 *    project limit is a real lock only where its commands run in a sandbox)
 *    and its mode — "Autonomous" / "Cautious".
 * 4. What should it do? — what its role needs (`PersonaJob.tsx`), and when
 *    it starts: only when you ask (default) or now. Create.
 * 5. Where you talk: its own Telegram bot, Slack, or here (Uno's shared bot
 *    is Uno's only, Misha 28.10). Then its chat, with the first message made
 *    from the answers — it hands the work to chats on your computers.
 */
import {
  type AssistantPersona,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ImageUpIcon,
  LoaderCircleIcon,
  MessageCircleIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { waitForThreadInStore } from "../../assistant/useAssistantChat";
import { useMachineRows } from "../../hooks/useMachineRows";
import {
  createAssistant,
  ensureAssistantChat,
  generateAssistantAvatar,
  putAssistantApps,
  setAssistantAvatar,
  setAssistantPreset,
  updateAssistantTeam,
} from "../../lib/managerApi";
import { cn } from "../../lib/utils";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { buildThreadRouteParams } from "../../threadRoutes";
import { SlackBrandMark, TelegramMark } from "../setup/brandMarks";
import { AssistantSlackPanel, AssistantTelegramPanel } from "../setup/steps/ChannelsStep";
import { SidebarShowButton } from "../sidebar/SidebarShowButton";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { useAccountHomeEnvironmentId } from "./accountUno";
import { AssistantAiChoice } from "./AssistantAiChoice";
import { AssistantAvatar } from "./AssistantAvatar";
import { readFile, squarePicture } from "./AssistantFacePicker";
import { avatarFileProblem, base64OfDataUrl, PERSONAS } from "./assistantAvatar.logic";
import {
  JOB_COPY,
  type JobDraft,
  dutyOf,
  emptyJob,
  firstMessageOf,
  jobOf,
  jobProblem,
} from "./assistantJob.logic";
import { sendFirstMessage } from "./assistantStart";
import type { AvatarTone } from "./assistantTeam.logic";
import { ASSISTANT_NAME_MAX } from "./assistantEntity";
import { PersonaJob, useJobTools } from "./PersonaJob";
import type { AssistantMode } from "./PersonaMode";
import { Chip, Label, ModeCard, ModePicker, WhereItLooks, WhereItWorks } from "./PersonaParts";
import {
  GALLERY,
  type GalleryPersona,
  MAX_TAGS,
  QUICK_FACES,
  SLIDERS,
  TAGS,
  characterLine,
  isAsleep,
  nameProblem,
  toggleTag,
} from "./personaChannels";
import { useAssistantTeam } from "./useAssistantTeam";
import { LOCAL_ASSISTANTS_KEY } from "./useAssistants";

type FaceTab = "emoji" | "portrait" | "upload";

/** Where the personas live by default: the account's home computer, next to Uno. */
function usePersonaHome(): { environmentId: EnvironmentId | null; label: string } {
  const environmentId = useAccountHomeEnvironmentId();
  const rows = useMachineRows();
  return {
    environmentId,
    label: rows.find((row) => row.environmentId === environmentId)?.label ?? "your cloud computer",
  };
}

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

async function waitForProject(environmentId: string, projectId: string) {
  const here = () =>
    selectProjectsAcrossEnvironments(useStore.getState()).some(
      (project) => project.environmentId === environmentId && project.id === projectId,
    );
  for (let tries = 0; tries < 50 && !here(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// ── Step 1: the gallery ──────────────────────────────────────────────────

function GalleryCard(props: { readonly persona: GalleryPersona; readonly onPick: () => void }) {
  const { persona } = props;
  return (
    <button
      type="button"
      onClick={props.onPick}
      data-testid={`persona-card-${persona.id}`}
      className="flex cursor-pointer flex-col gap-3 rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/50 hover:bg-primary/[0.03] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
    >
      <span className="flex items-center gap-3">
        <AssistantAvatar
          emoji={persona.emoji}
          tone={persona.tone}
          className="size-11"
          emojiClassName="text-2xl"
        />
        <span className="min-w-0">
          <span className="block text-[15px] font-semibold">{persona.name}</span>
          <span className="block text-xs font-medium text-primary">{persona.role}</span>
        </span>
      </span>
      <span className="text-xs leading-snug text-muted-foreground">
        {JOB_COPY[persona.job].line}
      </span>
      <span className="text-[13px] leading-snug text-foreground/80 italic">“{persona.quote}”</span>
      <span className="mt-auto flex flex-wrap gap-1">
        {persona.tags.map((tag) => (
          <span
            key={tag}
            className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground"
          >
            {tag}
          </span>
        ))}
      </span>
    </button>
  );
}

function Gallery(props: { readonly onPick: (persona: GalleryPersona) => void }) {
  return (
    <div className="flex flex-col gap-5" data-testid="persona-gallery">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Who do you need?</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick a role. Its name, face and character are yours to change next.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {GALLERY.map((persona) => (
          <GalleryCard key={persona.id} persona={persona} onPick={() => props.onPick(persona)} />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Every helper works next to Uno and shares its memory. Each has its own face, role, mode and
        channel — and hands the work to chats on your computers.
      </p>
    </div>
  );
}

// ── Step 2: the face ─────────────────────────────────────────────────────

interface FaceState {
  readonly emoji: string;
  readonly tone: AvatarTone;
  /** A drawn portrait or an uploaded picture (a data URL), over the emoji. */
  readonly picture: string | null;
}

function FacePicker(props: {
  readonly face: FaceState;
  readonly onChange: (face: FaceState) => void;
  readonly environmentId: EnvironmentId | null;
  /** After the first step: just the face. */
  readonly readOnly?: boolean;
}) {
  const { face } = props;
  const [tab, setTab] = useState<FaceTab>("emoji");
  const [kind, setKind] = useState<AssistantPersona | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const draw = async (next: AssistantPersona) => {
    if (!props.environmentId) return;
    setKind(next);
    setDrawing(true);
    setProblem(null);
    try {
      const { image } = await generateAssistantAvatar({
        environmentId: props.environmentId,
        projectId: "assistant-draft",
        persona: next,
        seed: Math.floor(Math.random() * 1000),
      });
      props.onChange({ ...face, picture: await squarePicture(image) });
    } catch (cause) {
      setTab("emoji");
      setKind(null);
      setProblem(
        `Couldn't draw a portrait — ${errorText(cause, "Uno AI didn't answer")}. Your emoji stays; try again later.`,
      );
    } finally {
      setDrawing(false);
    }
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    const wrong = avatarFileProblem(file);
    if (wrong) {
      setProblem(wrong);
      return;
    }
    setProblem(null);
    try {
      props.onChange({ ...face, picture: await squarePicture(await readFile(file)) });
    } catch (cause) {
      setProblem(errorText(cause, "Couldn't open that picture."));
    }
  };

  if (props.readOnly) {
    return (
      <div className="flex flex-col items-center gap-3" data-testid="persona-face">
        <AssistantAvatar
          emoji={face.emoji}
          tone={face.tone}
          src={face.picture}
          className="size-24"
          emojiClassName="text-5xl"
        />
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-3" data-testid="persona-face">
      <span className="relative">
        <AssistantAvatar
          emoji={face.emoji}
          tone={face.tone}
          src={face.picture}
          className="size-24"
          emojiClassName="text-5xl"
        />
        {drawing ? (
          <span className="absolute inset-0 grid place-items-center rounded-full bg-background/60">
            <LoaderCircleIcon className="size-6 animate-spin text-primary" />
          </span>
        ) : null}
      </span>
      <div className="flex rounded-lg border border-border p-0.5 text-xs">
        {(
          [
            ["emoji", "Emoji"],
            ["portrait", "Portrait"],
            ["upload", "Upload"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              setTab(id);
              setProblem(null);
            }}
            data-testid={`persona-face-tab-${id}`}
            className={cn(
              "cursor-pointer rounded-md px-2.5 py-1",
              tab === id ? "bg-accent font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "emoji" ? (
        <div className="grid grid-cols-5 gap-1">
          {QUICK_FACES.map((item) => (
            <button
              key={item.emoji}
              type="button"
              onClick={() => props.onChange({ emoji: item.emoji, tone: item.tone, picture: null })}
              aria-label={`Face ${item.emoji}`}
              className={cn(
                "grid size-8 cursor-pointer place-items-center rounded-lg text-lg hover:bg-accent",
                face.picture === null &&
                  face.emoji === item.emoji &&
                  "bg-primary/10 ring-1 ring-primary",
              )}
            >
              {item.emoji}
            </button>
          ))}
        </div>
      ) : tab === "portrait" ? (
        <div className="flex w-full flex-col items-center gap-2">
          <div className="grid grid-cols-2 gap-1">
            {PERSONAS.map((item) => (
              <button
                key={item.id}
                type="button"
                disabled={drawing}
                onClick={() => void draw(item.id)}
                data-testid={`persona-draw-${item.id}`}
                className={cn(
                  "flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-60",
                  kind === item.id && "border-primary text-primary",
                )}
              >
                <span>{item.emoji}</span>
                {item.label}
              </button>
            ))}
          </div>
          {kind && !drawing ? (
            <button
              type="button"
              onClick={() => void draw(kind)}
              className="inline-flex cursor-pointer items-center gap-1 text-xs text-primary hover:underline"
            >
              <RefreshCwIcon className="size-3" /> Another one
            </button>
          ) : (
            <span className="text-center text-[11px] text-muted-foreground">
              Uno AI draws one in a few seconds.
            </span>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-1">
          <Button size="xs" variant="outline" onClick={() => fileInput.current?.click()}>
            <ImageUpIcon className="size-3.5" /> Pick a picture
          </Button>
          <span className="text-[11px] text-muted-foreground">PNG, JPG or WebP, up to 2 MB</span>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(event) => void upload(event.target.files?.[0])}
          />
        </div>
      )}
      {face.picture ? (
        <button
          type="button"
          onClick={() => props.onChange({ ...face, picture: null })}
          className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground"
        >
          Use the emoji instead
        </button>
      ) : null}
      {problem ? (
        <p
          className="max-w-56 text-center text-xs leading-snug text-destructive"
          role="alert"
          data-testid="persona-face-problem"
        >
          {problem}
        </p>
      ) : null}
    </div>
  );
}

// ── Steps 2–5 ────────────────────────────────────────────────────────────

type Step = "who" | "setup" | "job" | "channel";
const STEP_NUMBER: Record<Step, number> = { who: 2, setup: 3, job: 4, channel: 5 };

interface Made {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
  /** The first message from the answers (null: no job — it greets by itself). */
  readonly text: string | null;
}

type Talk = "here" | "telegram" | "slack";

function Channel(props: {
  readonly name: string;
  readonly made: Made;
  readonly busy: boolean;
  readonly onOpen: () => void;
}) {
  const { made } = props;
  const [talk, setTalk] = useState<Talk>("here");
  return (
    <div className="flex flex-col gap-5" data-testid="persona-channel">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Where do you talk to {props.name}?</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Here in Uno Work always. Add its own Telegram bot or Slack for when you're away.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <ModeCard
          on={talk === "here"}
          onClick={() => setTalk("here")}
          title={
            <>
              <MessageCircleIcon className="size-4 text-primary" /> Here in Uno Work
            </>
          }
          line="Its chat in the sidebar."
          testId="persona-channel-here"
        />
        <ModeCard
          on={talk === "telegram"}
          onClick={() => setTalk("telegram")}
          title={
            <>
              <TelegramMark className="size-4" /> Its own Telegram bot
            </>
          }
          line="Make a bot in @BotFather, paste its token."
          testId="persona-channel-telegram"
        />
        <ModeCard
          on={talk === "slack"}
          onClick={() => setTalk("slack")}
          title={
            <>
              <SlackBrandMark className="size-4" /> Slack
            </>
          }
          line="Mention it in your workspace."
          testId="persona-channel-slack"
        />
      </div>
      {talk === "telegram" ? (
        <div className="rounded-xl border border-border p-4">
          <AssistantTelegramPanel
            environmentId={made.environmentId}
            projectId={made.projectId as ProjectId}
            initialMode="own"
          />
        </div>
      ) : talk === "slack" ? (
        <div className="rounded-xl border border-border p-4">
          <AssistantSlackPanel
            environmentId={made.environmentId}
            projectId={made.projectId as ProjectId}
          />
        </div>
      ) : null}
      {made.text ? (
        <div className="flex flex-col gap-1" data-testid="persona-first-message">
          <span className="text-xs font-medium text-muted-foreground">
            It starts with this message from you
          </span>
          <p className="max-h-40 overflow-y-auto rounded-xl border border-border bg-muted/30 px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap">
            {made.text}
          </p>
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <Button onClick={props.onOpen} disabled={props.busy} data-testid="persona-open">
          {props.busy ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}
          Open {props.name}'s chat
        </Button>
        {talk !== "here" ? (
          <span className="text-xs text-muted-foreground">You can link it later on its page.</span>
        ) : null}
      </div>
    </div>
  );
}

function MakeItYours(props: { readonly start: GalleryPersona; readonly onBack: () => void }) {
  const { start } = props;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const team = useAssistantTeam();
  const home = usePersonaHome();
  const rows = useMachineRows();
  const [step, setStep] = useState<Step>("who");
  const [name, setName] = useState(start.name);
  const [tags, setTags] = useState<ReadonlyArray<string>>(start.tags);
  const [sliders, setSliders] = useState<[number, number, number]>([...start.sliders]);
  const [face, setFace] = useState<FaceState>({
    emoji: start.emoji,
    tone: start.tone,
    picture: null,
  });
  const [mode, setMode] = useState<AssistantMode>("asks-first");
  /** undefined: its home (the cloud computer); null: a computer of its own (made first). */
  const [where, setWhere] = useState<string | null | undefined>(undefined);
  const [limited, setLimited] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [job, setJob] = useState<JobDraft>(() => emptyJob(start.job));
  const [made, setMade] = useState<Made | null>(null);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);

  const environmentId = where === undefined ? home.environmentId : where;
  const row = rows.find((item) => item.environmentId === environmentId);
  const computer = row?.label ?? home.label;
  const asleep = row ? isAsleep(row.status) : false;
  const tools = useJobTools(environmentId);

  const taken = useMemo(
    () => team.filter((member) => !member.revoked).map((member) => member.profile.name),
    [team],
  );
  const problem = nameProblem(name, taken);
  const finalRole = start.role;
  const shown = name.trim() || "your helper";
  const whereProblem =
    environmentId === null
      ? "Create its computer above, or pick one."
      : asleep
        ? `${computer} is asleep — wake it first, or pick another computer.`
        : null;
  const doProblem = environmentId === null ? null : jobProblem(job, { environmentId, computer });

  const next = () => {
    if (step === "who") {
      setTried(true);
      if (problem) return;
      setStep("setup");
    } else if (step === "setup") {
      if (whereProblem) return;
      setStep("job");
    }
  };

  const create = async () => {
    setTried(true);
    if (problem || whereProblem || doProblem || environmentId === null) return;
    setBusy(true);
    const env = environmentId as EnvironmentId;
    try {
      const projects = limited
        ? [...picked]
            .filter((key) => key.startsWith(`${env}:`))
            .map((key) => key.slice(env.length + 1))
        : ("all" as const);
      const preset = mode === "itself" ? "full" : "helper";
      const theJob = jobOf(job, tools);
      const created = await createAssistant({
        environmentId: env,
        name: name.trim(),
        emoji: face.emoji,
        access: { preset, projects: projects as never },
      });
      const projectId = created.projectId;
      await Promise.all([
        updateAssistantTeam({
          environmentId: env,
          projectId,
          tone: face.tone,
          roles: finalRole ? [finalRole] : [],
          character: characterLine(tags, sliders),
          setup: "done",
          duties: [dutyOf(theJob)],
        }),
        setAssistantPreset({ environmentId: env, projectId, preset, projects }),
        face.picture
          ? setAssistantAvatar({
              environmentId: env,
              projectId,
              image: base64OfDataUrl(face.picture),
            })
          : Promise.resolve(null),
        theJob.tasks !== null && job.appsOff.length > 0
          ? putAssistantApps({
              environmentId: env,
              projectId,
              permissions: Object.fromEntries(
                tools.apps.map((app) => [
                  app.provider,
                  job.appsOff.includes(app.provider) ? ("none" as const) : ("write" as const),
                ]),
              ),
            })
          : Promise.resolve(null),
      ]);
      await waitForProject(env, projectId);
      await queryClient.invalidateQueries({ queryKey: LOCAL_ASSISTANTS_KEY });
      setMade({
        environmentId: env,
        projectId,
        text: firstMessageOf(job, theJob, { name: name.trim(), role: finalRole, computer }),
      });
      setStep("channel");
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: `Couldn't make ${shown}`,
        description: errorText(cause, `${computer} didn't answer. Nothing was made.`),
      });
    } finally {
      setBusy(false);
    }
  };

  const open = async () => {
    if (!made) return;
    setBusy(true);
    try {
      const chat = await ensureAssistantChat({
        environmentId: made.environmentId,
        projectId: made.projectId as ProjectId,
      });
      await waitForThreadInStore(made.environmentId, chat.threadId, 5_000);
      if (made.text) {
        await sendFirstMessage({
          environmentId: made.environmentId,
          threadId: chat.threadId as ThreadId,
          text: made.text,
        });
      }
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({
          environmentId: made.environmentId,
          threadId: chat.threadId,
        }),
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: `Couldn't open ${shown}'s chat`,
        description: errorText(cause, `${computer} didn't answer. It's in the sidebar.`),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5" data-testid="persona-builder" data-step={step}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {step === "channel" ? `${shown} is ready` : `Make ${start.name} yours`}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Step {STEP_NUMBER[step]} of 5. You can change all of it later.
        </p>
      </div>
      {step === "channel" && made ? (
        <Channel name={shown} made={made} busy={busy} onOpen={() => void open()} />
      ) : (
        <div className="grid gap-6 md:grid-cols-[13rem_1fr]">
          <FacePicker
            face={face}
            onChange={setFace}
            environmentId={environmentId as EnvironmentId | null}
            readOnly={step !== "who"}
          />
          <div className="flex min-w-0 flex-col gap-5">
            {step === "who" ? (
              <>
                <div>
                  <Label
                    hint={
                      name.length >= ASSISTANT_NAME_MAX - 5
                        ? `${name.length}/${ASSISTANT_NAME_MAX}`
                        : null
                    }
                  >
                    Name
                  </Label>
                  <Input
                    value={name}
                    maxLength={ASSISTANT_NAME_MAX}
                    placeholder="Mia, Bolt, Ms. Pepper…"
                    onChange={(event) => setName(event.target.value)}
                    data-testid="persona-name"
                    aria-invalid={tried && problem !== null}
                  />
                  {tried && problem ? (
                    <p className="mt-1 text-xs text-destructive" data-testid="persona-name-problem">
                      {problem}
                    </p>
                  ) : null}
                </div>
                <div data-testid="persona-role">
                  <Label>Role</Label>
                  <p className="text-sm">
                    <b className="font-medium">{start.role}</b>{" "}
                    <span className="text-muted-foreground">· {JOB_COPY[start.job].line}</span>
                  </p>
                </div>
                <div>
                  <Label hint={`up to ${MAX_TAGS} tags`}>Character</Label>
                  <div className="flex flex-col gap-1.5">
                    {SLIDERS.map(([low, high], index) => (
                      <label
                        key={low}
                        className="grid grid-cols-[4.5rem_1fr_4.5rem] items-center gap-2 text-xs"
                      >
                        <span className="text-muted-foreground">{low}</span>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={sliders[index]}
                          onChange={(event) => {
                            const value = [...sliders] as [number, number, number];
                            value[index] = Number(event.target.value);
                            setSliders(value);
                          }}
                          aria-label={`${low} or ${high}`}
                          className="accent-primary"
                        />
                        <span className="text-right text-muted-foreground">{high}</span>
                      </label>
                    ))}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {TAGS.map((tag) => (
                      <Chip
                        key={tag}
                        on={tags.includes(tag)}
                        onClick={() => setTags(toggleTag(tags, tag))}
                      >
                        {tag}
                      </Chip>
                    ))}
                  </div>
                </div>
              </>
            ) : step === "setup" ? (
              <>
                <div>
                  <Label>Where it works</Label>
                  <WhereItWorks
                    homeEnvironmentId={home.environmentId}
                    value={environmentId}
                    assistantName={name.trim()}
                    emoji={face.emoji}
                    onChange={(next) => {
                      setWhere(next);
                      setPicked(new Set());
                    }}
                  />
                </div>
                {environmentId !== null ? (
                  <AssistantAiChoice
                    environmentId={environmentId}
                    name={name}
                    computer={computer}
                  />
                ) : null}
                <div>
                  <Label>Where it can look</Label>
                  <WhereItLooks
                    name={name}
                    homeEnvironmentId={environmentId}
                    homeLabel={computer}
                    limited={limited}
                    onLimited={setLimited}
                    picked={picked}
                    onToggle={(key) => {
                      const value = new Set(picked);
                      if (value.has(key)) value.delete(key);
                      else value.add(key);
                      setPicked(value);
                    }}
                  />
                </div>
                <div>
                  <Label>Permission level</Label>
                  <ModePicker mode={mode} onChange={setMode} testIdPrefix="persona-mode" />
                </div>
                {whereProblem ? (
                  <p className="text-xs text-destructive" data-testid="persona-where-problem">
                    {whereProblem}
                  </p>
                ) : null}
              </>
            ) : environmentId !== null ? (
              <PersonaJob
                name={name}
                environmentId={environmentId}
                computer={computer}
                projects={limited ? picked : "all"}
                draft={job}
                onChange={setJob}
                problem={tried ? doProblem : null}
              />
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              {step === "job" ? (
                <Button
                  onClick={() => void create()}
                  disabled={busy || whereProblem !== null}
                  data-testid="persona-create"
                >
                  {busy ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}
                  {busy ? `Making ${shown}…` : `Create ${name.trim() || "it"}`}
                </Button>
              ) : (
                <Button
                  onClick={next}
                  disabled={step === "setup" && whereProblem !== null}
                  data-testid="persona-next"
                >
                  Next
                </Button>
              )}
              <Button
                variant="ghost"
                onClick={() =>
                  step === "who" ? props.onBack() : setStep(step === "job" ? "setup" : "who")
                }
                disabled={busy}
              >
                {step === "who" ? "Back to characters" : "Back"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** `/assistants?view=new` in variant D: the gallery, then "make it yours". */
export function PersonaCreatorPage() {
  const navigate = useNavigate();
  const [picked, setPicked] = useState<GalleryPersona | null>(null);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden">
        <header className="flex min-h-12 items-center gap-2 border-b border-border px-3 sm:px-5">
          <SidebarShowButton />
          <Button
            size="xs"
            variant="ghost"
            onClick={() => (picked ? setPicked(null) : void navigate({ to: "/" }))}
          >
            <ArrowLeftIcon className="size-3.5" />
            <span className="hidden sm:inline">{picked ? "Characters" : "Back"}</span>
          </Button>
          <span className="text-xs text-muted-foreground">Uno › New assistant</span>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-8">
          <div className="mx-auto w-full max-w-4xl">
            {picked ? (
              <MakeItYours key={picked.id} start={picked} onBack={() => setPicked(null)} />
            ) : (
              <Gallery onPick={setPicked} />
            )}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
