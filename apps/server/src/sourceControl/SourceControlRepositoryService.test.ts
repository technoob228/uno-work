import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { GitCommandError, type SourceControlProviderError } from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import { PublishKeyCheck, type PublishKeyCheckShape } from "../projectSync/publishKeyCheck.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type * as SourceControlProvider from "./SourceControlProvider.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as SourceControlRepositoryService from "./SourceControlRepositoryService.ts";

const CLONE_URLS = {
  nameWithOwner: "octocat/t3code",
  url: "https://github.com/octocat/t3code",
  sshUrl: "git@github.com:octocat/t3code.git",
};

function makeProvider(
  overrides: Partial<SourceControlProvider.SourceControlProviderShape> = {},
): SourceControlProvider.SourceControlProviderShape {
  const unsupported = (operation: string) =>
    Effect.die(`unexpected provider operation ${operation}`) as Effect.Effect<
      never,
      SourceControlProviderError
    >;

  return {
    kind: "github",
    listChangeRequests: () => unsupported("listChangeRequests"),
    getChangeRequest: () => unsupported("getChangeRequest"),
    createChangeRequest: () => unsupported("createChangeRequest"),
    getRepositoryCloneUrls: () => Effect.succeed(CLONE_URLS),
    createRepository: () => Effect.succeed(CLONE_URLS),
    getDefaultBranch: () => Effect.succeed(null),
    checkoutChangeRequest: () => unsupported("checkoutChangeRequest"),
    ...overrides,
  };
}

function processOutput(): GitVcsDriver.ExecuteGitResult {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function makeLayer(input: {
  readonly provider?: SourceControlProvider.SourceControlProviderShape;
  readonly git?: Partial<GitVcsDriver.GitVcsDriverShape>;
  readonly keyCheck?: PublishKeyCheckShape["problem"];
}) {
  return SourceControlRepositoryService.layer.pipe(
    Layer.provide(
      Layer.succeed(PublishKeyCheck, {
        problem: input.keyCheck ?? (() => Effect.succeed(null)),
      }),
    ),
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        get: () => Effect.succeed(input.provider ?? makeProvider()),
      }),
    ),
    Layer.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        execute: () => Effect.succeed(processOutput()),
        ensureRemote: () => Effect.succeed("origin"),
        pushCurrentBranch: () =>
          Effect.succeed({
            status: "pushed" as const,
            branch: "feature/remote-v1",
            upstreamBranch: "origin/feature/remote-v1",
            setUpstream: true,
          }),
        ...input.git,
      }),
    ),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-source-control-repos-" })),
    Layer.provideMerge(NodeServices.layer),
  );
}

it.effect("looks up repositories through the requested provider without search", () => {
  const calls: Array<{ cwd: string; repository: string }> = [];
  const provider = makeProvider({
    getRepositoryCloneUrls: (input) =>
      Effect.sync(() => {
        calls.push({ cwd: input.cwd, repository: input.repository });
        return CLONE_URLS;
      }),
  });

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.lookupRepository({
      provider: "github",
      repository: "octocat/t3code",
      cwd: "/workspace",
    });

    assert.deepStrictEqual(result, { provider: "github", ...CLONE_URLS });
    assert.deepStrictEqual(calls, [{ cwd: "/workspace", repository: "octocat/t3code" }]);
  }).pipe(Effect.provide(makeLayer({ provider })));
});

