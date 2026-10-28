/**
 * Its face (Misha 23.10: "emojis feel inhuman — let me upload a picture, or
 * pick an emoji, or a persona"): three tabs —
 *
 * - Upload: a PNG / JPG / WebP up to 2 MB (pick or drop), cut to its centered
 *   square here and kept as a 256 px picture in its folder;
 * - Emoji: a bigger set, people / animals / robots and aliens first;
 * - Persona: Human / Animal / Robot / Alien — Uno AI draws a portrait in one
 *   friendly style, "Another one" draws again. Where pictures can't be drawn
 *   (signed out, no Uno AI here, a limit) it says so in a line and opens Emoji.
 *
 * Opened from its face on its page. Uno keeps its own face.
 */
import type { AssistantPersona, EnvironmentId } from "@t3tools/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { ImageUpIcon, LoaderCircleIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { type DragEvent, useRef, useState } from "react";

import {
  generateAssistantAvatar,
  setAssistantAvatar,
  updateAssistantTeam,
} from "../../lib/managerApi";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { AVATAR_IMAGE_KEY, AssistantAvatar, avatarImageOf } from "./AssistantAvatar";
import {
  AVATAR_FILE_TYPES,
  AVATAR_SIZE_PX,
  EMOJI_GROUPS,
  PERSONAS,
  avatarFileProblem,
  base64OfDataUrl,
  centerSquare,
} from "./assistantAvatar.logic";
import { AVATARS, type AvatarTone } from "./assistantTeam.logic";
import type { TeamMember } from "./useAssistantTeam";
import { useTeamActions } from "./useTeamActions";

type Tab = "upload" | "emoji" | "persona";

const TABS: ReadonlyArray<{ readonly id: Tab; readonly label: string }> = [
  { id: "upload", label: "Upload" },
  { id: "emoji", label: "Emoji" },
  { id: "persona", label: "Persona" },
];

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

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

/** A tone for an emoji: the one the classic faces pair it with, else the current one. */
function toneFor(emoji: string, current: AvatarTone): AvatarTone {
  return AVATARS.find((avatar) => avatar.emoji === emoji)?.tone ?? current;
}

