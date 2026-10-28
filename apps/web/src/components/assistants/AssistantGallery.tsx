/**
 * Variant A (28.10): your own assistants, the Grok way — behind Uno's page →
 * Advanced, so the main path stays "one Uno".
 *
 * 1. Gallery: ready characters, each with a role and a line in its voice;
 *    "Build your own" next to them.
 * 2. Builder: name (with a counter), role, character (three sliders and up
 *    to three tags), face (Emoji / Persona drawn by Uno AI / Upload), the
 *    two modes. Create → it opens its chat and speaks first, in character.
 *
 * Everything goes through the daemon's real routes: create, team (role,
 * character), avatar, its chat. Drawing a face can fail (Uno AI busy, signed
 * out): the builder says so in a line and keeps the emoji.
 */
import type { AssistantPersona, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ImageUpIcon,
  LoaderCircleIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useRef, useState } from "react";

import {
  createAssistant,
  ensureAssistantChat,
  generateAssistantAvatar,
  setAssistantAvatar,
  updateAssistantTeam,
} from "../../lib/managerApi";
import { cn } from "../../lib/utils";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { buildThreadRouteParams } from "../../threadRoutes";
import { SidebarShowButton } from "../sidebar/SidebarShowButton";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { AssistantAvatar } from "./AssistantAvatar";
import { MODE_COPY, ModeIcon, type AssistantMode } from "./AssistantModeChip";
import {
  BUILDER_EMOJI,
  CHARACTER_TAGS,
  GALLERY,
  type GalleryCharacter,
  NAME_MAX,
  ROLES,
  SLIDERS,
  type Sliders,
  characterText,
  cleanName,
  toggleTag,
} from "./assistantGallery.logic";
import type { AvatarTone } from "./assistantTeam.logic";
import { LOCAL_ASSISTANTS_KEY } from "./useAssistants";
import { useUnoHome, waitForThread } from "./useUnoHome";

const PERSONAS: ReadonlyArray<{ readonly id: AssistantPersona; readonly label: string }> = [
  { id: "human", label: "Human" },
  { id: "animal", label: "Animal" },
  { id: "robot", label: "Robot" },
  { id: "alien", label: "Alien" },
];

