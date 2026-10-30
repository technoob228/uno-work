/**
 * What's read before a project is published to a host outside Uno (GitHub,
 * GitLab): the engine's reader of what leaves, over the whole history, since
 * nothing has been there yet. Required by `SourceControlRepositoryService`, so
 * there is no way to publish around it, and a check that can't run stops the
 * publish.
 *
 * @module projectSync/publishKeyCheck
 */
import os from "node:os";

import { Context, Effect, Layer } from "effect";

import { loadEngine } from "./syncEngine.ts";

export interface PublishKeyCheckShape {
  /** Why this folder can't be published (the files, never a value); null when it can. */
  readonly problem: (cwd: string) => Effect.Effect<string | null, Error>;
}

export class PublishKeyCheck extends Context.Service<PublishKeyCheck, PublishKeyCheckShape>()(
  "t3/projectSync/PublishKeyCheck",
) {}

export const layer = Layer.succeed(PublishKeyCheck, {
  problem: (cwd) =>
    Effect.tryPromise({
      try: async () => {
        const home = os.homedir();
        const engine = await loadEngine(home);
        const found = await engine.keysBeforePublish(
          { dir: cwd },
          { home, env: { ...process.env, HOME: home }, hostname: os.hostname() },
        );
        return found.length > 0 ? engine.heldFromPublishMessage(found) : null;
      },
      catch: (cause) =>
        cause instanceof Error ? cause : new Error("Couldn't read the project before publishing."),
    }),
});