export function AssistantFacePicker(props: {
  readonly member: TeamMember;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { member } = props;
  const { profile } = member;
  const environmentId = member.environmentId as EnvironmentId;
  const queryClient = useQueryClient();
  const actions = useTeamActions();
  const fileInput = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<Tab>("upload");
  const [preview, setPreview] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<"read" | "draw" | "save" | null>(null);
  const [persona, setPersona] = useState<AssistantPersona | null>(null);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1000));
  const [dragging, setDragging] = useState(false);

  const close = () => {
    props.onOpenChange(false);
    setPreview(null);
    setProblem(null);
    setPersona(null);
  };
  const switchTab = (next: Tab) => {
    setTab(next);
    setPreview(null);
    setProblem(null);
  };
  const refresh = async () => {
    await actions.refresh();
    await queryClient.invalidateQueries({ queryKey: AVATAR_IMAGE_KEY });
  };

  const takeFile = async (file: File | undefined) => {
    if (!file) return;
    const wrong = avatarFileProblem(file);
    if (wrong) {
      setProblem(wrong);
      return;
    }
    setBusy("read");
    setProblem(null);
    try {
      setPreview(await squarePicture(await readFile(file)));
    } catch (cause) {
      setProblem(errorText(cause, "Couldn't open that picture."));
    } finally {
      setBusy(null);
    }
  };

  const draw = async (next: AssistantPersona, nextSeed: number) => {
    setPersona(next);
    setSeed(nextSeed);
    setBusy("draw");
    setProblem(null);
    setPreview(null);
    try {
      const { image } = await generateAssistantAvatar({
        environmentId,
        projectId: member.projectId,
        persona: next,
        seed: nextSeed,
      });
      setPreview(await squarePicture(image));
    } catch (cause) {
      // Pictures can't be drawn here: the emoji set is one click away.
      setTab("emoji");
      setPersona(null);
      setProblem(
        `Couldn't draw a portrait right now — ${errorText(cause, "Uno AI didn't answer")}. Pick an emoji instead.`,
      );
    } finally {
      setBusy(null);
    }
  };

  const applyPicture = async () => {
    const base64 = preview ? base64OfDataUrl(preview) : null;
    if (!base64) return;
    setBusy("save");
    try {
      await setAssistantAvatar({ environmentId, projectId: member.projectId, image: base64 });
      await refresh();
      toastManager.add({ type: "success", title: `${profile.name} has a new face` });
      close();
    } catch (cause) {
      setProblem(errorText(cause, "Its computer didn't take the picture."));
    } finally {
      setBusy(null);
    }
  };

  const applyEmoji = async (emoji: string) => {
    setBusy("save");
    try {
      await updateAssistantTeam({
        environmentId,
        projectId: member.projectId,
        emoji,
        tone: toneFor(emoji, profile.tone),
      });
      if (profile.avatar) {
        await setAssistantAvatar({ environmentId, projectId: member.projectId, image: null });
      }
      await refresh();
      close();
    } catch (cause) {
      setProblem(errorText(cause, "Its computer didn't answer."));
    } finally {
      setBusy(null);
    }
  };

  const removePicture = async () => {
    setBusy("save");
    try {
      await setAssistantAvatar({ environmentId, projectId: member.projectId, image: null });
      await refresh();
      close();
    } catch (cause) {
      setProblem(errorText(cause, "Its computer didn't answer."));
    } finally {
      setBusy(null);
    }
  };

  const onDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setDragging(false);
    void takeFile(event.dataTransfer.files[0]);
  };

  return (
    <Dialog open={props.open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogPopup className="max-w-[28rem]" data-testid="assistant-face-picker">
        <div className="flex flex-col gap-4 p-5">
          <div className="flex items-center gap-3 pr-8">
            <AssistantAvatar
              emoji={profile.emoji}
              tone={profile.tone}
              image={preview ? null : avatarImageOf(profile)}
              src={preview}
              className="size-12"
              emojiClassName="text-2xl"
            />
            <div className="flex min-w-0 flex-col">
              <DialogTitle className="text-base">{profile.name}'s face</DialogTitle>
              <span className="text-xs text-muted-foreground">
                A picture, an emoji, or a portrait Uno AI draws.
              </span>
            </div>
          </div>

          <div className="flex gap-1 rounded-lg bg-muted/60 p-0.5" role="tablist">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                onClick={() => switchTab(item.id)}
                data-testid={`assistant-face-tab-${item.id}`}
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

          {problem ? (
            <p
              className="text-xs text-amber-700 dark:text-amber-400"
              data-testid="assistant-face-problem"
            >
              {problem}
            </p>
          ) : null}

          {tab === "upload" ? (
            preview ? null : (
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                disabled={busy !== null}
                data-testid="assistant-face-upload"
                className={cn(
                  "flex h-32 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed text-sm text-muted-foreground transition-colors hover:bg-accent/40",
                  dragging ? "border-primary bg-primary/5" : "border-border",
                )}
              >
                {busy === "read" ? (
                  <LoaderCircleIcon className="size-5 animate-spin" />
                ) : (
                  <ImageUpIcon className="size-5" />
                )}
                Choose a picture or drop it here
                <span className="text-xs">PNG, JPG or WebP, up to 2 MB · cut to a square</span>
              </button>
            )
          ) : null}
          <input
            ref={fileInput}
            type="file"
            accept={AVATAR_FILE_TYPES.join(",")}
            className="hidden"
            onChange={(event) => {
              void takeFile(event.currentTarget.files?.[0]);
              event.currentTarget.value = "";
            }}
          />

          {tab === "emoji" ? (
            <div
              className="flex max-h-64 flex-col gap-2 overflow-y-auto"
              data-testid="assistant-face-emoji"
            >
              {EMOJI_GROUPS.map((group) => (
                <div key={group.label} className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium text-muted-foreground">
                    {group.label}
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {group.emojis.map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void applyEmoji(emoji)}
                        aria-label={emoji}
                        className={cn(
                          "grid size-9 cursor-pointer place-items-center rounded-lg text-xl hover:bg-accent",
                          !profile.avatar &&
                            profile.emoji === emoji &&
                            "bg-primary/10 ring-1 ring-primary/40",
                        )}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {tab === "persona" ? (
            <div className="flex flex-col gap-2" data-testid="assistant-face-persona">
              <div className="grid grid-cols-4 gap-1.5">
                {PERSONAS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void draw(item.id, seed + 1)}
                    data-testid={`assistant-face-persona-${item.id}`}
                    className={cn(
                      "flex cursor-pointer flex-col items-center gap-1 rounded-xl border py-2.5 text-xs transition-colors hover:bg-accent/40 disabled:cursor-default",
                      persona === item.id ? "border-primary/50 bg-primary/5" : "border-border",
                    )}
                  >
                    <span className="text-2xl leading-none">{item.emoji}</span>
                    {item.label}
                  </button>
                ))}
              </div>
              {busy === "draw" ? (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <LoaderCircleIcon className="size-3.5 animate-spin" /> Drawing a portrait…
                </p>
              ) : persona === null ? (
                <p className="text-xs text-muted-foreground">
                  Pick one: Uno AI draws a portrait in one friendly style. Each picture counts
                  toward your daily picture limit.
                </p>
              ) : null}
            </div>
          ) : null}

          {preview ? (
            <div className="flex items-center gap-3" data-testid="assistant-face-preview">
              <AssistantAvatar
                emoji={profile.emoji}
                tone={profile.tone}
                src={preview}
                className="size-20"
              />
              <div className="flex flex-col gap-1.5">
                <Button
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void applyPicture()}
                  data-testid="assistant-face-use"
                >
                  {busy === "save" ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}
                  Use this face
                </Button>
                {tab === "persona" && persona ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void draw(persona, seed + 1)}
                    data-testid="assistant-face-another"
                  >
                    <RefreshCwIcon className="size-3.5" /> Another one
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => setPreview(null)}
                  >
                    Choose another
                  </Button>
                )}
              </div>
            </div>
          ) : null}

          {profile.avatar ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void removePicture()}
              className="inline-flex w-fit cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <Trash2Icon className="size-3" /> Remove the picture (back to{" "}
              {profile.emoji ?? "its emoji"})
            </button>
          ) : null}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
