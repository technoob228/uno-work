/**
 * New assistant as a gallery of characters (variant B, Misha 27.10: "make
 * them like Grok companions"):
 *
 * 1. "Who do you need?" — five characters, each with a role, a line it might
 *    say and three tags, plus "Build your own";
 * 2. "Make Mia yours" — name, role, character (three sliders + tags), face
 *    (Persona / Emoji / Draw one), how it works (Does it itself / Asks first)
 *    and the one computer it lives on. It sees only that computer.
 *
 * Create makes it on that computer, saves its profile and face, and opens its
 * chat — it writes first, in character. Rules and data:
 * `assistantGallery.logic.ts`. Route: `/assistants?view=gallery[&env=…]`.
 */
import type { AssistantPersona, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  HandIcon,
  LoaderCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  SparklesIcon,
  ZapIcon,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { useActiveMachine } from "../../hooks/useActiveMachine";
import { useMachineRows } from "../../hooks/useMachineRows";
import {
  createAssistant,
  ensureAssistantChat,
  generateAssistantAvatar,
  setAssistantAvatar,
  updateAssistantTeam,
} from "../../lib/managerApi";
import { cn } from "../../lib/utils";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../../store";
import { buildThreadRouteParams } from "../../threadRoutes";
import { SidebarShowButton } from "../sidebar/SidebarShowButton";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { AssistantAvatar } from "./AssistantAvatar";
import { EMOJI_GROUPS, PERSONAS, base64OfDataUrl } from "./assistantAvatar.logic";
import {
  BLANK_FACE,
  GALLERY_CHARACTERS,
  GALLERY_PERSONA_FACES,
  GALLERY_ROLES,
  GALLERY_SLIDERS,
  GALLERY_TAGS,
  MIDDLE_SLIDERS,
  characterLine,
  defaultMachine,
  machineUnavailableReason,
  personaOfFace,
  sameNameNote,
  toneOfFace,
  type GalleryCharacter,
  type GalleryRole,
  type GallerySliders,
  type GalleryTag,
} from "./assistantGallery.logic";
import { useAssistantTeam } from "./useAssistantTeam";
import { LOCAL_ASSISTANTS_KEY } from "./useAssistants";

type Mode = "itself" | "asks-first";
type FaceTab = "persona" | "emoji" | "draw";
type RoleChoice = GalleryRole | "other" | null;

const FACE_TABS: ReadonlyArray<{ readonly id: FaceTab; readonly label: string }> = [
  { id: "persona", label: "Persona" },
  { id: "emoji", label: "Emoji" },
  { id: "draw", label: "Draw one" },
];

const ALL_EMOJIS: ReadonlyArray<string> = EMOJI_GROUPS.flatMap((group) => group.emojis);

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
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

// ── Step 1: the gallery ───────────────────────────────────────────────────

function CharacterCard(props: {
  readonly character: GalleryCharacter;
  readonly onPick: () => void;
}) {
  const { character } = props;
  return (
    <button
      type="button"
      onClick={props.onPick}
      className="flex min-w-0 cursor-pointer flex-col gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      data-testid={`gallery-card-${character.id}`}
    >
      <span className="flex items-center gap-3">
        <AssistantAvatar
          emoji={character.emoji}
          tone={character.tone}
          className="size-10"
          emojiClassName="text-xl"
        />
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{character.name}</span>
          <span className="block text-xs font-medium text-primary">{character.role}</span>
        </span>
      </span>
      <span className="flex-1 text-sm text-muted-foreground italic">“{character.quote}”</span>
      <span className="flex flex-wrap gap-1.5">
        {character.tags.map((tag) => (
          <span
            key={tag}
            className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
          >
            {tag}
          </span>
        ))}
      </span>
    </button>
  );
}

function BuildOwnCard(props: { readonly onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onPick}
      className="flex min-h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border p-4 text-center transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      data-testid="gallery-build-own"
    >
      <PlusIcon className="size-6 text-primary" />
      <span className="text-sm font-semibold">Build your own</span>
      <span className="text-xs text-muted-foreground">Name, character, role, face</span>
    </button>
  );
}

// ── Step 2: small parts ───────────────────────────────────────────────────

