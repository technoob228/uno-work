/**
 * Variant C (28.10): a new teammate under Uno, made "like Grok companions" —
 * a gallery of ready characters, then "Make X yours" (name, role,
 * character, face, where and how it works). Pure: the characters, the
 * draft a card fills, and what the draft becomes on its computer.
 */
import type { AssistantPersona } from "@t3tools/contracts";

import type { AvatarTone } from "../assistantTeam.logic";

export const TEAMMATE_NAME_MAX = 40;
/** The counter shows from here on. */
export const TEAMMATE_NAME_COUNTER_FROM = 30;
export const TEAMMATE_TAGS_MAX = 3;

export type TeammateRoleId =
  | "secretary"
  | "marketer"
  | "developer"
  | "researcher"
  | "support"
  | "other";

export const TEAMMATE_ROLES: ReadonlyArray<{
  readonly id: TeammateRoleId;
  readonly label: string;
}> = [
  { id: "secretary", label: "Secretary" },
  { id: "marketer", label: "Marketer" },
  { id: "developer", label: "Developer" },
  { id: "researcher", label: "Researcher" },
  { id: "support", label: "Support" },
  { id: "other", label: "Something else" },
];

export type TeammateTagId = "warm" | "direct" | "funny" | "nerdy" | "patient" | "curious";

export const TEAMMATE_TAGS: ReadonlyArray<{ readonly id: TeammateTagId; readonly label: string }> =
  [
    { id: "warm", label: "Warm" },
    { id: "direct", label: "Direct" },
    { id: "funny", label: "Funny" },
    { id: "nerdy", label: "Nerdy" },
    { id: "patient", label: "Patient" },
    { id: "curious", label: "Curious" },
  ];

/** Three sliders, 0…100: low = the left word, high = the right one, the middle says nothing. */
export type SliderId = "talk" | "risk" | "manner";

export const TEAMMATE_SLIDERS: ReadonlyArray<{
  readonly id: SliderId;
  readonly low: string;
  readonly high: string;
}> = [
  { id: "talk", low: "Brief", high: "Chatty" },
  { id: "risk", low: "Careful", high: "Bold" },
  { id: "manner", low: "Formal", high: "Playful" },
];

export type Sliders = Readonly<Record<SliderId, number>>;
export const MIDDLE_SLIDERS: Sliders = { talk: 50, risk: 50, manner: 50 };

const SLIDER_LOW = 20;
const SLIDER_HIGH = 80;
/** Below this it reads as the left word, above 100 - this as the right one. */
const SLIDER_SAYS = 35;

export interface TeammateCharacter {
  readonly name: string;
  readonly role: TeammateRoleId;
  readonly emoji: string;
  readonly tone: AvatarTone;
  /** A line in its voice, on the card. */
  readonly quote: string;
  /** The three words on the card (tags and slider ends). */
  readonly words: ReadonlyArray<string>;
}

export const TEAMMATE_CHARACTERS: ReadonlyArray<TeammateCharacter> = [
  {
    name: "Mia",
    role: "secretary",
    emoji: "🦉",
    tone: "amber",
    quote: "Your 11:00 moved. I told them 15:00 works for you.",
    words: ["Warm", "Brief", "Careful"],
  },
  {
    name: "Leo",
    role: "marketer",
    emoji: "🦊",
    tone: "orange",
    quote: "Tuesday's post got 3× the clicks. Want two more like it?",
    words: ["Playful", "Bold", "Chatty"],
  },
  {
    name: "Bolt",
    role: "developer",
    emoji: "🤖",
    tone: "sky",
    quote: "CI is red on the landing. Fixed the test, PR is up.",
    words: ["Direct", "Brief", "Nerdy"],
  },
  {
    name: "Nova",
    role: "researcher",
    emoji: "👽",
    tone: "emerald",
    quote: "Compared three suppliers. The cheapest has bad reviews — here's why.",
    words: ["Curious", "Careful", "Chatty"],
  },
  {
    name: "Juno",
    role: "support",
    emoji: "🐼",
    tone: "slate",
    quote: "Answered 6 customers. One wants a refund — that one's yours.",
    words: ["Patient", "Warm", "Formal"],
  },
];

export const roleLabel = (id: TeammateRoleId) =>
  TEAMMATE_ROLES.find((role) => role.id === id)?.label ?? "Assistant";

