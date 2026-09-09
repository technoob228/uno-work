/**
 * Credentials Vault - website login credentials managed from a web-only
 * Settings panel instead of being pasted into chat.
 *
 * The vault is a STANDALONE contract (it intentionally does not touch
 * `ServerSettings`) so the feature stays isolated. Passwords never leave the
 * server: `CredentialMetadata` (the client-facing list item) carries no
 * password, and the server persists password bytes in its own secret store.
 *
 * @module CredentialsVault
 */
import { Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Opaque identifier for a stored credential (server-generated UUID). */
export const CredentialId = TrimmedNonEmptyString.pipe(Schema.brand("CredentialId"));
export type CredentialId = typeof CredentialId.Type;

/**
 * List item returned to the web client. Deliberately password-free: the
 * password is redacted server-side and never crosses the RPC boundary.
 */
export const CredentialMetadata = Schema.Struct({
  id: CredentialId,
  label: Schema.String,
  url: Schema.String,
  username: Schema.String,
  notes: Schema.optional(Schema.String),
  /** Epoch milliseconds of the last create/update. */
  updatedAt: Schema.Number,
});
export type CredentialMetadata = typeof CredentialMetadata.Type;

/**
 * Create/update payload. On edit an empty (or omitted) `password` means
 * "keep the existing stored password" so the client never has to round-trip
 * the secret it can't read back.
 */
export const CredentialInput = Schema.Struct({
  label: Schema.String,
  url: Schema.String,
  username: Schema.String,
  password: Schema.optional(Schema.String),
  notes: Schema.optional(Schema.String),
});
export type CredentialInput = typeof CredentialInput.Type;

/** One row from a bulk import (CSV line or JSON array entry). */
export const CredentialImportItem = Schema.Struct({
  label: Schema.optional(Schema.String),
  url: Schema.String,
  username: Schema.String,
  password: Schema.String,
  notes: Schema.optional(Schema.String),
});
export type CredentialImportItem = typeof CredentialImportItem.Type;

/** Bulk import payload. */
export const CredentialImportPayload = Schema.Struct({
  items: Schema.Array(CredentialImportItem),
});
export type CredentialImportPayload = typeof CredentialImportPayload.Type;

/** Result of a bulk import. */
export const CredentialImportResult = Schema.Struct({
  imported: Schema.Number,
});
export type CredentialImportResult = typeof CredentialImportResult.Type;

/** Upsert RPC payload: the input plus an optional id (present on edit). */
export const CredentialUpsertPayload = Schema.Struct({
  id: Schema.optional(CredentialId),
  input: CredentialInput,
});
export type CredentialUpsertPayload = typeof CredentialUpsertPayload.Type;

/** Delete RPC payload. */
export const CredentialDeletePayload = Schema.Struct({
  id: CredentialId,
});
export type CredentialDeletePayload = typeof CredentialDeletePayload.Type;

/** List RPC success: metadata only, never passwords. */
export const CredentialListResult = Schema.Array(CredentialMetadata);
export type CredentialListResult = typeof CredentialListResult.Type;

/**
 * Автозаполнение сохранённого логина в открытой вкладке встроенного браузера.
 * Пароль читает и подставляет СЕРВЕР: клиент присылает только id креда и
 * вкладку-адресата, поэтому секрет не проходит через RPC-ответ.
 */
export const CredentialFillPayload = Schema.Struct({
  id: CredentialId,
  /** id вкладки предпросмотра, в которую заполнять. */
  tabId: Schema.String,
  /** Тред и рабочий каталог — чтобы команда ушла исполнителю нужного чата. */
  threadId: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
});
export type CredentialFillPayload = typeof CredentialFillPayload.Type;

/** Результат автозаполнения: заполнено ли и почему нет. */
export const CredentialFillResult = Schema.Struct({
  filled: Schema.Boolean,
  error: Schema.optional(Schema.String),
});
export type CredentialFillResult = typeof CredentialFillResult.Type;

/**
 * Синхронизация хранилища через аккаунт Uno. `push` заменяет аккаунтный слепок
 * локальным хранилищем, `pull` — локальное хранилище аккаунтным (целиком, без
 * построчного слияния).
 */
export const CredentialSyncPayload = Schema.Struct({
  direction: Schema.Literals(["push", "pull"]),
});
export type CredentialSyncPayload = typeof CredentialSyncPayload.Type;

export const CredentialSyncResult = Schema.Struct({
  ok: Schema.Boolean,
  /** Сколько логинов в хранилище после операции. */
  count: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
});
export type CredentialSyncResult = typeof CredentialSyncResult.Type;

export class CredentialsVaultError extends Schema.TaggedErrorClass<CredentialsVaultError>()(
  "CredentialsVaultError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Credentials vault error: ${this.detail}`;
  }
}
