import { Effect, FileSystem, Path } from "effect";
import * as Random from "effect/Random";

/**
 * Owner-only by default (16.10): settings.json holds the computer's token and
 * the Uno AI key, the vault file holds logins — none of these files is for
 * other users of the machine. The mode is set on the temp file before the
 * rename, so the target never exists with wider rights (whatever the umask).
 */
export const PRIVATE_FILE_MODE = 0o600;

export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string;
  readonly mode?: number;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempFileId = yield* Random.nextUUIDv4;
      const targetDirectory = path.dirname(input.filePath);
      const mode = input.mode ?? PRIVATE_FILE_MODE;

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      const tempDirectory = yield* fs.makeTempDirectoryScoped({
        directory: targetDirectory,
        prefix: `${path.basename(input.filePath)}.`,
      });
      const tempPath = path.join(tempDirectory, `${tempFileId}.tmp`);

      yield* fs.writeFileString(tempPath, input.contents, { mode });
      yield* fs.chmod(tempPath, mode);
      yield* fs.rename(tempPath, input.filePath);
    }),
  );

/**
 * Narrow an existing file to owner-only if group/others can read it — files
 * written before 0.0.145 (0644) and edits by other writers (the console's
 * exec script, an editor). A missing file is fine; errors are the caller's.
 */
export const tightenFileMode = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(filePath))) return false;
    const info = yield* fs.stat(filePath);
    if (info.type !== "File" || (info.mode & 0o077) === 0) return false;
    yield* fs.chmod(filePath, PRIVATE_FILE_MODE);
    return true;
  });
