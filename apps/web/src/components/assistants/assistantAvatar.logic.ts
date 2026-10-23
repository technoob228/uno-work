/**
 * An assistant's face (Misha 23.10: "emojis feel inhuman — let me upload a
 * picture, or pick an emoji, or a persona: animal, robot, human, alien"):
 * what a picture may be, how it is cut to a square, the emoji set, the
 * personas, and the random face a one-click assistant starts with.
 *
 * Pure: no I/O, no React. The daemon checks the picture again
 * (`apps/server/src/assistants/assistantAvatar.ts`).
 */
import { ASSISTANT_AVATAR_MAX_BYTES, type AssistantPersona } from "@t3tools/contracts";

import type { AvatarTone } from "./assistantTeam.logic";

export const AVATAR_FILE_TYPES: ReadonlyArray<string> = ["image/png", "image/jpeg", "image/webp"];

/** The side of the square picture we keep (sidebar to page header). */
export const AVATAR_SIZE_PX = 256;

/** Why this file can't be its face, or null when it can. */
export function avatarFileProblem(file: {
  readonly type: string;
  readonly size: number;
}): string | null {
  if (!AVATAR_FILE_TYPES.includes(file.type)) return "Use a PNG, JPG or WebP picture.";
  if (file.size > ASSISTANT_AVATAR_MAX_BYTES) return "The picture is bigger than 2 MB.";
  if (file.size === 0) return "That file is empty.";
  return null;
}

/** The biggest centered square of a picture (what is kept of a photo). */
export function centerSquare(
  width: number,
  height: number,
): { readonly x: number; readonly y: number; readonly side: number } {
  const side = Math.max(0, Math.min(width, height));
  return { x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), side };
}

/** The base64 of a `data:` URL (what the daemon takes). */
export function base64OfDataUrl(dataUrl: string): string | null {
  const match = /^data:image\/(png|jpeg|webp);base64,(.+)$/i.exec(dataUrl.trim());
  return match?.[2] ?? null;
}

export const PERSONAS: ReadonlyArray<{
  readonly id: AssistantPersona;
  readonly label: string;
  readonly emoji: string;
}> = [
  { id: "human", label: "Human", emoji: "🧑" },
  { id: "animal", label: "Animal", emoji: "🦊" },
  { id: "robot", label: "Robot", emoji: "🤖" },
  { id: "alien", label: "Alien", emoji: "👽" },
];

/** The Emoji tab: faces first — people, animals, robots and aliens — then a few things. */
export const EMOJI_GROUPS: ReadonlyArray<{
  readonly label: string;
  readonly emojis: ReadonlyArray<string>;
}> = [
  {
    label: "People",
    emojis: [
      "🧑",
      "👩",
      "👨",
      "🧔",
      "👩‍🦰",
      "👨‍🦱",
      "👩‍🦳",
      "👵",
      "👴",
      "🧑‍💻",
      "👩‍🔬",
      "🧑‍🎨",
      "🧑‍🚀",
      "🕵️",
      "🧙",
      "🥷",
    ],
  },
  {
    label: "Animals",
    emojis: [
      "🦊",
      "🐱",
      "🐶",
      "🦉",
      "🐼",
      "🦦",
      "🐨",
      "🐯",
      "🦁",
      "🐸",
      "🐙",
      "🦄",
      "🐧",
      "🐻",
      "🐰",
      "🦝",
    ],
  },
  { label: "Robots & aliens", emojis: ["🤖", "👾", "👽", "🛸", "🦾", "🧠", "👻", "🎃"] },
  { label: "Things", emojis: ["🚀", "🔭", "🛠️", "🌿", "📚", "🎯", "💡", "🛡️"] },
];

/** Background tones of an emoji face, in the order the faces cycle through them. */
const TONES: ReadonlyArray<AvatarTone> = [
  "amber",
  "teal",
  "orange",
  "violet",
  "sky",
  "emerald",
  "rose",
  "slate",
];

/** The faces a one-click assistant starts with: people, animals, robots, aliens — never a generic one. */
export const PERSONA_FACES: ReadonlyArray<string> = [
  ...EMOJI_GROUPS[0]!.emojis,
  ...EMOJI_GROUPS[1]!.emojis,
  "🤖",
  "👾",
  "👽",
];

/** A random persona face and tone for a new assistant (`random` in [0, 1)). */
export function randomPersonaFace(
  random: () => number,
  taken: ReadonlyArray<string | null> = [],
): { readonly emoji: string; readonly tone: AvatarTone } {
  const used = new Set(taken);
  const free = PERSONA_FACES.filter((face) => !used.has(face));
  const faces = free.length > 0 ? free : PERSONA_FACES;
  const pick = (count: number) => Math.min(count - 1, Math.floor(random() * count));
  return { emoji: faces[pick(faces.length)]!, tone: TONES[pick(TONES.length)]! };
}