function Chip(props: {
  readonly on: boolean;
  readonly onClick: () => void;
  readonly testId: string;
  readonly children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.on}
      onClick={props.onClick}
      className={cn(
        "cursor-pointer rounded-full border px-2.5 py-1 text-xs transition-colors",
        props.on
          ? "border-primary bg-primary/8 font-medium text-primary"
          : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      data-testid={props.testId}
    >
      {props.children}
    </button>
  );
}

function FieldLabel(props: { readonly children: string; readonly htmlFor?: string }) {
  return (
    <label htmlFor={props.htmlFor} className="text-sm font-medium">
      {props.children}
    </label>
  );
}

function ModeCard(props: {
  readonly on: boolean;
  readonly onClick: () => void;
  readonly icon: ReactNode;
  readonly title: string;
  readonly text: string;
  readonly testId: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.on}
      onClick={props.onClick}
      className={cn(
        "flex min-w-0 cursor-pointer flex-col gap-1 rounded-xl border p-3 text-left transition-colors",
        props.on ? "border-primary bg-primary/6" : "border-border hover:bg-accent",
      )}
      data-testid={props.testId}
    >
      <span className="flex items-center gap-2 text-sm font-semibold">
        {props.icon}
        {props.title}
      </span>
      <span className="text-xs text-muted-foreground">{props.text}</span>
    </button>
  );
}

// ── The page ──────────────────────────────────────────────────────────────

