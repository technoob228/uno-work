/**
 * FilesService — the daemon side of the Files app.
 *
 * Wraps the file-manager operations (confined to the Work user's home), the
 * public share links (`/s/<token>`, rows in `file_shares`) and publishing a
 * page or folder to Uno Hosting. Errors reaching the client are `FilesError`
 * with a message written for a person, never a stack or an errno dump.
 *
 * @module files/FilesService
 */
import * as OS from "node:os";

import {
  FilesError,
  type FilesDeleteInput,
  type FilesDeleteResult,
  type FilesEntry,
  type FilesListInput,
  type FilesListResult,
  type FilesMoveInput,
  type FilesMoveResult,
  type FilesPublishSiteInput,
  type FilesPublishSiteResult,
  type FilesRenameInput,
  type FilesSearchInput,
  type FilesSearchResult,
  type FilesShare,
  type FilesShareCreateInput,
  type FilesShareListInput,
  type FilesShareListResult,
  type FilesShareRevokeInput,
  type FilesCreateFolderInput,
  type FilesStatInput,
  FILES_SHARE_ROUTE_PREFIX,
} from "@t3tools/contracts";
import { Context, Effect, Layer, Option } from "effect";

import { FileSharesRepository, type FileShareRow } from "../persistence/Services/FileShares.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  createFolder,
  deleteEntries,
  listFolder,
  moveEntries,
  renameEntry,
  searchByName,
  statPath,
  statResolved,
} from "./fileManager.ts";
import { FilesPathError, isHiddenPath, resolveFilesRoot, resolveInsideRoot } from "./filesPaths.ts";
import { publishToUnoHosting } from "./sitePublish.ts";
import {
  generateShareToken,
  hashSharePassword,
  shareExpiresAt,
  shareStatus,
} from "./shareTokens.ts";

/** Overrides the files root (tests, unusual installs). Defaults to the home dir. */
export const FILES_ROOT_ENV = "UNO_WORK_FILES_ROOT";

export interface FilesServiceShape {
  readonly rootPath: Effect.Effect<string, FilesError>;
  readonly list: (input: FilesListInput) => Effect.Effect<FilesListResult, FilesError>;
  readonly stat: (input: FilesStatInput) => Effect.Effect<FilesEntry, FilesError>;
  readonly createFolder: (input: FilesCreateFolderInput) => Effect.Effect<FilesEntry, FilesError>;
  readonly rename: (input: FilesRenameInput) => Effect.Effect<FilesEntry, FilesError>;
  readonly move: (input: FilesMoveInput) => Effect.Effect<FilesMoveResult, FilesError>;
  readonly remove: (input: FilesDeleteInput) => Effect.Effect<FilesDeleteResult, FilesError>;
  readonly search: (input: FilesSearchInput) => Effect.Effect<FilesSearchResult, FilesError>;
  readonly createShare: (input: FilesShareCreateInput) => Effect.Effect<FilesShare, FilesError>;
  readonly listShares: (
    input: FilesShareListInput,
  ) => Effect.Effect<FilesShareListResult, FilesError>;
  readonly revokeShare: (input: FilesShareRevokeInput) => Effect.Effect<FilesShare, FilesError>;
  readonly publishSite: (
    input: FilesPublishSiteInput,
  ) => Effect.Effect<FilesPublishSiteResult, FilesError>;
  /** Owner download route: a file path resolved inside the root. */
  readonly resolveOwnerFile: (path: string) => Effect.Effect<string, FilesError>;
  /** Public route: the share behind a token (any status; the caller decides). */
  readonly findShareByToken: (token: string) => Effect.Effect<FileShareRow | null, FilesError>;
  readonly recordShareAccess: (shareId: string) => Effect.Effect<void>;
}

export class FilesService extends Context.Service<FilesService, FilesServiceShape>()(
  "t3/files/FilesService",
) {}

const nowIso = () => new Date().toISOString();

function describe(cause: unknown, fallback: string): string {
  if (cause instanceof FilesPathError) return cause.message;
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EACCES" || code === "EPERM") return "You don't have permission to do that here.";
  if (code === "ENOSPC") return "The disk is full.";
  if (code === "ENOENT") return "This file or folder no longer exists.";
  if (code === "ENOTEMPTY") return "The folder isn't empty.";
  const detail = cause instanceof Error ? cause.message : null;
  return detail ? `${fallback} (${detail})` : fallback;
}

