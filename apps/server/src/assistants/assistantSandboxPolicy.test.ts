import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, type OrchestrationThreadShell } from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig } from "../config.ts";
import { CustomMcpServers } from "../mcp/customMcpServers.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { HarnessSandboxPolicy } from "../provider/Services/HarnessSandboxPolicy.ts";
import {
  assistantSandboxCapability,
  resetAssistantSandboxCapabilityCache,
} from "../sandbox/sandboxCapability.ts";
import { AssistantHarnessSandboxPolicyLive } from "./assistantSandboxPolicy.ts";
import { ASSISTANT_SANDBOX_UNAVAILABLE_RUN_MESSAGE } from "./assistantSandboxRules.ts";
import { writeStoredAccess } from "./localAssistantStore.ts";

const HOME = os.homedir();
const ANA = "assistant-ana";
const ANA_DIR = nodePath.join(HOME, "UnoWork", "Assistants", "ana");
const SHOP_DIR = nodePath.join(HOME, "projects", "shop");

const projects = [
  { id: ANA, workspaceRoot: ANA_DIR },
  { id: "shop", workspaceRoot: SHOP_DIR },
  { id: "bank", workspaceRoot: nodePath.join(HOME, "projects", "bank") },
];

const shell = (
  id: string,
  projectId: string,
  spawnedByThreadId: string | null = null,
): OrchestrationThreadShell =>
  ({
    id: ThreadId.make(id),
    projectId,
    spawnedByThreadId,
    assistantRole: null,
  }) as unknown as OrchestrationThreadShell;

const threads = new Map<string, OrchestrationThreadShell>([
  ["mine", shell("mine", "shop")],
  ["ana-chat", shell("ana-chat", ANA)],
  ["ana-started", shell("ana-started", "shop", "ana-chat")],
]);

const dirs: string[] = [];
afterEach(() => {
  resetAssistantSandboxCapabilityCache();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Primes the cached capability so the policy doesn't probe this machine. */
const primeCapability = (available: boolean) =>
  assistantSandboxCapability(Date.now(), {
    platform: "linux",
    findBwrap: () => "/usr/bin/bwrap",
    run: async () => (available ? 0 : 1),
  });

async function setup(input: {
  readonly anaProjects: ReadonlyArray<string> | "all" | null;
  readonly noted?: Map<string, string | null>;
}) {
  const baseDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "sbx-policy-"));
  dirs.push(baseDir);
  const configLayer = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
    Layer.provide(NodeServices.layer),
  );
  const config = await Effect.runPromise(
    Effect.service(ServerConfig).pipe(Effect.provide(configLayer)),
  );
  if (input.anaProjects !== null) {
    await writeStoredAccess(config.stateDir, ANA, {
      scopes: ["threads:read", "threads:write", "threads:approve"],
      projectAllowlist:
        input.anaProjects === "all" ? "all" : ([ANA, ...input.anaProjects] as never),
      autoApprove: true,
    });
  }
  const noted = input.noted;
  const layer = AssistantHarnessSandboxPolicyLive.pipe(
    Layer.provide(
      noted
        ? Layer.mock(CustomMcpServers)({
            current: () => [],
            forSession: () => [],
            noteSessionAssistant: (threadId, projectId) =>
              Effect.sync(() => {
                noted.set(threadId, projectId);
              }),
          })
        : Layer.empty,
    ),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadShellById: (threadId) =>
          Effect.succeed(Option.fromNullishOr(threads.get(threadId))),
        getShellSnapshot: () =>
          Effect.succeed({ projects, threads: [...threads.values()] } as never),
      }),
    ),
    Layer.provide(configLayer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  );
  const decide = (threadId: string, cwd?: string) =>
    Effect.runPromise(
      Effect.service(HarnessSandboxPolicy).pipe(
        Effect.flatMap((policy) => policy.decide({ threadId: ThreadId.make(threadId), cwd })),
        Effect.provide(layer),
      ),
    );
  return { decide, config };
}

describe("AssistantHarnessSandboxPolicyLive", () => {
  it("leaves the person's own chats and All-projects assistants alone", async () => {
    await primeCapability(false);
    const { decide } = await setup({ anaProjects: "all" });
    expect(await decide("mine", SHOP_DIR)).toEqual({ _tag: "none" });
    expect(await decide("ana-chat", ANA_DIR)).toEqual({ _tag: "none" });
  });

  it("an assistant with nothing set yet (no token, no stored access) runs as All projects", async () => {
    await primeCapability(false);
    const { decide } = await setup({ anaProjects: null });
    expect(await decide("ana-chat", ANA_DIR)).toEqual({ _tag: "none" });
  });

  it("refuses a restricted assistant's chats where the sandbox can't run", async () => {
    await primeCapability(false);
    const { decide } = await setup({ anaProjects: ["shop"] });
    const refused = { _tag: "refuse", message: ASSISTANT_SANDBOX_UNAVAILABLE_RUN_MESSAGE };
    expect(await decide("ana-chat", ANA_DIR)).toEqual(refused);
    // A chat it started inherits the restriction.
    expect(await decide("ana-started", SHOP_DIR)).toEqual(refused);
    // The person's chat in the same project is untouched.
    expect(await decide("mine", SHOP_DIR)).toEqual({ _tag: "none" });
  });

  it("notes whose chat it is for the assistant's own MCP servers (sandboxed or not)", async () => {
    await primeCapability(true);
    const noted = new Map<string, string | null>();
    const { decide } = await setup({ anaProjects: ["shop"], noted });
    await decide("ana-started", SHOP_DIR);
    await decide("mine", SHOP_DIR);
    expect(Object.fromEntries(noted)).toEqual({ "ana-started": ANA, mine: null });
    const all = new Map<string, string | null>();
    const open = await setup({ anaProjects: "all", noted: all });
    await open.decide("ana-chat", ANA_DIR);
    expect(Object.fromEntries(all)).toEqual({ "ana-chat": ANA });
  });

  it("sandboxes a restricted assistant's chats where it can", async () => {
    await primeCapability(true);
    const { decide, config } = await setup({ anaProjects: ["shop"] });
    const decision = await decide("ana-started", SHOP_DIR);
    expect(decision).toEqual({
      _tag: "sandbox",
      plan: {
        bwrapPath: "/usr/bin/bwrap",
        home: HOME,
        cwd: SHOP_DIR,
        writableDirs: [ANA_DIR, SHOP_DIR],
        hiddenDirs: [],
        tmpDir: nodePath.join(config.stateDir, "sandbox", "tmp", ANA),
        assistantProjectId: ANA,
      },
    });
  });
});
