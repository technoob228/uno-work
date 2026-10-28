/**
 * "New assistant" as a gallery of characters (variant B, Misha 27.10: "like
 * Grok companions"). Step 1 picks a ready character with a role; step 2 makes
 * it yours — name, role, character (three sliders + tags), face, how it works
 * and the computer it lives on. Pure data and rules; the screen is
 * `AssistantGallery.tsx`.
 */
import type { AssistantPersona } from "@t3tools/contracts";

import { EMOJI_GROUPS } from "./assistantAvatar.logic";
import type { AvatarTone } from "./assistantTeam.logic";

export type GalleryRole = "Secretary" | "Marketer" | "Developer" | "Researcher" | "Support";

export const GALLERY_ROLES: ReadonlyArray<GalleryRole> = [
  "Secretary",
  "Marketer",
  "Developer",
  "Researcher",
  "Support",
];

export const GALLERY_TAGS = [
  "Warm",
  "Brief",
  "Direct",
  "Playful",
  "Careful",
  "Bold",
  "Nerdy",
  "Formal",
  "Chatty",
  "Funny",
  "Curious",
  "Patient",
] as const;
export type GalleryTag = (typeof GALLERY_TAGS)[number];

/** The three sliders: 0 = the left word, 100 = the right word. */
export interface GallerySliders {
  readonly chatty: number;
  readonly bold: number;
  readonly playful: number;
}

export type GallerySliderId = keyof GallerySliders;

export const GALLERY_SLIDERS: ReadonlyArray<{
  readonly id: GallerySliderId;
  readonly left: string;
  readonly right: string;
}> = [
  { id: "chatty", left: "Brief", right: "Chatty" },
  { id: "bold", left: "Careful", right: "Bold" },
  { id: "playful", left: "Formal", right: "Playful" },
];

export const MIDDLE_SLIDERS: GallerySliders = { chatty: 50, bold: 50, playful: 50 };

export interface GalleryCharacter {
  readonly id: "mia" | "leo" | "bolt" | "nova" | "juno";
  readonly name: string;
  readonly emoji: string;
  readonly tone: AvatarTone;
  readonly role: GalleryRole;
  /** What it might say on a normal day. */
  readonly quote: string;
  readonly tags: ReadonlyArray<GalleryTag>;
  readonly sliders: GallerySliders;
}

export const GALLERY_CHARACTERS: ReadonlyArray<GalleryCharacter> = [
  {
    id: "mia",
    name: "Mia",
    emoji: "🦉",
    tone: "amber",
    role: "Secretary",
    quote: "Your 11:00 moved. I told them you're fine with 15:00.",
    tags: ["Warm", "Brief", "Careful"],
    sliders: { chatty: 30, bold: 40, playful: 60 },
  },
  {
    id: "leo",
    name: "Leo",
    emoji: "🦊",
    tone: "orange",
    role: "Marketer",
    quote: "Tuesday's post got 3× the clicks. Want two more like it?",
    tags: ["Playful", "Bold", "Chatty"],
    sliders: { chatty: 75, bold: 75, playful: 80 },
  },
  {
    id: "bolt",
    name: "Bolt",
    emoji: "🤖",
    tone: "sky",
    role: "Developer",
    quote: "CI is red on shop-site. Fixed the test, PR is up.",
    tags: ["Direct", "Brief", "Nerdy"],
    sliders: { chatty: 20, bold: 60, playful: 40 },
  },
  {
    id: "nova",
    name: "Nova",
    emoji: "👽",
    tone: "violet",
    role: "Researcher",
    quote: "Three suppliers compared. The cheapest one has bad reviews — here's why.",
    tags: ["Curious", "Careful", "Chatty"],
    sliders: { chatty: 70, bold: 30, playful: 50 },
  },
  {
    id: "juno",
    name: "Juno",
    emoji: "🐼",
    tone: "teal",
    role: "Support",
    quote: "Answered 6 customers. One wants a refund — that one's yours.",
    tags: ["Patient", "Warm", "Formal"],
    sliders: { chatty: 50, bold: 35, playful: 25 },
  },
];

/** The Persona tab: character faces, the gallery's first. */
export const GALLERY_PERSONA_FACES: ReadonlyArray<string> = [
  "🦉",
  "🦊",
  "🤖",
  "👽",
  "🐼",
  "🧑‍🚀",
  "🐱",
  "🧙",
];