function attempt<A>(run: () => Promise<A>, fallback: string): Effect.Effect<A, FilesError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new FilesError({ message: describe(cause, fallback), cause }),
  });
}

function persistenceError(cause: unknown): FilesError {
  return new FilesError({ message: "Couldn't update share links. Try again.", cause });
}

export function toFilesShare(row: FileShareRow): FilesShare {
  return {
    id: row.shareId,
    token: row.token,
    path: row.path,
    name: row.path.split("/").findLast((segment) => segment.length > 0) ?? row.path,
    kind: row.kind,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    hasPassword: row.passwordHash !== null,
    accessCount: row.accessCount,
    lastAccessedAt: row.lastAccessedAt,
    urlPath: `${FILES_SHARE_ROUTE_PREFIX}/${row.token}`,
  };
}

export const makeFilesService = (options: { readonly root?: string } = {}) =>
  Effect.gen(function* () {
    const shares = yield* FileSharesRepository;
    const settings = yield* ServerSettingsService;
    const configuredRoot = options.root ?? process.env[FILES_ROOT_ENV]?.trim() ?? OS.homedir();

    // Resolved on first use (the home may be created after the daemon starts).
    const rootPath = yield* Effect.cached(
      attempt(() => resolveFilesRoot(configuredRoot), "The home folder isn't available."),
    );

    const withRoot = <A>(fallback: string, run: (root: string) => Promise<A>) =>
      rootPath.pipe(Effect.flatMap((root) => attempt(() => run(root), fallback)));

    const list: FilesServiceShape["list"] = (input) =>
      withRoot("Couldn't open this folder.", (root) => listFolder(root, input));

    const stat: FilesServiceShape["stat"] = (input) =>
      withRoot("Couldn't read this item.", (root) => statPath(root, input.path));

    const create: FilesServiceShape["createFolder"] = (input) =>
      withRoot("Couldn't create the folder.", (root) => createFolder(root, input));

    const rename: FilesServiceShape["rename"] = (input) =>
      Effect.gen(function* () {
        const result = yield* withRoot("Couldn't rename it.", (root) => renameEntry(root, input));
        if (result.from !== result.entry.path) {
          yield* shares
            .repointPath({ fromPath: result.from, toPath: result.entry.path })
            .pipe(Effect.mapError(persistenceError));
        }
        return result.entry;
      });

    const move: FilesServiceShape["move"] = (input) =>
      Effect.gen(function* () {
        const moved = yield* withRoot("Couldn't move it.", (root) => moveEntries(root, input));
        for (const item of moved) {
          if (item.from === item.entry.path) continue;
          yield* shares
            .repointPath({ fromPath: item.from, toPath: item.entry.path })
            .pipe(Effect.mapError(persistenceError));
        }
        return { entries: moved.map((item) => item.entry) };
      });

    const remove: FilesServiceShape["remove"] = (input) =>
      Effect.gen(function* () {
        const deleted = yield* withRoot("Couldn't delete it.", (root) =>
          deleteEntries(root, input.paths),
        );
        let revokedShares = 0;
        for (const path of deleted) {
          revokedShares += yield* shares
            .revokeUnder({ path, revokedAt: nowIso() })
            .pipe(Effect.mapError(persistenceError));
        }
        return { deleted: deleted.length, revokedShares };
      });

    const search: FilesServiceShape["search"] = (input) =>
      withRoot("Search didn't finish.", (root) => searchByName(root, input));

    const createShare: FilesServiceShape["createShare"] = (input) =>
      Effect.gen(function* () {
        const root = yield* rootPath;
        const target = yield* attempt(
          () => resolveInsideRoot(root, input.path),
          "Couldn't share this item.",
        );
        if (target === root) {
          return yield* new FilesError({
            message: "Your whole home folder can't be shared. Share a file or a folder inside it.",
          });
        }
        if (isHiddenPath(root, target)) {
          return yield* new FilesError({
            message: "Hidden files and folders (names starting with a dot) can't be shared.",
          });
        }
        const entry = yield* attempt(() => statResolved(root, target), "Couldn't share this item.");
        const passwordHash =
          input.password === null || input.password === undefined
            ? null
            : yield* attempt(
                () => hashSharePassword(input.password!),
                "Couldn't set the password.",
              );
        const now = new Date();
        const row: FileShareRow = {
          shareId: crypto.randomUUID(),
          token: generateShareToken(),
          path: target,
          kind: entry.kind === "directory" ? "folder" : "file",
          createdAt: now.toISOString(),
          expiresAt: shareExpiresAt(now, input.expiresInSeconds),
          revokedAt: null,
          passwordHash,
          accessCount: 0,
          lastAccessedAt: null,
        };
        yield* shares.create(row).pipe(Effect.mapError(persistenceError));
        yield* Effect.logInfo("files.share.created", {
          shareId: row.shareId,
          kind: row.kind,
          expiresAt: row.expiresAt,
          password: passwordHash !== null,
        });
        return toFilesShare(row);
      });

    const listShares: FilesServiceShape["listShares"] = (input) =>
      Effect.gen(function* () {
        const rows = yield* shares
          .list({ path: input.path })
          .pipe(Effect.mapError(persistenceError));
        const now = new Date();
        const visible = input.includeInactive
          ? rows
          : rows.filter((row) => shareStatus(row, now) === "active");
        return { shares: visible.map(toFilesShare) };
      });

    const revokeShare: FilesServiceShape["revokeShare"] = (input) =>
      Effect.gen(function* () {
        yield* shares
          .revoke({ shareId: input.id, revokedAt: nowIso() })
          .pipe(Effect.mapError(persistenceError));
        const row = yield* shares.getById(input.id).pipe(Effect.mapError(persistenceError));
        if (Option.isNone(row)) {
          return yield* new FilesError({ message: "This link doesn't exist anymore." });
        }
        yield* Effect.logInfo("files.share.revoked", { shareId: input.id });
        return toFilesShare(row.value);
      });

    const publishSite: FilesServiceShape["publishSite"] = (input) =>
      Effect.gen(function* () {
        const root = yield* rootPath;
        const target = yield* attempt(
          () => resolveInsideRoot(root, input.path),
          "Couldn't publish this.",
        );
        if (target === root || isHiddenPath(root, target)) {
          return yield* new FilesError({
            message: "Pick a web page or a folder with a website inside your home folder.",
          });
        }
        const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
        const apiKey = current?.uno.apiKey.trim() ?? "";
        if (apiKey.length === 0) {
          return yield* new FilesError({
            message:
              "Publishing needs this computer to be connected to your Uno account (Settings → Uno account).",
          });
        }
        const result = yield* attempt(
          () => publishToUnoHosting({ path: target, slug: input.slug, apiKey }),
          "Publishing didn't work.",
        );
        yield* Effect.logInfo("files.site.published", {
          slug: result.slug,
          files: result.filesCount,
          bytes: result.sizeBytes,
        });
        return result;
      });

    const resolveOwnerFile: FilesServiceShape["resolveOwnerFile"] = (path) =>
      withRoot("Couldn't open this file.", async (root) => {
        const resolved = await resolveInsideRoot(root, path);
        const entry = await statResolved(root, resolved);
        if (entry.kind !== "file") throw new FilesPathError("not_a_file", "This is a folder.");
        return resolved;
      });

    const findShareByToken: FilesServiceShape["findShareByToken"] = (token) =>
      shares
        .getByToken(token)
        .pipe(Effect.map(Option.getOrNull), Effect.mapError(persistenceError));

    const recordShareAccess: FilesServiceShape["recordShareAccess"] = (shareId) =>
      shares.recordAccess({ shareId, at: nowIso() }).pipe(Effect.ignore);

    return {
      rootPath,
      list,
      stat,
      createFolder: create,
      rename,
      move,
      remove,
      search,
      createShare,
      listShares,
      revokeShare,
      publishSite,
      resolveOwnerFile,
      findShareByToken,
      recordShareAccess,
    } satisfies FilesServiceShape;
  });

export const FilesServiceLive = Layer.effect(FilesService, makeFilesService());
