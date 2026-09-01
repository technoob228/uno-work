/**
 * CredentialsVault - server-authoritative store for website login credentials.
 *
 * A STANDALONE subsystem (kept out of `ServerSettings` on purpose) so the
 * feature diff stays isolated. Metadata (label/url/username/notes/updatedAt)
 * lives as JSON at `<stateDir>/credentials.json`; the password bytes live in
 * `ServerSecretStore` under `cred_<id>` (chmod 0600 on disk) and are NEVER
 * returned over the client RPC. `list` yields metadata only; `reveal` /
 * `materializeAll` exist for future server-side agent/tool consumption.
 *
 * @module CredentialsVault
 */
import {
  type CredentialImportItem,
  type CredentialInput,
  CredentialId,
  CredentialMetadata,
  CredentialsVaultError,
} from "@t3tools/contracts";
import { Context, Effect, FileSystem, Layer, Path, Ref, Schema } from "effect";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "./atomicWrite.ts";
import { ServerConfig } from "./config.ts";
import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore.ts";
import { ServerSecretStore } from "./auth/Services/ServerSecretStore.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** On-disk envelope for the credential metadata list. */
const CredentialsFile = Schema.Struct({
  credentials: Schema.Array(CredentialMetadata),
});

/** Password bytes are keyed by `cred_<id>` in the secret store. */
function credentialSecretName(id: CredentialId): string {
  return `cred_${id}`;
}

/** A credential with its plaintext password — server-internal only. */
export interface MaterializedCredential extends CredentialMetadata {
  readonly password: string;
}

export interface CredentialsVaultShape {
  /** Metadata for every stored credential (no passwords). */
  readonly list: Effect.Effect<ReadonlyArray<CredentialMetadata>, CredentialsVaultError>;
  /** Create (no id) or update (existing id) a credential; returns its metadata. */
  readonly upsert: (input: {
    readonly id?: CredentialId | undefined;
    readonly input: CredentialInput;
  }) => Effect.Effect<CredentialMetadata, CredentialsVaultError>;
  /** Remove a credential's metadata and its stored password. */
  readonly remove: (id: CredentialId) => Effect.Effect<void, CredentialsVaultError>;
  /** Bulk-create credentials from imported rows; returns how many were stored. */
  readonly importItems: (
    items: ReadonlyArray<CredentialImportItem>,
  ) => Effect.Effect<{ readonly imported: number }, CredentialsVaultError>;
  /** Server-internal: read back a single plaintext password (never over RPC). */
  readonly reveal: (id: CredentialId) => Effect.Effect<string | null, CredentialsVaultError>;
  /** Server-internal: every credential with its plaintext password. */
  readonly materializeAll: Effect.Effect<
    ReadonlyArray<MaterializedCredential>,
    CredentialsVaultError
  >;
}

export class CredentialsVaultService extends Context.Service<
  CredentialsVaultService,
  CredentialsVaultShape
>()("t3/credentialsVault/CredentialsVaultService") {}

