import { randomUUID } from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

import type {
  BrowserCredentialInput,
  BrowserCredentialRecord,
  BrowserCredentialScope,
} from "@t3tools/contracts";
import { Predicate } from "effect";

import type { DesktopSecretStorage } from "./clientPersistence.ts";

/**
 * Хранилище кредов встроенного браузера: метаданные в JSON, пароль — только
 * в зашифрованном виде (Electron safeStorage, base64). Файл живёт рядом с
 * client-settings.json в userdata.
 */

interface BrowserCredentialStorageRecord extends BrowserCredentialRecord {
  readonly encryptedPassword: string;
}

interface BrowserCredentialsDocument {
  readonly credentials: readonly BrowserCredentialStorageRecord[];
}

function isBrowserCredentialScope(value: unknown): value is BrowserCredentialScope {
  return value === "account" || value === "project";
}

function isBrowserCredentialStorageRecord(value: unknown): value is BrowserCredentialStorageRecord {
  return (
    Predicate.isObject(value) &&
    typeof value.id === "string" &&
    typeof value.origin === "string" &&
    typeof value.username === "string" &&
    isBrowserCredentialScope(value.scope) &&
    (value.projectKey === undefined || typeof value.projectKey === "string") &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.encryptedPassword === "string"
  );
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!FS.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(FS.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  const directory = Path.dirname(filePath);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  FS.mkdirSync(directory, { recursive: true });
  FS.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  FS.renameSync(tempPath, filePath);
}

function readDocument(storePath: string): BrowserCredentialsDocument {
  const parsed = readJsonFile<BrowserCredentialsDocument>(storePath);
  if (!Predicate.isObject(parsed)) {
    return { credentials: [] };
  }
  return {
    credentials: Array.isArray(parsed.credentials)
      ? parsed.credentials.filter(isBrowserCredentialStorageRecord)
      : [],
  };
}

function toPublicRecord(record: BrowserCredentialStorageRecord): BrowserCredentialRecord {
  const { encryptedPassword: _encryptedPassword, ...publicRecord } = record;
  return publicRecord;
}

function normalizeOrigin(rawOrigin: string): string | null {
  try {
    const url = new URL(rawOrigin.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function listBrowserCredentials(storePath: string): readonly BrowserCredentialRecord[] {
  return readDocument(storePath).credentials.map(toPublicRecord);
}

export function saveBrowserCredential(input: {
  readonly storePath: string;
  readonly credential: BrowserCredentialInput;
  readonly secretStorage: DesktopSecretStorage;
}): BrowserCredentialRecord | null {
  if (!input.secretStorage.isEncryptionAvailable()) {
    return null;
  }
  const origin = normalizeOrigin(input.credential.origin);
  if (!origin || input.credential.username.length === 0) {
    return null;
  }

  const document = readDocument(input.storePath);
  const now = new Date().toISOString();
  const encryptedPassword = input.secretStorage
    .encryptString(input.credential.password)
    .toString("base64");
  const existing = input.credential.id
    ? document.credentials.find((record) => record.id === input.credential.id)
    : undefined;
  const nextRecord: BrowserCredentialStorageRecord = {
    id: existing?.id ?? randomUUID(),
    origin,
    username: input.credential.username,
    scope: input.credential.scope,
    ...(input.credential.scope === "project" && input.credential.projectKey
      ? { projectKey: input.credential.projectKey }
      : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    encryptedPassword,
  };

  writeJsonFile(input.storePath, {
    credentials: [
      ...document.credentials.filter((record) => record.id !== nextRecord.id),
      nextRecord,
    ],
  } satisfies BrowserCredentialsDocument);
  return toPublicRecord(nextRecord);
}

export function deleteBrowserCredential(storePath: string, id: string): void {
  const document = readDocument(storePath);
  if (!document.credentials.some((record) => record.id === id)) {
    return;
  }
  writeJsonFile(storePath, {
    credentials: document.credentials.filter((record) => record.id !== id),
  } satisfies BrowserCredentialsDocument);
}

export function revealBrowserCredentialPassword(input: {
  readonly storePath: string;
  readonly id: string;
  readonly secretStorage: DesktopSecretStorage;
}): string | null {
  const record = readDocument(input.storePath).credentials.find((entry) => entry.id === input.id);
  if (!record || !input.secretStorage.isEncryptionAvailable()) {
    return null;
  }
  try {
    return input.secretStorage.decryptString(Buffer.from(record.encryptedPassword, "base64"));
  } catch {
    return null;
  }
}