/** "Build your own" starts with this face. */
export const BLANK_FACE = "🙂";

/** Tone of a face: the character's that wears it, else a calm one. */
export function toneOfFace(emoji: string): AvatarTone {
  const character = GALLERY_CHARACTERS.find((one) => one.emoji === emoji);
  if (character) return character.tone;
  const extra: Record<string, AvatarTone> = { "🧑‍🚀": "slate", "🐱": "rose", "🧙": "emerald" };
  return extra[emoji] ?? "slate";
}

/** What kind of portrait to draw for a face (people → human, and so on). */
export function personaOfFace(emoji: string): AssistantPersona {
  if (["🤖", "👾", "🦾"].includes(emoji)) return "robot";
  if (["👽", "🛸"].includes(emoji)) return "alien";
  const animals = EMOJI_GROUPS.find((group) => group.label === "Animals")?.emojis ?? [];
  if (animals.includes(emoji) || emoji === "🐱") return "animal";
  return "human";
}

/** A slider's word: under 35 the left one, over 65 the right one, nothing in the middle. */
export function sliderWord(
  slider: { readonly left: string; readonly right: string },
  value: number,
): string | null {
  if (value < 35) return slider.left;
  if (value > 65) return slider.right;
  return null;
}

/**
 * Its character in one line: the slider words first, then the tags, each
 * once; only the line's first letter is capital ("Brief, playful, warm").
 */
export function characterLine(sliders: GallerySliders, tags: ReadonlyArray<string>): string {
  const words = [
    ...GALLERY_SLIDERS.map((slider) => sliderWord(slider, sliders[slider.id])),
    ...tags,
  ]
    .filter((word): word is string => word !== null && word.trim() !== "")
    .map((word) => word.trim().toLowerCase());
  const line = [...new Set(words)].join(", ");
  return line ? line.charAt(0).toUpperCase() + line.slice(1) : "";
}

/** Two names are the same when they match ignoring case and spaces at the ends. */
export function sameName(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  return left !== "" && left === b.trim().toLowerCase();
}

export interface NamedAssistant {
  readonly name: string;
  readonly environmentId: string;
  readonly computerLabel: string;
  readonly revoked: boolean;
}

export type SameNameNote =
  | { readonly kind: "none" }
  | { readonly kind: "other-computer"; readonly text: string }
  | { readonly kind: "same-computer"; readonly text: string };

/**
 * Another assistant with this name: on another computer they can live side
 * by side (shown with their computers); on this one — pick another name.
 */
export function sameNameNote(input: {
  readonly name: string;
  readonly environmentId: string | null;
  readonly thisLabel: string;
  readonly existing: ReadonlyArray<NamedAssistant>;
}): SameNameNote {
  const name = input.name.trim();
  if (!name) return { kind: "none" };
  const twins = input.existing.filter((one) => !one.revoked && sameName(one.name, name));
  if (twins.some((one) => one.environmentId === input.environmentId)) {
    return {
      kind: "same-computer",
      text: `${input.thisLabel} already has a ${name}. Pick another name so you can tell them apart.`,
    };
  }
  const other = twins[0];
  if (!other) return { kind: "none" };
  return {
    kind: "other-computer",
    text: `There's a ${name} on ${other.computerLabel} too. They'll show as ${name} · ${input.thisLabel} and ${name} · ${other.computerLabel}.`,
  };
}

/** Why a computer can't take a new assistant now (null: it can). */
export function machineUnavailableReason(row: {
  readonly environmentId: string | null;
  readonly status: string;
  readonly kind: string;
}): string | null {
  if (row.environmentId !== null && row.status === "online") return null;
  return row.kind === "computer"
    ? "asleep — the laptop is closed"
    : "asleep — Free computers sleep. Plus keeps it on";
}

/** The computer it goes on: the one asked for, else the one in view, else the first awake one. */
export function defaultMachine(
  rows: ReadonlyArray<{
    readonly environmentId: string | null;
    readonly status: string;
    readonly kind: string;
  }>,
  wanted: ReadonlyArray<string | null | undefined>,
): string | null {
  const awake = rows.filter((row) => machineUnavailableReason(row) === null);
  for (const id of wanted) {
    if (id && awake.some((row) => row.environmentId === id)) return id;
  }
  return awake[0]?.environmentId ?? null;
}
