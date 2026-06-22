import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deleteBrowserCredential,
  listBrowserCredentials,
  revealBrowserCredentialPassword,
  saveBrowserCredential,
} from "./browserCredentials.ts";
import type { DesktopSecretStorage } from "./clientPersistence.ts";

const fakeSecretStorage: DesktopSecretStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`enc:${value}`, "utf8"),
  decryptString: (value) => {
    const decoded = value.toString("utf8");
    if (!decoded.startsWith("enc:")) throw new Error("bad payload");
    return decoded.slice(4);
  },
};

const unavailableSecretStorage: DesktopSecretStorage = {
  ...fakeSecretStorage,
  isEncryptionAvailable: () => false,
};

describe("browserCredentials", () => {
  let storePath: string;
  let tempDir: string;

  beforeEach(() => {
    tempDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "uno-browser-credentials-"));
    storePath = Path.join(tempDir, "browser-credentials.json");
  });

  afterEach(() => {
    FS.rmSync(tempDir, { recursive: true, force: true });
  });

  it("сохраняет и перечисляет креды без пароля в открытом виде", () => {
    const saved = saveBrowserCredential({
      storePath,
      credential: {
        origin: "https://github.com/login?next=/",
        username: "octocat",
        password: "s3cret",
        scope: "account",
      },
      secretStorage: fakeSecretStorage,
    });

    expect(saved).not.toBeNull();
    expect(saved!.origin).toBe("https://github.com");
    expect(saved).not.toHaveProperty("encryptedPassword");
    expect(JSON.stringify(listBrowserCredentials(storePath))).not.toContain("s3cret");
    expect(FS.readFileSync(storePath, "utf8")).not.toContain("s3cret");
  });

  it("расшифровывает пароль по id", () => {
    const saved = saveBrowserCredential({
      storePath,
      credential: {
        origin: "https://example.com",
        username: "user",
        password: "p@ss",
        scope: "project",
        projectKey: "repo:x",
      },
      secretStorage: fakeSecretStorage,
    })!;

    expect(
      revealBrowserCredentialPassword({
        storePath,
        id: saved.id,
        secretStorage: fakeSecretStorage,
      }),
    ).toBe("p@ss");
  });

  it("обновляет существующий кред по id, сохраняя createdAt", () => {
    const saved = saveBrowserCredential({
      storePath,
      credential: {
        origin: "https://example.com",
        username: "user",
        password: "one",
        scope: "account",
      },
      secretStorage: fakeSecretStorage,
    })!;
    const updated = saveBrowserCredential({
      storePath,
      credential: {
        id: saved.id,
        origin: "https://example.com",
        username: "user2",
        password: "two",
        scope: "account",
      },
      secretStorage: fakeSecretStorage,
    })!;

    expect(updated.id).toBe(saved.id);
    expect(updated.createdAt).toBe(saved.createdAt);
    expect(listBrowserCredentials(storePath)).toHaveLength(1);
    expect(
      revealBrowserCredentialPassword({
        storePath,
        id: saved.id,
        secretStorage: fakeSecretStorage,
      }),
    ).toBe("two");
  });

  it("удаляет кред", () => {
    const saved = saveBrowserCredential({
      storePath,
      credential: {
        origin: "https://example.com",
        username: "user",
        password: "x",
        scope: "account",
      },
      secretStorage: fakeSecretStorage,
    })!;
    deleteBrowserCredential(storePath, saved.id);
    expect(listBrowserCredentials(storePath)).toHaveLength(0);
  });

  it("отказывается сохранять без доступного шифрования", () => {
    expect(
      saveBrowserCredential({
        storePath,
        credential: {
          origin: "https://example.com",
          username: "user",
          password: "x",
          scope: "account",
        },
        secretStorage: unavailableSecretStorage,
      }),
    ).toBeNull();
  });

  it("отвергает не-веб origin", () => {
    expect(
      saveBrowserCredential({
        storePath,
        credential: {
          origin: "file:///etc",
          username: "user",
          password: "x",
          scope: "account",
        },
        secretStorage: fakeSecretStorage,
      }),
    ).toBeNull();
  });
});