const TONE_BG: Record<string, string> = {
  amber: "bg-amber-500/15",
  orange: "bg-orange-500/15",
  sky: "bg-sky-500/15",
  violet: "bg-violet-500/15",
  teal: "bg-teal-500/15",
  rose: "bg-rose-500/15",
  emerald: "bg-emerald-500/15",
  slate: "bg-slate-500/15",
};

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/** Any picture → a 256 px PNG, as base64 (what the daemon keeps). */
async function pngBase64(src: string): Promise<string> {
  const image = new Image();
  image.decoding = "async";
  image.src = src;
  await image.decode();
  const side = Math.min(image.naturalWidth || 256, image.naturalHeight || 256);
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No canvas here.");
  const sx = ((image.naturalWidth || side) - side) / 2;
  const sy = ((image.naturalHeight || side) - side) / 2;
  context.drawImage(image, sx, sy, side, side, 0, 0, 256, 256);
  return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

async function waitForProject(environmentId: string, projectId: string): Promise<void> {
  const here = () =>
    selectProjectsAcrossEnvironments(useStore.getState()).some(
      (project) => project.environmentId === environmentId && project.id === projectId,
    );
  for (let tries = 0; tries < 50 && !here(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// ── The gallery ───────────────────────────────────────────────────────────

function CharacterCard(props: {
  readonly character: GalleryCharacter;
  readonly onPick: () => void;
}) {
  const { character } = props;
  return (
    <button
      type="button"
      onClick={props.onPick}
      data-testid="gallery-character"
      data-character={character.id}
      className="flex cursor-pointer flex-col gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent/30"
    >
      <span className="flex items-center gap-3">
        <span
          className={cn(
            "grid size-11 shrink-0 place-items-center rounded-full text-2xl",
            TONE_BG[character.tone],
          )}
        >
          {character.emoji}
        </span>
        <span className="min-w-0">
          <span className="block text-base font-semibold">{character.name}</span>
          <span className="block text-xs font-medium text-primary">{character.role}</span>
        </span>
      </span>
      <span className="text-sm text-foreground/90 italic">“{character.quote}”</span>
      <span className="mt-auto flex flex-wrap gap-1">
        {character.tags.map((tag) => (
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

// ── The builder ───────────────────────────────────────────────────────────

type Face =
  | { readonly kind: "emoji"; readonly emoji: string }
  | { readonly kind: "image"; readonly src: string };

function Builder(props: { readonly from: GalleryCharacter | null; readonly onBack: () => void }) {
  const { from } = props;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const home = useUnoHome();
  const environmentId = home.uno?.environmentId ?? null;
  const [name, setName] = useState(from?.name ?? "");
  const [role, setRole] = useState<string>(from?.role ?? "Secretary");
  const [otherRole, setOtherRole] = useState("");
  const [sliders, setSliders] = useState<Sliders>(
    from?.sliders ?? { talk: 50, risk: 40, tone: 50 },
  );
  const [tags, setTags] = useState<ReadonlyArray<string>>(from?.tags ?? []);
  const [face, setFace] = useState<Face>({ kind: "emoji", emoji: from?.emoji ?? "🦉" });
  const [tone] = useState<AvatarTone>((from?.tone as AvatarTone | undefined) ?? "violet");
  const [faceTab, setFaceTab] = useState<"emoji" | "persona" | "upload">("emoji");
  const [persona, setPersona] = useState<AssistantPersona | null>(null);
  const [seed, setSeed] = useState(1);
  const [drawing, setDrawing] = useState(false);
  const [faceProblem, setFaceProblem] = useState<string | null>(null);
  const [mode, setMode] = useState<AssistantMode>("asks-first");
  const [creating, setCreating] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const clean = cleanName(name);
  const roleName = role === "Something else" ? otherRole.trim() || "Assistant" : role;
  const emoji = face.kind === "emoji" ? face.emoji : (from?.emoji ?? "🙂");

  const draw = async (next: AssistantPersona, nextSeed: number) => {
    if (environmentId === null) return;
    setPersona(next);
    setSeed(nextSeed);
    setDrawing(true);
    setFaceProblem(null);
    try {
      const { image } = await generateAssistantAvatar({
        environmentId: environmentId as EnvironmentId,
        projectId: "assistant-new",
        persona: next,
        seed: nextSeed,
      });
      setFace({ kind: "image", src: image });
    } catch (cause) {
      setFaceTab("emoji");
      setPersona(null);
      setFaceProblem(
        `Couldn't draw a face right now — ${errorText(cause, "Uno AI didn't answer")}. Keep the emoji; you can draw one later from its page.`,
      );
    } finally {
      setDrawing(false);
    }
  };

  const takeFile = async (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 2_000_000) {
      setFaceProblem("A PNG, JPG or WebP up to 2 MB, please.");
      return;
    }
    setFaceProblem(null);
    setFace({ kind: "image", src: await readFile(file) });
  };

  const create = async () => {
    if (clean === null || environmentId === null || creating) return;
    setCreating(true);
    try {
      const target = environmentId as EnvironmentId;
      const { projectId } = await createAssistant({
        environmentId: target,
        name: clean,
        emoji,
        access: { preset: mode === "itself" ? "full" : "helper", projects: "all" },
      });
      await updateAssistantTeam({
        environmentId: target,
        projectId,
        tone,
        roles: [roleName],
        character: characterText(sliders, tags),
        setup: "done",
      });
      if (face.kind === "image") {
        try {
          await setAssistantAvatar({
            environmentId: target,
            projectId,
            image: await pngBase64(face.src),
          });
        } catch {
          // The emoji stays; the face can be set again from its page.
        }
      }
      await waitForProject(environmentId, projectId);
      await queryClient.invalidateQueries({ queryKey: LOCAL_ASSISTANTS_KEY });
      const { threadId } = await ensureAssistantChat({
        environmentId: target,
        projectId: projectId as ProjectId,
      });
      await waitForThread(environmentId, threadId);
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({ environmentId: target, threadId }),
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Couldn't make it",
        description: errorText(cause, "Uno's computer didn't answer."),
      });
    } finally {
      setCreating(false);
    }
  };

  const nameLength = name.trim().length;

  return (
    <div className="flex flex-col gap-6" data-testid="gallery-builder">
      <div>
        <h1 className="text-2xl font-semibold">
          {from ? `Make ${from.name} yours` : "Build your own"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">Everything here can be changed later.</p>
      </div>
      <div className="grid gap-8 md:grid-cols-[13rem_1fr]">
        {/* Face */}
        <div className="flex flex-col items-center gap-3" data-testid="gallery-face">
          <span
            className={cn(
              "grid size-28 place-items-center overflow-hidden rounded-full text-6xl",
              TONE_BG[tone],
            )}
          >
            {drawing ? (
              <LoaderCircleIcon className="size-8 animate-spin text-muted-foreground" />
            ) : face.kind === "image" ? (
              <img
                src={face.src}
                alt=""
                className="size-full object-cover"
                data-testid="gallery-face-image"
              />
            ) : (
              face.emoji
            )}
          </span>
          <div className="flex rounded-lg border border-border p-0.5 text-xs">
            {(["emoji", "persona", "upload"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => {
                  setFaceTab(tab);
                  if (tab === "upload") fileRef.current?.click();
                }}
                data-testid={`gallery-face-tab-${tab}`}
                className={cn(
                  "cursor-pointer rounded-md px-2.5 py-1 capitalize",
                  faceTab === tab
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {tab}
              </button>
            ))}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(event) => void takeFile(event.target.files?.[0])}
          />
          {faceTab === "emoji" ? (
            <div className="grid grid-cols-5 gap-1">
              {BUILDER_EMOJI.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setFace({ kind: "emoji", emoji: item })}
                  className={cn(
                    "grid size-8 cursor-pointer place-items-center rounded-md text-lg hover:bg-accent",
                    face.kind === "emoji" &&
                      face.emoji === item &&
                      "bg-accent ring-1 ring-primary/40",
                  )}
                >
                  {item}
                </button>
              ))}
            </div>
          ) : faceTab === "persona" ? (
            <div className="flex flex-col items-center gap-2">
              <div className="flex flex-wrap justify-center gap-1">
                {PERSONAS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    disabled={drawing}
                    onClick={() => void draw(item.id, seed)}
                    data-testid={`gallery-persona-${item.id}`}
                    className={cn(
                      "cursor-pointer rounded-full border px-2.5 py-1 text-xs",
                      persona === item.id
                        ? "border-primary/60 bg-primary/10 text-foreground"
                        : "border-border text-muted-foreground hover:bg-accent",
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              {persona && !drawing ? (
                <button
                  type="button"
                  onClick={() => void draw(persona, seed + 1)}
                  className="inline-flex cursor-pointer items-center gap-1 text-xs text-primary hover:underline"
                >
                  <RefreshCwIcon className="size-3" /> Another one
                </button>
              ) : (
                <p className="text-center text-[11px] text-muted-foreground">
                  Uno AI draws a portrait in about 10 seconds.
                </p>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="inline-flex cursor-pointer items-center gap-1 text-xs text-primary hover:underline"
            >
              <ImageUpIcon className="size-3.5" /> Pick a picture
            </button>
          )}
          {faceProblem ? (
            <p
              className="text-center text-xs text-destructive"
              role="alert"
              data-testid="gallery-face-problem"
            >
              {faceProblem}
            </p>
          ) : null}
        </div>

        {/* Who it is */}
        <div className="flex min-w-0 flex-col gap-5">
          <label className="flex flex-col gap-1.5">
            <span className="flex items-center justify-between text-sm font-medium">
              Name
              <span
                className={cn(
                  "text-[11px] font-normal tabular-nums",
                  nameLength >= NAME_MAX - 4 ? "text-amber-600" : "text-muted-foreground",
                )}
                data-testid="gallery-name-count"
              >
                {nameLength}/{NAME_MAX}
              </span>
            </span>
            <input
              value={name}
              maxLength={NAME_MAX}
              onChange={(event) => setName(event.target.value.slice(0, NAME_MAX))}
              placeholder="Mia, Rex, Ivy…"
              data-testid="gallery-name"
              className="h-9 rounded-md border border-input bg-background px-2.5 text-sm outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Role</span>
            <div className="flex flex-wrap gap-1.5">
              {ROLES.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setRole(item)}
                  aria-pressed={role === item}
                  data-testid={`gallery-role-${item}`}
                  className={cn(
                    "cursor-pointer rounded-full border px-2.5 py-1 text-xs",
                    role === item
                      ? "border-primary/60 bg-primary/10 font-medium text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent",
                  )}
                >
                  {item}
                </button>
              ))}
            </div>
            {role === "Something else" ? (
              <input
                value={otherRole}
                maxLength={30}
                onChange={(event) => setOtherRole(event.target.value)}
                placeholder="Bookkeeper, recruiter, tutor…"
                className="h-8 w-64 max-w-full rounded-md border border-input bg-background px-2 text-sm outline-hidden"
              />
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Character</span>
            {SLIDERS.map((slider) => (
              <label
                key={slider.id}
                className="grid grid-cols-[4.5rem_1fr_4.5rem] items-center gap-3 text-xs text-muted-foreground"
              >
                <span>{slider.left}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={sliders[slider.id]}
                  onChange={(event) =>
                    setSliders({ ...sliders, [slider.id]: Number(event.target.value) })
                  }
                  aria-label={`${slider.left} or ${slider.right}`}
                  className="accent-primary"
                />
                <span className="text-right">{slider.right}</span>
              </label>
            ))}
            <div className="flex flex-wrap gap-1.5 pt-1">
              {CHARACTER_TAGS.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => setTags(toggleTag(tags, tag))}
                  aria-pressed={tags.includes(tag)}
                  className={cn(
                    "cursor-pointer rounded-full border px-2 py-0.5 text-[11px]",
                    tags.includes(tag)
                      ? "border-primary/60 bg-primary/10 font-medium text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent",
                  )}
                >
                  {tag}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">Up to three tags.</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">How it works</span>
            <div className="grid gap-2 sm:grid-cols-2">
              {(["itself", "asks-first"] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setMode(item)}
                  aria-pressed={mode === item}
                  data-testid={`gallery-mode-${item}`}
                  className={cn(
                    "flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-left",
                    mode === item
                      ? "border-primary/60 bg-primary/[0.05] ring-1 ring-primary/30"
                      : "border-border hover:bg-accent/50",
                  )}
                >
                  <ModeIcon mode={item} className="mt-0.5 size-4 shrink-0" />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{MODE_COPY[item].label}</span>
                    <span className="text-xs text-muted-foreground">{MODE_COPY[item].detail}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Uses Uno's apps and lives on {home.label}. Remove it any time from its page.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={() => void create()}
              disabled={clean === null || creating || environmentId === null}
              data-testid="gallery-create"
            >
              {creating ? <LoaderCircleIcon className="size-4 animate-spin" /> : null}
              {clean ? `Create ${clean.length > 18 ? `${clean.slice(0, 18)}…` : clean}` : "Create"}
            </Button>
            <Button variant="ghost" onClick={props.onBack}>
              Back to characters
            </Button>
            {clean === null && name.length > 0 ? (
              <span className="text-xs text-destructive">Give it a name.</span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── The page ──────────────────────────────────────────────────────────────

export function AssistantGallery(props: { readonly character?: string }) {
  const navigate = useNavigate();
  const home = useUnoHome();
  const picked =
    props.character === undefined
      ? undefined
      : (GALLERY.find((item) => item.id === props.character) ?? null);
  const open = (character: string | null) =>
    void navigate({
      to: "/assistants",
      search: character ? { view: "gallery", character } : { view: "gallery" },
    });
  const backToUno = () =>
    home.uno
      ? void navigate({
          to: "/assistants",
          search: { view: "profile", env: home.uno.environmentId, project: home.uno.projectId },
        })
      : void navigate({ to: "/" });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden"
        data-testid="assistant-gallery"
      >
        <header className="flex min-h-12 items-center gap-2 border-b border-border px-3 sm:px-5">
          <SidebarShowButton />
          <Button
            size="xs"
            variant="ghost"
            onClick={picked === undefined ? backToUno : () => open(null)}
          >
            <ArrowLeftIcon className="size-3.5" />
            {picked === undefined ? (home.uno?.profile.name ?? "Uno") : "Characters"}
          </Button>
          <span className="truncate text-xs text-muted-foreground">
            {home.uno?.profile.name ?? "Uno"} › Advanced › Your own assistants
          </span>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
            {picked === undefined ? (
              <>
                <div>
                  <h1 className="text-2xl font-semibold">Who do you need?</h1>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Pick a character — it starts in that role right away. Or build your own in a
                    minute. Uno stays your main assistant.
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {GALLERY.map((character) => (
                    <CharacterCard
                      key={character.id}
                      character={character}
                      onPick={() => open(character.id)}
                    />
                  ))}
                  <button
                    type="button"
                    onClick={() => open("own")}
                    data-testid="gallery-build-own"
                    className="flex min-h-44 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border p-4 text-center hover:border-primary/50 hover:bg-accent/30"
                  >
                    <PlusIcon className="size-6 text-primary" />
                    <span className="text-base font-semibold">Build your own</span>
                    <span className="text-xs text-muted-foreground">
                      Name, character, role, face
                    </span>
                  </button>
                </div>
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <AssistantAvatar emoji={null} tone="violet" className="size-5" />
                  Not sure? Just ask Uno — it does all of this too.
                </p>
              </>
            ) : (
              <Builder key={props.character} from={picked} onBack={() => open(null)} />
            )}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