export function AssistantGalleryPage(props: { readonly environmentId?: string | undefined }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const rows = useMachineRows();
  const active = useActiveMachine();
  const team = useAssistantTeam();

  const [step, setStep] = useState<"pick" | "tune">("pick");
  const [from, setFrom] = useState<GalleryCharacter | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState<RoleChoice>(null);
  const [otherRole, setOtherRole] = useState("");
  const [sliders, setSliders] = useState<GallerySliders>(MIDDLE_SLIDERS);
  const [tags, setTags] = useState<ReadonlyArray<GalleryTag>>([]);
  const [mode, setMode] = useState<Mode>("asks-first");
  const [emoji, setEmoji] = useState(BLANK_FACE);
  const [drawn, setDrawn] = useState<string | null>(null);
  const [faceTab, setFaceTab] = useState<FaceTab>("persona");
  const [persona, setPersona] = useState<AssistantPersona | null>(null);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1000));
  const [drawing, setDrawing] = useState(false);
  const [faceError, setFaceError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // The computer it lives on: the one picked if it is still awake, else the default.
  const fallback = useMemo(
    () => defaultMachine(rows, [props.environmentId, active.environmentId]),
    [rows, props.environmentId, active.environmentId],
  );
  const pickedRow = rows.find((row) => row.environmentId !== null && row.environmentId === picked);
  const machineId =
    pickedRow && machineUnavailableReason(pickedRow) === null ? pickedRow.environmentId : fallback;
  const machineLabel =
    rows.find((row) => row.environmentId === machineId)?.label ?? "this computer";

  const trimmedName = name.trim();
  const tone = toneOfFace(emoji);
  const drawPersona = persona ?? personaOfFace(emoji);
  const roleText = role === "other" ? otherRole.trim() : (role ?? "");
  const note = sameNameNote({
    name: trimmedName,
    environmentId: machineId,
    thisLabel: machineLabel,
    existing: team.map((member) => ({
      name: member.profile.name,
      environmentId: member.environmentId,
      computerLabel: member.computerLabel,
      revoked: member.revoked,
    })),
  });
  const canCreate =
    trimmedName !== "" && machineId !== null && note.kind !== "same-computer" && !creating;

  const startFrom = (character: GalleryCharacter | null) => {
    setFrom(character);
    setName(character?.name ?? "");
    setRole(character?.role ?? null);
    setOtherRole("");
    setSliders(character?.sliders ?? MIDDLE_SLIDERS);
    setTags(character?.tags ?? []);
    setMode("asks-first");
    setEmoji(character?.emoji ?? BLANK_FACE);
    setDrawn(null);
    setFaceTab("persona");
    setPersona(null);
    setFaceError(null);
    setStep("tune");
  };

  const pickFace = (next: string) => {
    setEmoji(next);
    setDrawn(null);
    setFaceError(null);
  };

  const toggleTag = (tag: GalleryTag) =>
    setTags((current) =>
      current.includes(tag) ? current.filter((one) => one !== tag) : [...current, tag],
    );

  const draw = async (nextSeed: number) => {
    if (machineId === null || drawing) return;
    setSeed(nextSeed);
    setDrawing(true);
    setFaceError(null);
    try {
      const { image } = await generateAssistantAvatar({
        environmentId: machineId as EnvironmentId,
        projectId: "assistant-new",
        persona: drawPersona,
        seed: nextSeed,
      });
      setDrawn(image);
    } catch {
      setFaceError(`Couldn't draw a face right now — kept ${emoji}. Try again, or pick one above.`);
    } finally {
      setDrawing(false);
    }
  };

  const create = async () => {
    if (!canCreate || machineId === null) return;
    const environmentId = machineId as EnvironmentId;
    setCreating(true);
    try {
      const { projectId } = await createAssistant({
        environmentId,
        name: trimmedName,
        emoji,
        access: { preset: mode === "itself" ? "full" : "helper", projects: "all" },
      });
      await updateAssistantTeam({
        environmentId,
        projectId,
        name: trimmedName,
        emoji,
        tone,
        roles: roleText ? [roleText] : [],
        character: characterLine(sliders, tags),
        setup: "done",
      });
      const image = drawn ? base64OfDataUrl(drawn) : null;
      if (image) await setAssistantAvatar({ environmentId, projectId, image });
      await waitForProject(environmentId, projectId);
      await queryClient.invalidateQueries({ queryKey: LOCAL_ASSISTANTS_KEY });
      const { threadId } = await ensureAssistantChat({
        environmentId,
        projectId: projectId as ProjectId,
      });
      // Its chat reached this window (else the chat route has nothing to open yet).
      for (let tries = 0; tries < 50; tries += 1) {
        const here = selectSidebarThreadsAcrossEnvironments(useStore.getState()).some(
          (thread) => thread.environmentId === environmentId && thread.id === threadId,
        );
        if (here) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({ environmentId, threadId }),
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: `Couldn't create ${trimmedName}`,
        description: errorText(cause, "Its computer didn't answer."),
      });
    } finally {
      setCreating(false);
    }
  };

  const machineMenu = (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            className="inline-flex max-w-56 cursor-pointer items-center gap-0.5 font-medium text-foreground hover:underline"
          />
        }
      >
        <span className="truncate">{machineId === null ? "no awake computer" : machineLabel}</span>
        <ChevronDownIcon className="size-3.5 shrink-0" />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-64">
        {rows.map((row) => {
          const reason = machineUnavailableReason(row);
          return (
            <MenuItem
              key={row.key}
              disabled={reason !== null}
              onClick={() => setPicked(row.environmentId)}
            >
              <span className="min-w-0">
                <span className="block truncate">{row.label}</span>
                {reason ? (
                  <span className="block text-xs text-muted-foreground">{reason}</span>
                ) : null}
              </span>
            </MenuItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );

  const title =
    step === "pick" ? "Who do you need?" : from ? `Make ${from.name} yours` : "Build your own";

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden"
        data-testid="assistant-gallery"
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
            <div className="flex flex-col gap-1.5">
              <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                <span className="shrink-0">New assistant · lives on</span>
                {machineMenu}
              </p>
              <h1 className="text-xl font-semibold tracking-tight">
                <span className="block truncate">{title}</span>
              </h1>
              <p className="text-sm text-muted-foreground">
                {step === "pick"
                  ? "Pick a character — it starts in that role right away. Or build your own in a minute."
                  : "Everything here can be changed later."}
              </p>
            </div>

            {step === "pick" ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {GALLERY_CHARACTERS.map((character) => (
                  <CharacterCard
                    key={character.id}
                    character={character}
                    onPick={() => startFrom(character)}
                  />
                ))}
                <BuildOwnCard onPick={() => startFrom(null)} />
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-8 md:grid-cols-[13rem_minmax(0,1fr)]">
                {/* Its face */}
                <div className="flex min-w-0 flex-col items-center gap-3">
                  <div className="relative">
                    <AssistantAvatar
                      emoji={emoji}
                      src={drawn}
                      tone={tone}
                      className="size-24"
                      emojiClassName="text-5xl"
                      name={trimmedName || undefined}
                    />
                    {drawing ? (
                      <span className="absolute inset-0 grid place-items-center rounded-full bg-background/60">
                        <LoaderCircleIcon className="size-6 animate-spin text-muted-foreground" />
                      </span>
                    ) : null}
                  </div>
                  <span className="max-w-full truncate text-sm font-medium">
                    {trimmedName || "No name yet"}
                  </span>
                  <div
                    role="tablist"
                    className="flex rounded-lg border border-border p-0.5 text-xs"
                  >
                    {FACE_TABS.map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        aria-selected={faceTab === tab.id}
                        onClick={() => setFaceTab(tab.id)}
                        className={cn(
                          "cursor-pointer rounded-md px-2.5 py-1 transition-colors",
                          faceTab === tab.id
                            ? "bg-accent font-medium text-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                        data-testid={`gallery-face-tab-${tab.id}`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>

                  {faceTab === "persona" ? (
                    <div className="grid grid-cols-4 gap-1.5">
                      {GALLERY_PERSONA_FACES.map((face) => (
                        <button
                          key={face}
                          type="button"
                          aria-label={`Face ${face}`}
                          aria-pressed={!drawn && emoji === face}
                          onClick={() => pickFace(face)}
                          className={cn(
                            "grid size-9 cursor-pointer place-items-center rounded-lg text-xl transition-colors hover:bg-accent",
                            !drawn && emoji === face && "bg-accent ring-1 ring-primary",
                          )}
                        >
                          {face}
                        </button>
                      ))}
                    </div>
                  ) : faceTab === "emoji" ? (
                    <div className="grid max-h-44 grid-cols-6 gap-0.5 overflow-y-auto">
                      {ALL_EMOJIS.map((face) => (
                        <button
                          key={face}
                          type="button"
                          aria-label={`Face ${face}`}
                          aria-pressed={!drawn && emoji === face}
                          onClick={() => pickFace(face)}
                          className={cn(
                            "grid size-8 cursor-pointer place-items-center rounded-md text-lg transition-colors hover:bg-accent",
                            !drawn && emoji === face && "bg-accent ring-1 ring-primary",
                          )}
                        >
                          {face}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="flex w-full flex-col items-center gap-2">
                      <div className="flex flex-wrap justify-center gap-1">
                        {PERSONAS.map((one) => (
                          <Chip
                            key={one.id}
                            on={drawPersona === one.id}
                            onClick={() => setPersona(one.id)}
                            testId={`gallery-face-persona-${one.id}`}
                          >
                            {one.label}
                          </Chip>
                        ))}
                      </div>
                      {drawing ? (
                        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <LoaderCircleIcon className="size-3.5 animate-spin" />
                          Drawing… about 10 s
                        </p>
                      ) : drawn ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void draw(seed + 1)}
                          disabled={machineId === null}
                          data-testid="gallery-face-another"
                        >
                          <RefreshCwIcon className="size-3.5" />
                          Another one
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void draw(seed)}
                          disabled={machineId === null}
                          data-testid="gallery-face-draw"
                        >
                          <SparklesIcon className="size-3.5" />
                          Draw a face
                        </Button>
                      )}
                    </div>
                  )}
                  {faceError ? (
                    <p
                      role="status"
                      className="text-center text-xs text-muted-foreground"
                      data-testid="gallery-face-error"
                    >
                      {faceError}
                    </p>
                  ) : null}
                </div>

                {/* Who it is and how it works */}
                <div className="flex min-w-0 flex-col gap-5">
                  <div className="flex flex-col gap-1.5">
                    <FieldLabel htmlFor="gallery-name">Name</FieldLabel>
                    <Input
                      id="gallery-name"
                      value={name}
                      placeholder="Give it a name"
                      maxLength={60}
                      onChange={(event) => setName(event.currentTarget.value)}
                      data-testid="gallery-name"
                    />
                    {name.length >= 50 ? (
                      <p className="text-xs text-muted-foreground" data-testid="gallery-name-count">
                        {name.length} of 60 — long names get cut in the sidebar; the full one is on
                        its page.
                      </p>
                    ) : null}
                    {note.kind !== "none" ? (
                      <p
                        className={cn(
                          "text-xs",
                          note.kind === "same-computer"
                            ? "text-destructive-foreground"
                            : "text-muted-foreground",
                        )}
                        data-testid="gallery-same-name-note"
                      >
                        {note.text}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <FieldLabel>Role</FieldLabel>
                    <div className="flex flex-wrap gap-1.5">
                      {GALLERY_ROLES.map((one) => (
                        <Chip
                          key={one}
                          on={role === one}
                          onClick={() => setRole(role === one ? null : one)}
                          testId={`gallery-role-${one.toLowerCase()}`}
                        >
                          {one}
                        </Chip>
                      ))}
                      <Chip
                        on={role === "other"}
                        onClick={() => setRole(role === "other" ? null : "other")}
                        testId="gallery-role-other"
                      >
                        Something else
                      </Chip>
                    </div>
                    {role === "other" ? (
                      <Input
                        size="sm"
                        value={otherRole}
                        placeholder="Its role, e.g. Bookkeeper"
                        onChange={(event) => setOtherRole(event.currentTarget.value)}
                        className="max-w-72"
                        data-testid="gallery-role-other-input"
                      />
                    ) : null}
                  </div>

                  <div className="flex flex-col gap-2">
                    <FieldLabel>Character</FieldLabel>
                    {GALLERY_SLIDERS.map((slider) => (
                      <div
                        key={slider.id}
                        className="grid grid-cols-[4rem_minmax(0,1fr)_4rem] items-center gap-3 text-xs text-muted-foreground"
                      >
                        <span>{slider.left}</span>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={sliders[slider.id]}
                          aria-label={`${slider.left} to ${slider.right}`}
                          onChange={(event) =>
                            setSliders({
                              ...sliders,
                              [slider.id]: Number(event.currentTarget.value),
                            })
                          }
                          className="h-1.5 w-full cursor-pointer accent-primary"
                          data-testid={`gallery-slider-${slider.id}`}
                        />
                        <span className="text-right">{slider.right}</span>
                      </div>
                    ))}
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {GALLERY_TAGS.map((tag) => (
                        <Chip
                          key={tag}
                          on={tags.includes(tag)}
                          onClick={() => toggleTag(tag)}
                          testId={`gallery-tag-${tag.toLowerCase()}`}
                        >
                          {tag}
                        </Chip>
                      ))}
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <FieldLabel>How it works</FieldLabel>
                    <div role="radiogroup" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <ModeCard
                        on={mode === "itself"}
                        onClick={() => setMode("itself")}
                        icon={<ZapIcon className="size-4 text-amber-500" />}
                        title="Does it itself"
                        text="Acts right away and tells you after."
                        testId="gallery-mode-itself"
                      />
                      <ModeCard
                        on={mode === "asks-first"}
                        onClick={() => setMode("asks-first")}
                        icon={<HandIcon className="size-4 text-amber-500" />}
                        title="Asks first"
                        text="Shows what it's about to do and waits for your Allow."
                        testId="gallery-mode-asks-first"
                      />
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <FieldLabel>Lives on</FieldLabel>
                    <div
                      role="radiogroup"
                      className="flex flex-col overflow-hidden rounded-xl border border-border"
                      data-testid="gallery-machine"
                    >
                      {rows.map((row) => {
                        const reason = machineUnavailableReason(row);
                        const on = reason === null && row.environmentId === machineId;
                        return (
                          <button
                            key={row.key}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            disabled={reason !== null}
                            onClick={() => setPicked(row.environmentId)}
                            className={cn(
                              "flex min-w-0 items-center gap-3 border-t border-border px-3 py-2 text-left text-sm first:border-t-0",
                              reason === null
                                ? "cursor-pointer hover:bg-accent"
                                : "cursor-not-allowed opacity-60",
                              on && "bg-primary/6",
                            )}
                            data-testid={`gallery-machine-${row.label}`}
                          >
                            <span
                              aria-hidden
                              className={cn(
                                "size-3.5 shrink-0 rounded-full border",
                                on ? "border-4 border-primary" : "border-input",
                              )}
                            />
                            <span className="min-w-0 flex-1 truncate font-medium">{row.label}</span>
                            <span className="shrink-0 truncate text-xs text-muted-foreground">
                              {reason ?? "awake"}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {machineId === null
                        ? "None of your computers is awake. Wake one, then come back."
                        : `Sees only ${machineLabel}. Your other computers have their own assistants.`}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      onClick={() => void create()}
                      disabled={!canCreate}
                      className="max-w-full"
                      data-testid="gallery-create"
                    >
                      {creating ? <LoaderCircleIcon className="size-4 animate-spin" /> : null}
                      <span className="truncate">
                        {trimmedName ? `Create ${trimmedName}` : "Create assistant"}
                      </span>
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={creating}
                      onClick={() => setStep("pick")}
                      data-testid="gallery-back"
                    >
                      Back to characters
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
