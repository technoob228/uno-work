/**
 * An assistant's picture (Misha 23.10: "emojis feel inhuman — let me upload a
 * picture, pick an emoji, or a persona"). The file lives in its own folder,
 * `.uno/avatar-<ms>.<ext>` (a new name per picture, so a cached old one is
 * never shown); `.uno/profile.json` names it. The daemon serves it to owner
 * sessions only (`GET /api/manager/assistant/avatar`).
 *
 * A persona portrait is drawn by Uno AI through the gateway
 * (`imageGenerate.ts`): one friendly illustrated style for every assistant,
 * with a look picked by `seed` so "Another one" gives another face.
 *
 * @module assistants/assistantAvatar
 */
import { ASSISTANT_AVATAR_MAX_BYTES, type AssistantPersona } from "@t3tools/contracts";
import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";

import { AVATAR_FILE_NAME, patchProfile, readProfile } from "./localAssistantStore.ts";

export type AvatarFormat = "png" | "jpg" | "webp";

export const AVATAR_CONTENT_TYPE: Readonly<Record<AvatarFormat, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};

/** The picture's format from its first bytes; null for anything else (gif, svg, text…). */
export function avatarFormat(bytes: Uint8Array): AvatarFormat | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) {
    return bytes[3] === 0x47 ? "png" : null;
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "webp";
  }
  return null;
}

export type AvatarCheck =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly format: AvatarFormat }
  | { readonly ok: false; readonly problem: string };

/** Base64 (a `data:` URL is accepted too) → a picture we keep, or why not. */
export function checkAvatarImage(raw: string): AvatarCheck {
  const base64 = raw.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "").trim();
  if (base64.length === 0 || !/^[A-Za-z0-9+/=\s]+$/.test(base64)) {
    return { ok: false, problem: "That isn't a picture." };
  }
  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  if (bytes.length === 0) return { ok: false, problem: "That isn't a picture." };
  if (bytes.length > ASSISTANT_AVATAR_MAX_BYTES) {
    return { ok: false, problem: "The picture is bigger than 2 MB." };
  }
  const format = avatarFormat(bytes);
  if (format === null) return { ok: false, problem: "Use a PNG, JPG or WebP picture." };
  return { ok: true, bytes, format };
}

const unoDir = (workspaceRoot: string) => nodePath.join(workspaceRoot, ".uno");

/** Saves its new picture, names it in its profile and removes the old ones. Returns the name. */
export async function saveAvatar(
  workspaceRoot: string,
  image: { readonly bytes: Uint8Array; readonly format: AvatarFormat },
  now: Date = new Date(),
): Promise<string> {
  const dir = unoDir(workspaceRoot);
  await fsp.mkdir(dir, { recursive: true });
  const name = `avatar-${now.getTime()}.${image.format}`;
  await fsp.writeFile(nodePath.join(dir, name), image.bytes);
  await patchProfile(workspaceRoot, { avatar: name }, now);
  await removeOldAvatars(dir, name);
  return name;
}

/** Back to its emoji: the picture goes. */
export async function clearAvatar(workspaceRoot: string): Promise<void> {
  await patchProfile(workspaceRoot, { avatar: null });
  await removeOldAvatars(unoDir(workspaceRoot), null);
}

async function removeOldAvatars(dir: string, keep: string | null): Promise<void> {
  const entries = await fsp.readdir(dir).catch((): string[] => []);
  await Promise.all(
    entries
      .filter((entry) => entry !== keep && AVATAR_FILE_NAME.test(entry))
      .map((entry) => fsp.rm(nodePath.join(dir, entry), { force: true })),
  );
}

/** Its picture as its profile names it, or null (none, or the file is gone). */
export async function readAvatar(
  workspaceRoot: string,
): Promise<{ readonly bytes: Uint8Array; readonly contentType: string } | null> {
  const profile = await readProfile(workspaceRoot);
  const name = profile?.avatar ?? null;
  if (name === null || !AVATAR_FILE_NAME.test(name)) return null;
  const bytes = await fsp.readFile(nodePath.join(unoDir(workspaceRoot), name)).catch(() => null);
  if (bytes === null) return null;
  const format = avatarFormat(bytes);
  return format === null ? null : { bytes, contentType: AVATAR_CONTENT_TYPE[format] };
}

// ── Persona portraits ─────────────────────────────────────────────────────

/** A few looks per persona; `seed` walks through them for "Another one". */
const PERSONA_LOOKS: Readonly<Record<AssistantPersona, ReadonlyArray<string>>> = {
  human: [
    "a young woman with curly dark hair and round glasses",
    "a man with a short beard and a knitted beanie",
    "an older woman with silver hair in a bun and a warm smile",
    "a young man with freckles and messy red hair",
    "a woman with a bright headscarf and gold earrings",
    "a man with tidy grey hair and a cardigan",
  ],
  animal: [
    "a red fox",
    "a wise owl",
    "a sea otter",
    "a corgi",
    "a raccoon",
    "a panda",
    "a tabby cat",
  ],
  robot: [
    "a round friendly robot with big round eyes",
    "a boxy retro robot with an antenna",
    "a sleek white robot with a glowing visor",
    "a small robot with a screen face showing a smile",
    "a brass robot with rivets and a bow tie",
  ],
  alien: [
    "a small green alien with big black eyes",
    "a purple alien with three eyes and a cheerful grin",
    "a blue alien with antennae and soft round features",
    "an orange alien with a single big eye and freckles",
    "a teal alien wearing a tiny space helmet",
  ],
};

/** Soft backgrounds the portrait sits on (the same set as the emoji faces' tones). */
const BACKGROUNDS = ["peach", "mint", "lavender", "sky blue", "butter yellow", "rose"] as const;

const STYLE =
  "Friendly character portrait for an app avatar: head and shoulders, centered, facing the viewer, " +
  "kind expression. Soft flat illustration with gentle shading and clean shapes, warm modern colors, " +
  "the same consistent style as a set of team avatars. Plain solid background, no text, no letters, " +
  "no frame, no border. Square.";

/** The prompt for a persona portrait: one style, a look and a background picked by `seed`. */
export function personaPrompt(persona: AssistantPersona, seed: number): string {
  const looks = PERSONA_LOOKS[persona];
  const index = Math.abs(Math.trunc(seed));
  const look = looks[index % looks.length]!;
  const background = BACKGROUNDS[Math.floor(index / looks.length) % BACKGROUNDS.length]!;
  return `${STYLE} The character: ${look}. Background: ${background}.`;
}