export type FaceKind = "emoji" | "persona";

/** What step 2 edits. */
export interface TeammateDraft {
  readonly name: string;
  readonly role: TeammateRoleId;
  /** "Something else": its own words. */
  readonly customRole: string;
  readonly sliders: Sliders;
  readonly tags: ReadonlyArray<TeammateTagId>;
  readonly emoji: string;
  readonly tone: AvatarTone;
  readonly face: FaceKind;
  readonly persona: AssistantPersona | null;
  /** The portrait drawn for it (a `data:` URL), kept only if the person stays on Persona. */
  readonly portrait: string | null;
  readonly mode: "itself" | "asks";
}

/** A card's character as a draft: its words go to the tags or to the slider ends. */
export function draftFromCharacter(character: TeammateCharacter): TeammateDraft {
  const sliders: Record<SliderId, number> = { ...MIDDLE_SLIDERS };
  const tags: TeammateTagId[] = [];
  for (const word of character.words) {
    const slider = TEAMMATE_SLIDERS.find((item) => item.low === word || item.high === word);
    if (slider) {
      sliders[slider.id] = slider.low === word ? SLIDER_LOW : SLIDER_HIGH;
      continue;
    }
    const tag = TEAMMATE_TAGS.find((item) => item.label === word);
    if (tag && tags.length < TEAMMATE_TAGS_MAX) tags.push(tag.id);
  }
  return {
    name: character.name,
    role: character.role,
    customRole: "",
    sliders,
    tags,
    emoji: character.emoji,
    tone: character.tone,
    face: "emoji",
    persona: null,
    portrait: null,
    mode: "itself",
  };
}

/** "Build your own": a blank draft with a friendly face. */
export function blankDraft(): TeammateDraft {
  return {
    name: "",
    role: "secretary",
    customRole: "",
    sliders: MIDDLE_SLIDERS,
    tags: [],
    emoji: "🧑",
    tone: "violet",
    face: "emoji",
    persona: null,
    portrait: null,
    mode: "itself",
  };
}

/** The name as typed, cut to the limit (paste included). */
export function clampName(value: string): string {
  return Array.from(value).slice(0, TEAMMATE_NAME_MAX).join("");
}

/** The name it is made with: trimmed, never empty. */
export function finalName(draft: Pick<TeammateDraft, "name" | "role" | "customRole">): string {
  const name = clampName(draft.name.trim()).trim();
  return name || "Teammate";
}

/** Its role in words: the chip's, or the person's own ("Something else"). */
export function finalRole(draft: Pick<TeammateDraft, "role" | "customRole">): string {
  if (draft.role !== "other") return roleLabel(draft.role);
  const own = draft.customRole.trim().slice(0, 60);
  return own || "Assistant";
}

/** Toggle a tag; a fourth one is not taken. */
export function toggleTag(
  tags: ReadonlyArray<TeammateTagId>,
  tag: TeammateTagId,
): ReadonlyArray<TeammateTagId> {
  if (tags.includes(tag)) return tags.filter((item) => item !== tag);
  return tags.length >= TEAMMATE_TAGS_MAX ? tags : [...tags, tag];
}

/** The word a slider says at that value, or null in the middle. */
export function sliderWord(id: SliderId, value: number): string | null {
  const slider = TEAMMATE_SLIDERS.find((item) => item.id === id)!;
  if (value < SLIDER_SAYS) return slider.low;
  if (value > 100 - SLIDER_SAYS) return slider.high;
  return null;
}

/** Its character as its computer keeps it: "Warm · Brief · Careful". */
export function characterLine(draft: Pick<TeammateDraft, "tags" | "sliders">): string {
  const tags = draft.tags.map((id) => TEAMMATE_TAGS.find((tag) => tag.id === id)!.label);
  const sliders = TEAMMATE_SLIDERS.map((slider) =>
    sliderWord(slider.id, draft.sliders[slider.id]),
  ).filter((word): word is string => word !== null);
  return [...tags, ...sliders].join(" · ");
}

/** A character already on the team (same name, any computer): its card opens it instead. */
export function memberNamed<T extends { readonly name: string }>(
  members: ReadonlyArray<T>,
  name: string,
): T | null {
  const wanted = name.trim().toLowerCase();
  return members.find((member) => member.name.trim().toLowerCase() === wanted) ?? null;
}
