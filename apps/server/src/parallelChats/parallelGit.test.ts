import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";

import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { makeParallelGit, rootAt } from "./parallelGit.ts";

const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-parallel-git-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(TestLayer)("parallelGit", (it) => {
  it.effect("a file edited in the same second, same size, still shows in the snapshot", () =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const git = makeParallelGit(driver.execute);
      const dir = realpathSync(mkdtempSync(nodePath.join(tmpdir(), "uno-parallel-git-")));
      try {
        const root = nodePath.join(dir, "root");
        mkdirSync(root);
        const env = {
          ...process.env,
          GIT_DIR: nodePath.join(root, ".uno-git"),
          GIT_WORK_TREE: root,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@x",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@x",
        };
        execFileSync("git", ["init", "-q", "--bare", env.GIT_DIR]);
        execFileSync("git", ["--git-dir", env.GIT_DIR, "config", "core.bare", "false"]);
        mkdirSync(nodePath.join(env.GIT_DIR, "info"), { recursive: true });
        writeFileSync(nodePath.join(env.GIT_DIR, "info", "exclude"), ".uno-git/\n");
        // Commit and edit within one second, snapshot in the next one: a seeded
        // index with a fresh time would call the edited file clean (git
        // compares seconds), and an apply would then write over the edit.
        let checked = 0;
        for (let round = 0; round < 40 && checked < 3; round++) {
          const second = Math.floor(Date.now() / 1000);
          writeFileSync(nodePath.join(root, "price.txt"), `price ${round % 10}0\n`);
          execFileSync("git", ["add", "-A"], { cwd: root, env });
          execFileSync("git", ["commit", "-qm", `r${round}`, "--allow-empty"], { cwd: root, env });
          const committed = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
            cwd: root,
            env,
            encoding: "utf8",
          }).trim();
          writeFileSync(nodePath.join(root, "price.txt"), `price ${round % 10}5\n`);
          if (Math.floor(Date.now() / 1000) !== second) continue;
          while (Math.floor(Date.now() / 1000) === second) {
            yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
          }
          const tree = yield* git.snapshotTree(rootAt(root), nodePath.join(dir, "tmp"));
          expect(tree).not.toBe(committed);
          checked++;
        }
        expect(checked).toBeGreaterThan(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );
});