it.effect("clones a looked-up repository into the requested destination", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parent = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-source-control-clone-parent-",
    });
    const destinationPath = `${parent}/t3code`;
    const cloneCalls: Array<{ cwd: string; args: ReadonlyArray<string> }> = [];

    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const result = yield* service.cloneRepository({
        provider: "github",
        repository: "octocat/t3code",
        destinationPath,
        protocol: "https",
      });

      assert.deepStrictEqual(result, {
        cwd: destinationPath,
        remoteUrl: CLONE_URLS.url,
        repository: { provider: "github", ...CLONE_URLS },
      });
      assert.deepStrictEqual(cloneCalls, [
        {
          cwd: parent,
          args: ["clone", "--", CLONE_URLS.url, "t3code"],
        },
      ]);
    }).pipe(
      Effect.provide(
        makeLayer({
          git: {
            execute: (input) =>
              Effect.sync(() => {
                cloneCalls.push({ cwd: input.cwd, args: input.args });
                return processOutput();
              }),
          },
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("publishes by creating the repository, adding a remote, and pushing upstream", () => {
  const createCalls: Array<{ cwd: string; repository: string; visibility: string }> = [];
  const remoteCalls: Array<{ cwd: string; preferredName: string; url: string }> = [];
  const pushCalls: Array<{ cwd: string; remoteName: string | null | undefined }> = [];
  const provider = makeProvider({
    createRepository: (input) =>
      Effect.sync(() => {
        createCalls.push({
          cwd: input.cwd,
          repository: input.repository,
          visibility: input.visibility,
        });
        return CLONE_URLS;
      }),
  });

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.publishRepository({
      cwd: "/workspace",
      provider: "github",
      repository: "octocat/t3code",
      visibility: "private",
      remoteName: "origin",
      protocol: "ssh",
    });

    assert.deepStrictEqual(result, {
      repository: { provider: "github", ...CLONE_URLS },
      remoteName: "origin",
      remoteUrl: CLONE_URLS.sshUrl,
      branch: "feature/remote-v1",
      upstreamBranch: "origin/feature/remote-v1",
      status: "pushed",
    });
    assert.deepStrictEqual(createCalls, [
      { cwd: "/workspace", repository: "octocat/t3code", visibility: "private" },
    ]);
    assert.deepStrictEqual(remoteCalls, [
      { cwd: "/workspace", preferredName: "origin", url: CLONE_URLS.sshUrl },
    ]);
    assert.deepStrictEqual(pushCalls, [{ cwd: "/workspace", remoteName: "origin" }]);
  }).pipe(
    Effect.provide(
      makeLayer({
        provider,
        git: {
          ensureRemote: (input) =>
            Effect.sync(() => {
              remoteCalls.push(input);
              return "origin";
            }),
          pushCurrentBranch: (cwd, _fallbackBranch, options) =>
            Effect.sync(() => {
              pushCalls.push({ cwd, remoteName: options?.remoteName });
              return {
                status: "pushed" as const,
                branch: "feature/remote-v1",
                upstreamBranch: "origin/feature/remote-v1",
                setUpstream: true,
              };
            }),
        },
      }),
    ),
  );
});

it.effect("publishes to the remote name returned by ensureRemote", () => {
  const pushCalls: Array<{ cwd: string; remoteName: string | null | undefined }> = [];

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.publishRepository({
      cwd: "/workspace",
      provider: "github",
      repository: "octocat/t3code",
      visibility: "private",
      remoteName: "origin",
      protocol: "ssh",
    });

    assert.equal(result.remoteName, "origin-1");
    assert.deepStrictEqual(pushCalls, [{ cwd: "/workspace", remoteName: "origin-1" }]);
  }).pipe(
    Effect.provide(
      makeLayer({
        git: {
          ensureRemote: () => Effect.succeed("origin-1"),
          pushCurrentBranch: (cwd, _fallbackBranch, options) =>
            Effect.sync(() => {
              pushCalls.push({ cwd, remoteName: options?.remoteName });
              return {
                status: "pushed" as const,
                branch: "feature/remote-v1",
                upstreamBranch: `${options?.remoteName ?? "missing"}/feature/remote-v1`,
                setUpstream: true,
              };
            }),
        },
      }),
    ),
  );
});

const PUBLISH_INPUT = {
  cwd: "/workspace",
  provider: "github",
  repository: "octocat/t3code",
  visibility: "private",
} as const;

it.effect("publishes nothing, and creates nothing, when the project holds a key", () => {
  let created = 0;
  const provider = makeProvider({
    createRepository: () =>
      Effect.sync(() => {
        created += 1;
        return CLONE_URLS;
      }),
  });
  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const error = yield* service.publishRepository(PUBLISH_INPUT).pipe(Effect.flip);
    assert.strictEqual(error.detail, "Nothing was published: config.json");
    assert.strictEqual(created, 0);
  }).pipe(
    Effect.provide(
      makeLayer({
        provider,
        keyCheck: () => Effect.succeed("Nothing was published: config.json"),
      }),
    ),
  );
});

