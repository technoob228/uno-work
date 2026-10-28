/**
 * Variant D (28.10): personas as channels next to Uno. The pure part — the
 * gallery, roles, character (sliders and tags, never a prompt), the line a
 * persona's character is kept as, and where a project limit is a real lock.
 *
 * - A persona lives on the account's cloud computer (the one that doesn't
 *   sleep on Plus), shares Uno's memory, connectors and Telegram bot, and has
 *   its own mode ("Autonomous" / "Cautious").
 * - A project limit is a real lock only where the persona's commands run in a
 *   sandbox — its cloud computer (bubblewrap) — or on a computer of its own.
 *   On the MacBook nothing locks the chats it starts there yet (seatbelt is
 *   later, Misha 23.10): the UI says so instead of pretending.
 */
import type { AssistantJobKind } from "@t3tools/contracts";

import { type WorksOnMachine, type WorksOnOption, worksOnOptions } from "./assistantPage.logic";
import type { AvatarTone } from "./assistantTeam.logic";

export interface GalleryPersona {
  readonly id: string;
  /** What it does — the role decides the "What should it do?" step (Misha 28.10). */
  readonly job: AssistantJobKind;
  readonly name: string;
  readonly emoji: string;
  readonly tone: AvatarTone;
  readonly role: string;
  /** What it says on its card — a thing it did, in its voice. */
  readonly quote: string;
  readonly tags: ReadonlyArray<string>;
  /** Sliders 0..100: brief→chatty, careful→bold, formal→playful. */
  readonly sliders: readonly [number, number, number];
}

/**
 * Three roles, each with its own default character (Misha 28.10 evening:
 * "only 3 roles"). The role is the choice of what it does; the name, face and
 * character are the person's to change on the next step.
 */
export const GALLERY: ReadonlyArray<GalleryPersona> = [
  {
    id: "developer",
    job: "development",
    name: "Bolt",
    emoji: "🤖",
    tone: "sky",
    role: "Developer",
    quote: "CI was red on shop-site. A chat on uno-work fixed the test — the PR is up.",
    tags: ["Direct", "Brief", "Nerdy"],
    sliders: [15, 55, 40],
  },
  {
    id: "accounts-manager",
    job: "accounts",
    name: "Leo",
    emoji: "🦊",
    tone: "orange",
    role: "Accounts manager",
    quote: "Posted Thursday's update and answered 5 comments. One wants a refund — that's yours.",
    tags: ["Playful", "Bold", "Chatty"],
    sliders: [75, 75, 80],
  },
  {
    id: "helper",
    job: "tasks",
    name: "Mia",
    emoji: "🦉",
    tone: "amber",
    role: "Helper",
    quote: "Your 11:00 moved. I put the new time in your calendar and told them.",
    tags: ["Warm", "Brief", "Careful"],
    sliders: [30, 40, 65],
  },
];

export const TAGS: ReadonlyArray<string> = [
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
];

/** At most this many tags: a character, not a list of adjectives. */
export const MAX_TAGS = 3;

export const SLIDERS: ReadonlyArray<readonly [string, string]> = [
  ["Brief", "Chatty"],
  ["Careful", "Bold"],
  ["Formal", "Playful"],
];

/** Faces offered right in the builder (the full set is on its page later). */
export const QUICK_FACES: ReadonlyArray<{ readonly emoji: string; readonly tone: AvatarTone }> = [
  { emoji: "🦉", tone: "amber" },
  { emoji: "🦊", tone: "orange" },
  { emoji: "🤖", tone: "sky" },
  { emoji: "👽", tone: "violet" },
  { emoji: "🐼", tone: "teal" },
  { emoji: "👩‍💼", tone: "rose" },
  { emoji: "🧑‍🚀", tone: "slate" },
  { emoji: "🦁", tone: "amber" },
  { emoji: "🐙", tone: "violet" },
  { emoji: "🌿", tone: "emerald" },
];

/** The tags first, then what the sliders lean to: "Warm · Brief · Careful". */
export function characterLine(
  tags: ReadonlyArray<string>,
  sliders: readonly [number, number, number],
): string {
  const words = [...tags];
  SLIDERS.forEach(([low, high], index) => {
    const value = sliders[index] ?? 50;
    const lean = value <= 30 ? low : value >= 70 ? high : null;
    if (lean && !words.includes(lean) && words.length < MAX_TAGS + 1) words.push(lean);
  });
  return words.join(" · ");
}

/** The tags toggled: on, off, or not more than MAX_TAGS. */
export function toggleTag(tags: ReadonlyArray<string>, tag: string): ReadonlyArray<string> {
  if (tags.includes(tag)) return tags.filter((item) => item !== tag);
  if (tags.length >= MAX_TAGS) return [...tags.slice(1), tag];
  return [...tags, tag];
}

export type ProjectLock = "sandbox" | "note";

/**
 * Whether limiting a persona to a project there is a real lock: on the
 * persona's own (cloud) computer it is — its commands run in a sandbox; on
 * another computer (the MacBook) the chats it starts there are not locked yet.
 */
export function projectLockOn(input: {
  readonly projectEnvironmentId: string;
  readonly personaEnvironmentId: string;
}): ProjectLock {
  return input.projectEnvironmentId === input.personaEnvironmentId ? "sandbox" : "note";
}

/** The one line under a persona's name: role and what it shares. */
export function personaLine(role: string | undefined): string {
  return `${role ? `${role} · ` : ""}works next to Uno · shares its memory and apps`;
}

/** Name problems, said plainly (the field also stops at the limit). */
export function nameProblem(name: string, taken: ReadonlyArray<string>): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Give it a name.";
  if (taken.some((other) => other.toLowerCase() === trimmed.toLowerCase()))
    return `You already have a ${trimmed}. Pick another name.`;
  return null;
}

/** Asleep or off: it can't take a new assistant until it wakes. */
export function isAsleep(status: string): boolean {
  return status === "offline" || status === "sleeping";
}

export type PersonaWorksOn = WorksOnOption & {
  /** The environment it would live in (null: a new computer, made in My Uno first). */
  readonly target: string | null;
  /** Why it can't be picked now (asleep, not opened in Work yet), or null. */
  readonly why: string | null;
  readonly laptop: boolean;
};

/**
 * "Where it works" for a new assistant: its home (the cloud computer by
 * default), the account's other cloud computers this app is connected to, or
 * a computer of its own. One that can't take it now says why.
 */
export function personaWorksOn(input: {
  readonly homeEnvironmentId: string | null;
  readonly machines: ReadonlyArray<WorksOnMachine>;
}): ReadonlyArray<PersonaWorksOn> {
  const { homeEnvironmentId } = input;
  if (homeEnvironmentId === null) return [];
  const home = input.machines.find((machine) => machine.environmentId === homeEnvironmentId);
  return worksOnOptions({
    isUno: false,
    hereEnvironmentId: homeEnvironmentId,
    hereLabel: home?.label ?? null,
    machines: input.machines,
  }).map((option) =>
    option.kind === "here"
      ? {
          ...option,
          target: homeEnvironmentId,
          why: home && isAsleep(home.status) ? `${home.label} is asleep — wake it first.` : null,
          laptop: home === undefined || home.kind === "computer",
        }
      : option.kind === "cloud"
        ? { ...option, target: option.environmentId, why: option.blocked, laptop: false }
        : { ...option, target: null, why: null, laptop: false },
  );
}
