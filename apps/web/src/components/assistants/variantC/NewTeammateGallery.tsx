/**
 * Variant C (28.10): a new teammate under Uno — "like Grok companions"
 * (Misha 27.10). `/assistants?view=new` when VARIANT_C:
 *
 * 1. Who do you need? — five ready characters (face, role, a line in their
 *    voice, three words) and "Build your own". One already on the team opens
 *    its page instead.
 * 2. Make X yours — name, role, character (three sliders + up to three
 *    words), face (emoji, or a portrait Uno AI draws), where it works (the
 *    always-on cloud computer by default) and how (Does it itself / Asks
 *    first). Create makes it on that computer, opens its chat, and it writes
 *    first in character.
 *
 * Everything goes through its computer's daemon (managerApi), as "+" does.
 */
import type { AssistantPersona, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CheckIcon,
  CloudIcon,
  HandIcon,
  LaptopIcon,
  LoaderCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  SparklesIcon,
  ZapIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { waitForThreadInStore } from "../../../assistant/useAssistantChat";
import { useMachineRows } from "../../../hooks/useMachineRows";
import {
  createAssistant,
  ensureAssistantChat,
  generateAssistantAvatar,
  setAssistantAvatar,
  updateAssistantTeam,
} from "../../../lib/managerApi";
import { cn } from "../../../lib/utils";
import { selectProjectsAcrossEnvironments, useStore } from "../../../store";
import { buildThreadRouteParams } from "../../../threadRoutes";
import type { MachineRow } from "../../settings/machineRows";
import { SidebarShowButton } from "../../sidebar/SidebarShowButton";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { SidebarInset } from "../../ui/sidebar";
import { toastManager } from "../../ui/toast";
import { AVATAR_IMAGE_KEY, AssistantAvatar } from "../AssistantAvatar";
import { AVATAR_SIZE_PX, PERSONAS, base64OfDataUrl, centerSquare } from "../assistantAvatar.logic";
import { useAssistantTeam } from "../useAssistantTeam";
import { LOCAL_ASSISTANTS_KEY } from "../useAssistants";
import {
  TEAMMATE_CHARACTERS,
  TEAMMATE_NAME_COUNTER_FROM,
  TEAMMATE_NAME_MAX,
  TEAMMATE_ROLES,
  TEAMMATE_SLIDERS,
  TEAMMATE_TAGS,
  TEAMMATE_TAGS_MAX,
  type TeammateCharacter,
  type TeammateDraft,
  blankDraft,
  clampName,
  characterLine,
  draftFromCharacter,
  finalName,
  finalRole,
  memberNamed,
  roleLabel,
  toggleTag,
} from "./newTeammate.logic";

/** A drawn portrait isn't saved until Create: drawn for this placeholder folder. */
const DRAFT_PROJECT_ID = "assistant-draft";

const FACE_EMOJIS: ReadonlyArray<string> = [
  "🦉",
  "🦊",
  "🤖",
  "👽",
  "🐼",
  "🧑",
  "👩",
  "👨",
  "👩‍🦰",
  "🧑‍💻",
  "👩‍🔬",
  "🧙",
  "🐱",
  "🐶",
  "🦦",
  "🐨",
  "🐯",
  "👾",
];

const PERSONA_OF_EMOJI: Readonly<Record<string, AssistantPersona>> = {
  "🦉": "animal",
  "🦊": "animal",
  "🐼": "animal",
  "🐱": "animal",
  "🐶": "animal",
  "🦦": "animal",
  "🐨": "animal",
  "🐯": "animal",
  "🤖": "robot",
  "👽": "alien",
  "👾": "alien",
};

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/** A picture cut to its centered square, AVATAR_SIZE_PX wide, as a data URL (WebP, else PNG). */
async function squarePicture(src: string): Promise<string> {
  const image = new Image();
  image.decoding = "async";
  image.src = src;
  await image.decode();
  const { x, y, side } = centerSquare(image.naturalWidth, image.naturalHeight);
  if (side === 0) throw new Error("That picture is empty.");
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_SIZE_PX;
  canvas.height = AVATAR_SIZE_PX;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This window can't resize pictures.");
  context.imageSmoothingQuality = "high";
  context.drawImage(image, x, y, side, side, 0, 0, AVATAR_SIZE_PX, AVATAR_SIZE_PX);
  const webp = canvas.toDataURL("image/webp", 0.9);
  return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png");
}

/** Its folder reached this window (the sidebar and its chat can show it). */
async function waitForProject(environmentId: string, projectId: string): Promise<void> {
  const here = () =>
    selectProjectsAcrossEnvironments(useStore.getState()).some(
      (project) => project.environmentId === environmentId && project.id === projectId,
    );
  for (let tries = 0; tries < 50 && !here(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const usable = (row: MachineRow) => row.environmentId !== null && row.status === "online";

/** The always-on cloud computer first: the one this Work runs on, if it's a cloud one. */
function defaultComputer(rows: ReadonlyArray<MachineRow>): string | null {
  const pick =
    rows.find((row) => row.isPrimary && row.kind === "uno_box" && usable(row)) ??
    rows.find((row) => row.kind === "uno_box" && usable(row)) ??
    rows.find(usable);
  return pick?.environmentId ?? null;
}

// ── Small parts ───────────────────────────────────────────────────────────

function Pill(props: { readonly children: ReactNode }) {
  return (
    <span className="inline-flex h-5 items-center rounded-full border border-border px-2 text-[11px] text-muted-foreground">
      {props.children}
    </span>
  );
}

function Field(props: {
  readonly label: string;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-foreground">{props.label}</span>
        {props.aside}
      </div>
      {props.children}
    </div>
  );
}

function Chip(props: {
  readonly on: boolean;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly testId: string;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.on}
      disabled={props.disabled}
      onClick={props.onClick}
      data-testid={props.testId}
      className={cn(
        "inline-flex h-7 cursor-pointer items-center rounded-full border px-3 text-xs transition-colors disabled:cursor-default disabled:opacity-45",
        props.on
          ? "border-primary/50 bg-primary/8 font-medium text-primary"
          : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      {props.children}
    </button>
  );
}

function Crumbs(props: { readonly tail: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      Team <span aria-hidden>›</span> New teammate · {props.tail}
    </p>
  );
}

// ── Step 1: the gallery ───────────────────────────────────────────────────

function CharacterCard(props: {
  readonly character: TeammateCharacter;
  readonly onTeam: boolean;
  readonly onClick: () => void;
}) {
  const { character } = props;
  return (
    <button
      type="button"
      onClick={props.onClick}
      data-testid="teammate-card"
      data-name={character.name}
      className="group flex min-w-0 cursor-pointer flex-col gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent/30"
    >
      <div className="flex items-center gap-3">
        <AssistantAvatar
          emoji={character.emoji}
          tone={character.tone}
          className="size-10"
          emojiClassName="text-xl"
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold text-foreground">{character.name}</span>
          <span className="text-xs font-medium text-primary">{roleLabel(character.role)}</span>
        </div>
        {props.onTeam ? (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success"
            data-testid="teammate-card-on-team"
          >
            <CheckIcon className="size-3" /> On your team
          </span>
        ) : null}
      </div>
      <p className="text-sm leading-snug text-muted-foreground italic">“{character.quote}”</p>
      <div className="mt-auto flex flex-wrap gap-1">
        {character.words.map((word) => (
          <Pill key={word}>{word}</Pill>
        ))}
      </div>
    </button>
  );
}

function Gallery(props: {
  readonly onTeam: (name: string) => { open: () => void } | null;
  readonly pick: (draft: TeammateDraft) => void;
}) {
  return (
    <div className="flex flex-col gap-5" data-testid="teammate-gallery">
      <div className="flex flex-col gap-1.5">
        <Crumbs tail="reports to Uno" />
        <h1 className="text-xl leading-tight font-semibold">Who do you need?</h1>
        <p className="text-sm text-muted-foreground">
          Pick a character — it starts in that role right away. Or build your own in a minute.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {TEAMMATE_CHARACTERS.map((character) => {
          const member = props.onTeam(character.name);
          return (
            <CharacterCard
              key={character.name}
              character={character}
              onTeam={member !== null}
              onClick={() => (member ? member.open() : props.pick(draftFromCharacter(character)))}
            />
          );
        })}
        <button
          type="button"
          onClick={() => props.pick(blankDraft())}
          data-testid="teammate-build-own"
          className="flex min-h-40 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border p-4 text-center transition-colors hover:border-primary/40 hover:bg-accent/30"
        >
          <PlusIcon className="size-5 text-primary" />
          <span className="text-sm font-semibold text-foreground">Build your own</span>
          <span className="text-xs text-muted-foreground">Name, character, role, face</span>
        </button>
      </div>
    </div>
  );
}

// ── Step 2: make it yours ─────────────────────────────────────────────────

function FaceColumn(props: {
  readonly draft: TeammateDraft;
  readonly change: (patch: Partial<TeammateDraft>) => void;
  readonly disabled: boolean;
  /** The computer that draws it (the one it will work on). */
  readonly environmentId: string | null;
}) {
  const { draft, change } = props;
  const [tab, setTab] = useState<"emoji" | "persona">(draft.face);
  const [drawing, setDrawing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1000));
  const kind: AssistantPersona = draft.persona ?? PERSONA_OF_EMOJI[draft.emoji] ?? "human";

  const draw = async (persona: AssistantPersona) => {
    const next = seed + 1;
    setSeed(next);
    setDrawing(true);
    setFailed(false);
    change({ persona });
    try {
      if (props.environmentId === null) throw new Error("No computer to draw on.");
      const { image } = await generateAssistantAvatar({
        // Any computer of the account draws; the picture is kept only at Create.
        environmentId: props.environmentId as EnvironmentId,
        projectId: DRAFT_PROJECT_ID,
        persona,
        seed: next,
      });
      change({ persona, portrait: await squarePicture(image), face: "persona" });
    } catch {
      // The emoji stays its face; creating still works.
      setFailed(true);
      change({ face: "emoji", portrait: null });
    } finally {
      setDrawing(false);
    }
  };

  const showPortrait = draft.face === "persona" && draft.portrait !== null;
  return (
    <div className="flex w-full flex-col items-center gap-3 md:w-48 md:shrink-0">
      <div className="relative">
        <AssistantAvatar
          emoji={draft.emoji}
          tone={draft.tone}
          src={showPortrait ? draft.portrait : null}
          className="size-24"
          emojiClassName="text-5xl"
          name={`${finalName(draft)}'s face`}
        />
        {drawing ? (
          <span className="absolute inset-0 grid place-items-center rounded-full bg-background/60">
            <LoaderCircleIcon className="size-6 animate-spin text-muted-foreground" />
          </span>
        ) : null}
      </div>

      <div className="flex w-full gap-1 rounded-lg bg-muted/60 p-0.5" role="tablist">
        {(
          [
            { id: "emoji", label: "Emoji" },
            { id: "persona", label: "Persona" },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            data-testid={`teammate-face-tab-${item.id}`}
            className={cn(
              "h-7 flex-1 cursor-pointer rounded-md text-xs transition-colors",
              tab === item.id
                ? "bg-background font-medium text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "emoji" ? (
        <div className="grid grid-cols-6 gap-0.5" data-testid="teammate-face-emoji">
          {FACE_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={emoji}
              disabled={props.disabled}
              onClick={() => change({ emoji, face: "emoji" })}
              className={cn(
                "grid size-7 cursor-pointer place-items-center rounded-md text-base hover:bg-accent",
                draft.face === "emoji" &&
                  draft.emoji === emoji &&
                  "bg-primary/10 ring-1 ring-primary/40",
              )}
            >
              {emoji}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex w-full flex-col gap-2" data-testid="teammate-face-persona">
          <div className="grid grid-cols-4 gap-1">
            {PERSONAS.map((item) => (
              <button
                key={item.id}
                type="button"
                title={item.label}
                disabled={drawing || props.disabled}
                onClick={() => change({ persona: item.id })}
                data-testid={`teammate-face-kind-${item.id}`}
                className={cn(
                  "flex cursor-pointer flex-col items-center gap-0.5 rounded-lg border py-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent/40 disabled:cursor-default",
                  kind === item.id
                    ? "border-primary/50 bg-primary/5 text-foreground"
                    : "border-border",
                )}
              >
                <span className="text-base leading-none">{item.emoji}</span>
                {item.label}
              </button>
            ))}
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={drawing || props.disabled}
            onClick={() => void draw(kind)}
            data-testid="teammate-face-draw"
          >
            {drawing ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            ) : showPortrait ? (
              <RefreshCwIcon className="size-3.5" />
            ) : (
              <SparklesIcon className="size-3.5" />
            )}
            {drawing ? "Drawing…" : showPortrait ? "Another one" : "Draw a face"}
          </Button>
        </div>
      )}

      {failed ? (
        <p
          className="text-center text-xs text-amber-700 dark:text-amber-400"
          data-testid="teammate-face-error"
        >
          Couldn't draw a face right now. Your emoji stays — try again later.
        </p>
      ) : null}
    </div>
  );
}

function WhereItWorks(props: {
  readonly rows: ReadonlyArray<MachineRow>;
  readonly value: string | null;
  readonly onChange: (environmentId: string) => void;
  readonly disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-col gap-1.5">
        {props.rows.map((row) => {
          const on = row.environmentId !== null && row.environmentId === props.value;
          const can = usable(row);
          const Icon = row.kind === "computer" ? LaptopIcon : CloudIcon;
          const note = !can
            ? "asleep"
            : row.kind === "uno_box" && row.isPrimary
              ? "Always on"
              : row.kind === "computer"
                ? "Works while it's awake"
                : "Online";
          return (
            <button
              key={row.key}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={!can || props.disabled}
              onClick={() => row.environmentId && props.onChange(row.environmentId)}
              data-testid={`teammate-where-${row.environmentId ?? row.key}`}
              className={cn(
                "flex min-w-0 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-default",
                on ? "border-primary/50 bg-primary/5" : "border-border hover:bg-accent/40",
                !can && "opacity-55",
              )}
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{row.label}</span>
              <span
                className={cn(
                  "shrink-0 text-xs",
                  can ? "text-muted-foreground" : "text-muted-foreground/80",
                )}
              >
                {note}
              </span>
              <span
                aria-hidden
                className={cn(
                  "grid size-4 shrink-0 place-items-center rounded-full border",
                  on ? "border-primary bg-primary text-primary-foreground" : "border-border",
                )}
              >
                {on ? <CheckIcon className="size-2.5" /> : null}
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Uno can still use your other computers for it.
      </p>
    </div>
  );
}

function ModeCard(props: {
  readonly on: boolean;
  readonly onClick: () => void;
  readonly icon: ReactNode;
  readonly title: string;
  readonly line: string;
  readonly testId: string;
  readonly disabled: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.on}
      disabled={props.disabled}
      onClick={props.onClick}
      data-testid={props.testId}
      className={cn(
        "flex cursor-pointer flex-col gap-1 rounded-xl border p-3 text-left transition-colors disabled:cursor-default",
        props.on ? "border-primary/50 bg-primary/5" : "border-border hover:bg-accent/40",
      )}
    >
      <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
        {props.icon}
        {props.title}
      </span>
      <span className="text-xs leading-snug text-muted-foreground">{props.line}</span>
    </button>
  );
}

function MakeItYours(props: {
  readonly draft: TeammateDraft;
  readonly change: (patch: Partial<TeammateDraft>) => void;
  readonly rows: ReadonlyArray<MachineRow>;
  readonly where: string | null;
  readonly setWhere: (environmentId: string) => void;
  readonly creating: boolean;
  readonly onCreate: () => void;
  readonly onBack: () => void;
}) {
  const { draft, change, creating } = props;
  const name = finalName(draft);
  const typed = Array.from(draft.name).length;
  return (
    <div className="flex flex-col gap-6" data-testid="teammate-tune">
      <div className="flex flex-col gap-1.5">
        <Crumbs tail="reports to Uno" />
        <h1 className="truncate text-xl leading-tight font-semibold">Make {name} yours</h1>
        <p className="text-sm text-muted-foreground">
          Step 2 of 2. You can change all of it later.
        </p>
      </div>

      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        <FaceColumn draft={draft} change={change} disabled={creating} environmentId={props.where} />

        <div className="flex min-w-0 flex-1 flex-col gap-5">
          <Field
            label="Name"
            aside={
              typed > TEAMMATE_NAME_COUNTER_FROM ? (
                <span
                  className="text-xs text-muted-foreground tabular-nums"
                  data-testid="teammate-name-count"
                >
                  {typed}/{TEAMMATE_NAME_MAX}
                </span>
              ) : null
            }
          >
            <Input
              nativeInput
              value={draft.name}
              maxLength={TEAMMATE_NAME_MAX}
              placeholder="Teammate"
              disabled={creating}
              onChange={(event) => change({ name: clampName(event.currentTarget.value) })}
              onBlur={() => change({ name: draft.name.trim() })}
              aria-label="Name"
              data-testid="teammate-name"
            />
          </Field>

          <Field label="Role">
            <div className="flex flex-wrap gap-1.5">
              {TEAMMATE_ROLES.map((role) => (
                <Chip
                  key={role.id}
                  on={draft.role === role.id}
                  disabled={creating}
                  onClick={() => change({ role: role.id })}
                  testId={`teammate-role-${role.id}`}
                >
                  {role.label}
                </Chip>
              ))}
            </div>
            {draft.role === "other" ? (
              <Input
                nativeInput
                value={draft.customRole}
                maxLength={60}
                placeholder="e.g. Bookkeeper"
                disabled={creating}
                onChange={(event) => change({ customRole: event.currentTarget.value })}
                aria-label="Its role"
                data-testid="teammate-role-custom"
                autoFocus
              />
            ) : null}
          </Field>

          <Field label="Character">
            <div className="grid grid-cols-[4.5rem_1fr_4.5rem] items-center gap-x-3 gap-y-2">
              {TEAMMATE_SLIDERS.map((slider) => (
                <SliderRow
                  key={slider.id}
                  low={slider.low}
                  high={slider.high}
                  value={draft.sliders[slider.id]}
                  disabled={creating}
                  testId={`teammate-slider-${slider.id}`}
                  onChange={(value) =>
                    change({ sliders: { ...draft.sliders, [slider.id]: value } })
                  }
                />
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {TEAMMATE_TAGS.map((tag) => {
                const on = draft.tags.includes(tag.id);
                return (
                  <Chip
                    key={tag.id}
                    on={on}
                    disabled={creating || (!on && draft.tags.length >= TEAMMATE_TAGS_MAX)}
                    onClick={() => change({ tags: toggleTag(draft.tags, tag.id) })}
                    testId={`teammate-tag-${tag.id}`}
                  >
                    {tag.label}
                  </Chip>
                );
              })}
              <span className="text-xs text-muted-foreground">Up to {TEAMMATE_TAGS_MAX}.</span>
            </div>
          </Field>

          <Field label="Where it works">
            <WhereItWorks
              rows={props.rows}
              value={props.where}
              onChange={props.setWhere}
              disabled={creating}
            />
          </Field>

          <Field label="How it works">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup">
              <ModeCard
                on={draft.mode === "itself"}
                onClick={() => change({ mode: "itself" })}
                icon={<ZapIcon className="size-4 text-amber-500" />}
                title="Does it itself"
                line="Acts and tells you after."
                testId="teammate-mode-itself"
                disabled={creating}
              />
              <ModeCard
                on={draft.mode === "asks"}
                onClick={() => change({ mode: "asks" })}
                icon={<HandIcon className="size-4 text-sky-500" />}
                title="Asks first"
                line="Waits for your OK before it sends, pays or deletes."
                testId="teammate-mode-asks"
                disabled={creating}
              />
            </div>
          </Field>

          <div className="flex flex-col gap-3 border-t border-border pt-4">
            <p className="text-xs text-muted-foreground">
              Reports to Uno. Shares Uno's apps and memory of you.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={props.onCreate}
                disabled={creating || props.where === null}
                data-testid="teammate-create"
                className="max-w-full"
              >
                {creating ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}
                <span className="truncate">
                  {creating ? `Creating ${name}…` : `Create ${name}`}
                </span>
              </Button>
              <Button
                variant="ghost"
                onClick={props.onBack}
                disabled={creating}
                data-testid="teammate-back"
              >
                Back to characters
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SliderRow(props: {
  readonly low: string;
  readonly high: string;
  readonly value: number;
  readonly disabled: boolean;
  readonly testId: string;
  readonly onChange: (value: number) => void;
}) {
  const leans = props.value < 35 ? "low" : props.value > 65 ? "high" : null;
  return (
    <>
      <span
        className={cn(
          "text-xs",
          leans === "low" ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {props.low}
      </span>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(Number(event.currentTarget.value))}
        aria-label={`${props.low} or ${props.high}`}
        data-testid={props.testId}
        className="h-1.5 w-full cursor-pointer accent-primary"
      />
      <span
        className={cn(
          "text-right text-xs",
          leans === "high" ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {props.high}
      </span>
    </>
  );
}

// ── The screen ────────────────────────────────────────────────────────────

export function NewTeammateGallery() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const team = useAssistantTeam();
  const rows = useMachineRows();
  const [draft, setDraft] = useState<TeammateDraft | null>(null);
  const [where, setWhere] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const setActiveEnvironmentId = useStore((state) => state.setActiveEnvironmentId);
  const chosen = where ?? defaultComputer(rows);

  const members = team
    .filter((member) => !member.isUno && !member.revoked)
    .map((member) => ({ name: member.profile.name, member }));
  const onTeam = (name: string) => {
    const found = memberNamed(members, name);
    if (!found) return null;
    return {
      open: () =>
        void navigate({
          to: "/assistants",
          search: {
            view: "profile",
            env: found.member.environmentId as EnvironmentId,
            project: found.member.projectId as ProjectId,
          },
        }),
    };
  };

  const change = (patch: Partial<TeammateDraft>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));

  const create = async () => {
    if (!draft || chosen === null || creating) return;
    const environmentId = chosen as EnvironmentId;
    const name = finalName(draft);
    setCreating(true);
    try {
      const { projectId } = await createAssistant({
        environmentId,
        name,
        emoji: draft.emoji,
        access: { preset: draft.mode === "asks" ? "helper" : "full", projects: "all" },
      });
      await updateAssistantTeam({
        environmentId,
        projectId,
        roles: [finalRole(draft)],
        character: characterLine(draft),
        tone: draft.tone,
        setup: "done",
      });
      const picture =
        draft.face === "persona" && draft.portrait ? base64OfDataUrl(draft.portrait) : null;
      if (picture) {
        // A face that didn't save leaves the emoji: not a reason to stop.
        await setAssistantAvatar({ environmentId, projectId, image: picture }).catch(
          () => undefined,
        );
      }
      await queryClient.invalidateQueries({ queryKey: LOCAL_ASSISTANTS_KEY });
      await queryClient.invalidateQueries({ queryKey: AVATAR_IMAGE_KEY });
      await waitForProject(environmentId, projectId);
      const { threadId } = await ensureAssistantChat({ environmentId, projectId });
      setActiveEnvironmentId(environmentId);
      await waitForThreadInStore(environmentId, threadId, 5_000);
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({ environmentId, threadId }),
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: `Couldn't create ${name}`,
        description: errorText(cause, "Its computer didn't answer. Try again."),
      });
      setCreating(false);
    }
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden"
        data-testid="teammate-new"
      >
        <header className="flex min-h-12 items-center gap-2 border-b border-border px-3 sm:px-5">
          <SidebarShowButton />
          <Button size="xs" variant="ghost" onClick={() => void navigate({ to: "/assistants" })}>
            <ArrowLeftIcon className="size-3.5" />
            <span className="hidden sm:inline">Assistants</span>
          </Button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            {draft === null ? (
              <Gallery onTeam={onTeam} pick={setDraft} />
            ) : (
              <MakeItYours
                draft={draft}
                change={change}
                rows={rows}
                where={chosen}
                setWhere={setWhere}
                creating={creating}
                onCreate={() => void create()}
                onBack={() => setDraft(null)}
              />
            )}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