it.effect("a key check that can't run stops the publish", () => {
  let created = 0;
  const provider = makeProvider({
    createRepository: () =>
      Effect.sync(() => {
        created += 1;
        return CLONE_URLS;
      }),
  });
  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const error = yield* service.publishRepository(PUBLISH_INPUT).pipe(Effect.flip);
    assert.strictEqual(error.detail, "Couldn't check the project's files before syncing.");
    assert.strictEqual(created, 0);
  }).pipe(
    Effect.provide(
      makeLayer({
        provider,
        keyCheck: () =>
          Effect.fail(new Error("Couldn't check the project's files before syncing.")),
      }),
    ),
  );
});

it.effect("falls back to HTTPS when this computer has no SSH key for the host", () => {
  const remotes: Array<ReadonlyArray<string>> = [];
  let pushes = 0;
  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.publishRepository(PUBLISH_INPUT);
    assert.strictEqual(result.status, "pushed");
    assert.strictEqual(pushes, 2);
    assert.deepStrictEqual(remotes, [["remote", "set-url", "origin", CLONE_URLS.url]]);
  }).pipe(
    Effect.provide(
      makeLayer({
        git: {
          execute: (input) =>
            Effect.sync(() => {
              if (input.args[0] === "remote") remotes.push(input.args);
              return processOutput();
            }),
          pushCurrentBranch: () =>
            Effect.suspend(() => {
              pushes += 1;
              return pushes === 1
                ? Effect.fail(
                    new GitCommandError({
                      operation: "push",
                      command: "git push",
                      cwd: "/workspace",
                      detail: "git@github.com: Permission denied (publickey).",
                    }),
                  )
                : Effect.succeed({
                    status: "pushed" as const,
                    branch: "main",
                    upstreamBranch: "origin/main",
                    setUpstream: true,
                  });
            }),
        },
      }),
    ),
  );
});

it.effect("publish succeeds with status remote_added when the local repo has no commits", () => {
  let pushCalls = 0;
  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.publishRepository({
      cwd: "/workspace",
      provider: "github",
      repository: "octocat/t3code",
      visibility: "private",
      remoteName: "origin",
      protocol: "ssh",
    });

    assert.deepStrictEqual(result, {
      repository: { provider: "github", ...CLONE_URLS },
      remoteName: "origin",
      remoteUrl: CLONE_URLS.sshUrl,
      branch: "main",
      status: "remote_added",
    });
    assert.strictEqual(pushCalls, 0);
  }).pipe(
    Effect.provide(
      makeLayer({
        git: {
          execute: (input) =>
            input.args[0] === "rev-parse"
              ? Effect.fail(
                  new GitCommandError({
                    operation: input.operation,
                    command: "git rev-parse --verify HEAD",
                    cwd: input.cwd,
                    detail: "fatal: Needed a single revision",
                  }),
                )
              : Effect.succeed(processOutput()),
          statusDetails: () =>
            Effect.succeed({
              isRepo: true,
              hasOriginRemote: true,
              isDefaultBranch: true,
              branch: "main",
              upstreamRef: null,
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
              hasUpstream: false,
              aheadCount: 0,
              behindCount: 0,
              aheadOfDefaultCount: 0,
            }),
          pushCurrentBranch: () =>
            Effect.sync(() => {
              pushCalls += 1;
              return {
                status: "pushed" as const,
                branch: "main",
                upstreamBranch: "origin/main",
                setUpstream: true,
              };
            }),
        },
      }),
    ),
  );
});

// Upstream t3code 1cc9d413a5.
it.each([
  [
    "userinfo",
    "fatal: unable to access 'https://x-access-token:ghp_s3cret@github.com/o/r.git/': 403",
    "fatal: unable to access 'https://github.com/o/r.git/': 403",
  ],
  [
    "a quoted query token",
    "fatal: unable to access 'https://github.com/o/r.git?access_token=s3'cret/': 403",
    "fatal: unable to access 'https://github.com/o/r.git': 403",
  ],
  [
    "an unquoted query token",
    "fatal: https://github.com/o/r.git?access_token=s3cret/info/refs not valid",
    "fatal: https://github.com/o/r.git not valid",
  ],
  ["no credentials", "fatal: repository not found", "fatal: repository not found"],
] as const)("redacts %s from clone error text", (_label, input, expected) => {
  assert.strictEqual(SourceControlRepositoryService.redactUrlCredentials(input), expected);
});
