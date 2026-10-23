import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ASSISTANT_AVATAR_MAX_BYTES } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  avatarFormat,
  checkAvatarImage,
  clearAvatar,
  personaPrompt,
  readAvatar,
  saveAvatar,
} from "./assistantAvatar.ts";
import { patchProfile, readProfile } from "./localAssistantStore.ts";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "uno-assistant-avatar-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50,
]);
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

describe("avatar check", () => {
  it("takes PNG, JPG and WebP by their bytes, not their name", () => {
    expect(avatarFormat(PNG)).toBe("png");
    expect(avatarFormat(JPG)).toBe("jpg");
    expect(avatarFormat(WEBP)).toBe("webp");
    expect(avatarFormat(GIF)).toBeNull();
    expect(avatarFormat(new TextEncoder().encode("<svg></svg>"))).toBeNull();
  });

  it("accepts plain base64 and a data URL; refuses other formats, junk and big files", () => {
    expect(checkAvatarImage(base64(PNG))).toMatchObject({ ok: true, format: "png" });
    expect(checkAvatarImage(`data:image/webp;base64,${base64(WEBP)}`)).toMatchObject({
      ok: true,
      format: "webp",
    });
    expect(checkAvatarImage(base64(GIF))).toEqual({
      ok: false,
      problem: "Use a PNG, JPG or WebP picture.",
    });
    expect(checkAvatarImage("not base64 at all!")).toMatchObject({ ok: false });
    expect(checkAvatarImage("")).toMatchObject({ ok: false });
    const big = new Uint8Array(ASSISTANT_AVATAR_MAX_BYTES + 1);
    big.set(PNG);
    expect(checkAvatarImage(base64(big))).toEqual({
      ok: false,
      problem: "The picture is bigger than 2 MB.",
    });
  });
});

describe("avatar file", () => {
  it("saves a new name per picture, keeps the profile's emoji and removes the old file", async () => {
    const root = tempDir();
    await patchProfile(root, { emoji: "🦊", template: "dev" });
    const first = await saveAvatar(root, { bytes: PNG, format: "png" }, new Date(1000));
    expect(first).toBe("avatar-1000.png");
    const second = await saveAvatar(root, { bytes: WEBP, format: "webp" }, new Date(2000));
    expect(second).toBe("avatar-2000.webp");
    expect(
      readdirSync(path.join(root, ".uno")).filter((name) => name.startsWith("avatar")),
    ).toEqual(["avatar-2000.webp"]);
    expect(await readProfile(root)).toMatchObject({
      emoji: "🦊",
      template: "dev",
      avatar: "avatar-2000.webp",
    });
    expect(await readAvatar(root)).toMatchObject({ contentType: "image/webp" });

    await clearAvatar(root);
    expect(await readAvatar(root)).toBeNull();
    expect(await readProfile(root)).toMatchObject({ emoji: "🦊", avatar: null });
  });

  it("an emoji change keeps the picture", async () => {
    const root = tempDir();
    await saveAvatar(root, { bytes: PNG, format: "png" }, new Date(5));
    await patchProfile(root, { emoji: "🤖" });
    expect(await readProfile(root)).toMatchObject({ emoji: "🤖", avatar: "avatar-5.png" });
  });

  it("never serves a file the profile names outside the avatar pattern", async () => {
    const root = tempDir();
    await patchProfile(root, { avatar: "../../secret.png" });
    expect((await readProfile(root))?.avatar).toBeNull();
    expect(await readAvatar(root)).toBeNull();
  });
});

describe("persona portraits", () => {
  it("one style for every persona, another look for another seed", () => {
    const human = personaPrompt("human", 0);
    const robot = personaPrompt("robot", 0);
    expect(human).toContain("Friendly character portrait");
    expect(robot).toContain("Friendly character portrait");
    expect(human).not.toBe(robot);
    expect(personaPrompt("animal", 1)).not.toBe(personaPrompt("animal", 2));
    expect(personaPrompt("alien", -3)).toContain("alien");
    expect(human).toContain("no text");
  });
});