function normalizeNotes(notes: string | undefined): string | undefined {
  if (notes === undefined) return undefined;
  const trimmed = notes.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const makeCredentialsVault = Effect.gen(function* () {
  const { credentialsPath } = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const secretStore = yield* ServerSecretStore;
  const writeSemaphore = yield* Semaphore.make(1);

  const toError = (detail: string, cause?: unknown) =>
    new CredentialsVaultError({ detail, cause });

  const loadFromDisk = Effect.gen(function* () {
    const exists = yield* fs
      .exists(credentialsPath)
      .pipe(Effect.mapError((cause) => toError("failed to check credentials file", cause)));
    if (!exists) {
      return [] as ReadonlyArray<CredentialMetadata>;
    }
    const raw = yield* fs
      .readFileString(credentialsPath)
      .pipe(Effect.mapError((cause) => toError("failed to read credentials file", cause)));
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) => toError("failed to parse credentials file", cause),
    });
    const decoded = Schema.decodeUnknownExit(CredentialsFile)(parsed);
    if (decoded._tag === "Failure") {
      yield* Effect.logWarning("failed to decode credentials.json, starting empty", {
        path: credentialsPath,
      });
      return [] as ReadonlyArray<CredentialMetadata>;
    }
    return decoded.value.credentials;
  });

  const initial = yield* loadFromDisk;
  const credentialsRef = yield* Ref.make<ReadonlyArray<CredentialMetadata>>(initial);

  const persist = (credentials: ReadonlyArray<CredentialMetadata>) =>
    writeFileStringAtomically({
      filePath: credentialsPath,
      contents: `${JSON.stringify({ credentials }, null, 2)}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, pathService),
      Effect.mapError((cause) => toError("failed to write credentials file", cause)),
    );

  const setPassword = (id: CredentialId, password: string) =>
    secretStore
      .set(credentialSecretName(id), textEncoder.encode(password))
      .pipe(Effect.mapError((cause) => toError("failed to persist credential password", cause)));

  const buildMetadata = (
    id: CredentialId,
    input: CredentialInput,
    updatedAt: number,
  ): CredentialMetadata => {
    const notes = normalizeNotes(input.notes);
    return {
      id,
      label: input.label,
      url: input.url,
      username: input.username,
      ...(notes !== undefined ? { notes } : {}),
      updatedAt,
    };
  };

  const upsert: CredentialsVaultShape["upsert"] = ({ id, input }) =>
    writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const list = yield* Ref.get(credentialsRef);
        const existingIndex = id !== undefined ? list.findIndex((c) => c.id === id) : -1;
        const isUpdate = existingIndex >= 0;
        const targetId: CredentialId = isUpdate
          ? list[existingIndex]!.id
          : (id ?? CredentialId.make(crypto.randomUUID()));

        const password = input.password ?? "";
        // On update with an empty password, keep the stored secret untouched.
        if (!isUpdate || password.length > 0) {
          yield* setPassword(targetId, password);
        }

        const metadata = buildMetadata(targetId, input, Date.now());
        const nextList = isUpdate
          ? list.map((c, index) => (index === existingIndex ? metadata : c))
          : [...list, metadata];

        yield* persist(nextList);
        yield* Ref.set(credentialsRef, nextList);
        return metadata;
      }),
    );

  const remove: CredentialsVaultShape["remove"] = (id) =>
    writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const list = yield* Ref.get(credentialsRef);
        if (!list.some((c) => c.id === id)) {
          return;
        }
        const nextList = list.filter((c) => c.id !== id);
        yield* persist(nextList);
        yield* Ref.set(credentialsRef, nextList);
        yield* secretStore
          .remove(credentialSecretName(id))
          .pipe(Effect.mapError((cause) => toError("failed to remove credential password", cause)));
      }),
    );

  const importItems: CredentialsVaultShape["importItems"] = (items) =>
    writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const list = yield* Ref.get(credentialsRef);
        const now = Date.now();
        const added: CredentialMetadata[] = [];
        for (const item of items) {
          const id = CredentialId.make(crypto.randomUUID());
          yield* setPassword(id, item.password);
          const label =
            item.label && item.label.trim().length > 0
              ? item.label
              : item.url || item.username;
          added.push(
            buildMetadata(id, {
              label,
              url: item.url,
              username: item.username,
              notes: item.notes,
            }, now),
          );
        }
        if (added.length === 0) {
          return { imported: 0 };
        }
        const nextList = [...list, ...added];
        yield* persist(nextList);
        yield* Ref.set(credentialsRef, nextList);
        return { imported: added.length };
      }),
    );

  const reveal: CredentialsVaultShape["reveal"] = (id) =>
    secretStore
      .get(credentialSecretName(id))
      .pipe(
        Effect.map((bytes) => (bytes ? textDecoder.decode(bytes) : null)),
        Effect.mapError((cause) => toError("failed to read credential password", cause)),
      );

  const materializeAll = Effect.gen(function* () {
    const list = yield* Ref.get(credentialsRef);
    const result: MaterializedCredential[] = [];
    for (const metadata of list) {
      const password = yield* reveal(metadata.id);
      result.push({ ...metadata, password: password ?? "" });
    }
    return result;
  });

  return {
    list: Ref.get(credentialsRef),
    upsert,
    remove,
    importItems,
    reveal,
    materializeAll,
  } satisfies CredentialsVaultShape;
});

export const CredentialsVaultLive = Layer.effect(
  CredentialsVaultService,
  makeCredentialsVault,
).pipe(Layer.provide(ServerSecretStoreLive));
