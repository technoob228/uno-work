/**
 * Your own assistants, the Grok way (Misha 27.10: "name, personality and
 * role — like the Grok companions"): a gallery of ready characters, each
 * with a role, and "Build your own" — name, role, character (three sliders
 * plus a few tags), face, mode. In variant A this sits behind Uno's page →
 * Advanced: Uno is the one assistant of the account, these are extras.
 *
 * Pure data and rules; the screens are `AssistantGallery.tsx`.
 */
import type { AvatarTone } from "./assistantTeam.logic";

export const ROLES = [
  "Secretary",
  "Marketer",
  "Developer",
  "Researcher",
  "Support",
  "Something else",
] as const;
export type GalleryRole = (typeof ROLES)[number];

export const CHARACTER_TAGS = [
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
  "Patient",
  "Curious",
] as const;

/** Three sliders, 0…100: left word at 0, right word at 100. */
export const SLIDERS = [
  { id: "talk", left: "Brief", right: "Chatty" },
  { id: "risk", left: "Careful", right: "Bold" },
  { id: "tone", left: "Formal", right: "Playful" },
] as const;
export type SliderId = (typeof SLIDERS)[number]["id"];
export type Sliders = Readonly<Record<SliderId, number>>;

export const NAME_MAX = 40;

export interface GalleryCharacter {
  readonly id: string;
  readonly name: string;
  readonly role: GalleryRole;
  readonly emoji: string;
  readonly tone: AvatarTone;
  /** What it sounds like at work — one line in its voice. */
  readonly quote: string;
  readonly tags: ReadonlyArray<string>;
  readonly sliders: Sliders;
}

export const GALLERY: ReadonlyArray<GalleryCharacter> = [
  {
    id: "mia",
    name: "Mia",
    role: "Secretary",
    emoji: "🦉",
    tone: "amber",
    quote: "Your 11:00 moved. I told them you're fine with 15:00.",
    tags: ["Warm", "Brief", "Careful"],
    sliders: { talk: 25, risk: 30, tone: 40 },
  },
  {
    id: "leo",
    name: "Leo",
    role: "Marketer",
    emoji: "🦊",
    tone: "orange",
    quote: "Tuesday's post got 3× the clicks. Want two more like it?",
    tags: ["Playful", "Bold", "Chatty"],
    sliders: { talk: 75, risk: 70, tone: 80 },
  },
  {
    id: "bolt",
    name: "Bolt",
    role: "Developer",
    emoji: "🤖",
    tone: "sky",
    quote: "CI is red on landing. Fixed the test, PR is up.",
    tags: ["Direct", "Brief", "Nerdy"],
    sliders: { talk: 15, risk: 55, tone: 35 },
  },
  {
    id: "nova",
    name: "Nova",
    role: "Researcher",
    emoji: "👽",
    tone: "violet",
    quote: "Three suppliers compared. The cheapest one has bad reviews — here's why.",
    tags: ["Curious", "Careful", "Chatty"],
    sliders: { talk: 65, risk: 25, tone: 50 },
  },
  {
    id: "juno",
    name: "Juno",
    role: "Support",
    emoji: "🐼",
    tone: "teal",
    quote: "Answered 6 customers. One wants a refund — that one's yours.",
    tags: ["Patient", "Warm", "Formal"],
    sliders: { talk: 45, risk: 20, tone: 25 },
  },
];

/** The faces to pick from in the builder (people, animals, robots, aliens). */
export const BUILDER_EMOJI = ["🦉", "🦊", "🤖", "👽", "🐼", "🧑‍💼", "👩‍💻", "🐯", "🦾", "🐙"];

/** "Brief, careful, a bit playful" — the sliders in words (for its record and its first line). */
export function slidersLine(sliders: Sliders): string {
  const word = (value: number, left: string, right: string) =>
    value <= 35 ? left.toLowerCase() : value >= 65 ? right.toLowerCase() : null;
  const words = SLIDERS.map((slider) => word(sliders[slider.id], slider.left, slider.right)).filter(
    (item): item is string => item !== null,
  );
  return words.length > 0 ? words.join(", ") : "balanced";
}

/** What its record keeps as its character: the sliders in words, then the tags. */
export function characterText(sliders: Sliders, tags: ReadonlyArray<string>): string {
  const line = slidersLine(sliders);
  const head = line.charAt(0).toUpperCase() + line.slice(1);
  return tags.length > 0 ? `${head} · ${tags.join(", ")}` : head;
}

/** A name that fits: trimmed, at most NAME_MAX characters; null when empty. */
export function cleanName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length === 0) return null;
  return name.slice(0, NAME_MAX);
}

/** At most three tags (more and it stops meaning anything). */
export function toggleTag(tags: ReadonlyArray<string>, tag: string): ReadonlyArray<string> {
  if (tags.includes(tag)) return tags.filter((item) => item !== tag);
  return tags.length >= 3 ? [...tags.slice(1), tag] : [...tags, tag];
}
