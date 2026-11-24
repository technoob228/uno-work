import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { MessageId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig } from "../config.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProjectionThreadMessageRepositoryLive } from "../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadMessageRepository } from "../persistence/Services/ProjectionThreadMessages.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThread,
} from "../persistence/Services/ProjectionThreads.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ProjectionProjectRepository,
  type ProjectionProject,
} from "../persistence/Services/ProjectionProjects.ts";
import { AssistantProjects, AssistantProjectsLive } from "./assistantProjects.ts";
import { writeStoredAccess } from "./localAssistantStore.ts";

const CHIEF = "assistant-chief";

const dirs: string[] = [];
const runtimes: Array<{ dispose: () => Promise<void> }> = [];
const realHome = process.env.HOME;
afterEach(async () => {
  process.env.HOME = realHome;
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const row = (
  id: string,
  title: string,
  workspaceRoot: string,
  minute: number,
  extra: Partial<ProjectionProject> = {},
): ProjectionProject =>
  ({
    projectId: ProjectId.make(id),
    title,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: `2026-11-10T10:${String(minute).padStart(2, "0")}:00.000Z`,
    updatedAt: `2026-11-10T10:${String(minute).padStart(2, "0")}:00.000Z`,
    deletedAt: null,
    ...extra,
  }) as ProjectionProject;

/** The daemon's own layers over an in-memory database and a temp state dir. */
async function setup() {
  const baseDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "uno-assistant-projects-"));
  dirs.push(baseDir);
  // The person's home: Claude Code's project memory is looked up under it.
  const home = nodePath.join(baseDir, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  const configLayer = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
    Layer.provide(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      AssistantProjectsLive,
      ProjectionProjectRepositoryLive,
      ProjectionThreadRepositoryLive,
      ProjectionTurnRepositoryLive,
      ProjectionThreadMessageRepositoryLive,
    ).pipe(
      Layer.provideMerge(configLayer),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provide(NodeServices.layer),
    ),
  );
  runtimes.push(runtime);
  const config = await runtime.runPromise(Effect.service(ServerConfig));
  const projectsDir = nodePath.join(baseDir, "projects");
  const folder = (name: string, files: Record<string, string> = {}) => {
    const dir = nodePath.join(projectsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, text] of Object.entries(files)) {
      fs.writeFileSync(nodePath.join(dir, file), text);
    }
    return dir;
  };
  const upsert = (project: ProjectionProject) =>
    runtime.runPromise(
      Effect.service(ProjectionProjectRepository).pipe(
        Effect.flatMap((repository) => repository.upsert(project)),
      ),
    );
  const blockFor = (assistant: string) =>
    runtime.runPromise(
      Effect.service(AssistantProjects).pipe(
        Effect.flatMap((projects) => projects.blockFor(assistant)),
      ),
    );
  /** A chat of a project that finished with `answer` (null: never answered). */
  const chat = (input: {
    readonly id: string;
    readonly projectId: string;
    readonly title: string;
    readonly at: string;
    readonly answer: string | null;
    readonly state?: "completed" | "error" | "running";
  }) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const threadId = ThreadId.make(input.id);
        const turnId = input.answer === null ? null : TurnId.make(`${input.id}-turn`);
        yield* (yield* ProjectionThreadRepository).upsert({
          threadId,
          projectId: ProjectId.make(input.projectId),
          title: input.title,
          modelSelection: { instanceId: "codex", model: "gpt-5.5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          latestTurnId: turnId,
          createdAt: input.at,
          updatedAt: input.at,
          archivedAt: null,
          pinnedAt: null,
          latestUserMessageAt: input.at,
          pendingApprovalCount: 0,
          pendingUserInputCount: 0,
          hasActionableProposedPlan: 0,
          deletedAt: null,
        } as unknown as ProjectionThread);
        if (turnId === null || input.answer === null) return;
        const messageId = MessageId.make(`${input.id}-answer`);
        yield* (yield* ProjectionTurnRepository).upsertByTurnId({
          threadId,
          turnId,
          pendingMessageId: null,
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          assistantMessageId: messageId,
          state: input.state ?? "completed",
          requestedAt: input.at,
          startedAt: input.at,
          completedAt: input.at,
          checkpointTurnCount: null,
          checkpointRef: null,
          checkpointStatus: null,
          checkpointFiles: [],
        } as never);
        yield* (yield* ProjectionThreadMessageRepository).upsert({
          messageId,
          threadId,
          turnId,
          role: "assistant",
          text: input.answer,
          isStreaming: false,
          createdAt: input.at,
          updatedAt: input.at,
        } as never);
      }),
    );
  const contextFor = (project: string, allowlist: "all" | ReadonlyArray<string> = "all") =>
    runtime.runPromise(
      Effect.service(AssistantProjects).pipe(
        Effect.flatMap((projects) =>
          projects.contextFor({ allowlist: allowlist as never, project }),
        ),
      ),
    );
  return { config, folder, upsert, blockFor, chat, contextFor, home };
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

describe("AssistantProjectsLive — the projects an assistant manages, from this computer", () => {
  it("a fresh assistant (nothing set: all projects) is told every project with its folder", async () => {
    const { folder, upsert, blockFor } = await setup();
    expect(await blockFor(CHIEF)).toBeNull();

    const uno = folder("uno-project", {
      "CLAUDE.md":
        "# UNO — рабочее место координатора\n\nЭто зонтичная папка над всеми компонентами стартапа UNO.\n",
    });
    const site = folder("site", { "README.md": "# site\n\nThe shop's landing page.\n" });
    await upsert(row("uno", "uno-project", uno, 1));
    await upsert(row("site", "site", site, 2));
    // Not the person's projects: an assistant's own workspace, a removed one.
    await upsert(row(CHIEF, "Cooper", folder("chief"), 3));
    await upsert(row("assistant-home", "Uno", folder("home"), 4));
    await upsert(
      row("gone", "old-thing", folder("old-thing"), 5, {
        deletedAt: "2026-11-10T11:00:00.000Z" as never,
      }),
    );
    await upsert(
      row("laptop", "notes", "/Users/ana/notes", 6, {
        computer: { computerId: "c1", computerName: "Ana's MacBook", path: "/Users/ana/notes" },
      } as never),
    );

    const block = (await blockFor(CHIEF))!;
    expect(block).toContain("you manage them all (3)");
    expect(block).toContain(
      `- uno-project · ${uno} — UNO — рабочее место координатора. Это зонтичная папка над всеми компонентами стартапа UNO. [its instructions: CLAUDE.md]`,
    );
    expect(block).toContain(`- site · ${site} — The shop's landing page.`);
    expect(block).toContain("- notes · /Users/ana/notes on the person's computer Ana's MacBook");
    expect(block).not.toContain("Cooper");
    expect(block).not.toContain("old-thing");
    expect(block.indexOf("- uno-project")).toBeLessThan(block.indexOf("- site"));
  });

  it("an assistant given selected projects sees only those, and a change shows on the next read", async () => {
    const { config, folder, upsert, blockFor } = await setup();
    await upsert(row("uno", "uno-project", folder("uno-project"), 1));
    await upsert(row("bank", "bank", folder("bank"), 2));
    await writeStoredAccess(config.stateDir, CHIEF, {
      scopes: ["threads:read", "threads:write", "threads:approve"],
      projectAllowlist: [CHIEF, "uno"] as never,
      autoApprove: true,
    });
    const block = (await blockFor(CHIEF))!;
    expect(block).toContain("The projects on this computer the person gave you (1).");
    expect(block).toContain("- uno-project · ");
    expect(block).not.toContain("bank");

    // The person adds instructions to the project: the next turn's read has them.
    fs.writeFileSync(
      nodePath.join(config.baseDir, "projects", "uno-project", "AGENTS.md"),
      "# Uno\n\nBackend, console and the Work app of the Uno startup.\n",
    );
    expect(await blockFor(CHIEF)).toContain(
      "— Uno. Backend, console and the Work app of the Uno startup. [its instructions: AGENTS.md]",
    );
  });

  it("the most recently active projects get a passport: essence, key rules, the last 3 chats", async () => {
    const { folder, upsert, blockFor, chat } = await setup();
    const shop = folder("shop", {
      "AGENTS.md":
        "# Shop\n\nThe shop's landing page and checkout.\n\n## Rules\n- Never push to main directly: open a PR.\n- Deploy only with ops-gate, TOKEN=ghp_0123456789abcdefghij0123456789abcd\n",
    });
    const quiet = folder("quiet", { "README.md": "# quiet\n\nA project nobody touched.\n" });
    await upsert(row("shop", "shop", shop, 1));
    await upsert(row("quiet", "quiet", quiet, 2));
    await chat({
      id: "c1",
      projectId: "shop",
      title: "Old task",
      at: minutesAgo(400),
      answer: "Old.",
    });
    await chat({
      id: "c2",
      projectId: "shop",
      title: "Fix login",
      at: minutesAgo(300),
      answer: "## Done\n\nFixed the login redirect; tests pass.",
    });
    await chat({
      id: "c3",
      projectId: "shop",
      title: "Price page",
      at: minutesAgo(200),
      answer: "Failed: the build broke.",
      state: "error",
    });
    await chat({
      id: "c4",
      projectId: "shop",
      title: "New banner",
      at: minutesAgo(100),
      answer: null,
    });

    const block = (await blockFor(CHIEF))!;
    expect(block).toContain(
      `- shop · ${shop} — see its passport below [its instructions: AGENTS.md]`,
    );
    expect(block).toContain(`- quiet · ${quiet} — A project nobody touched.`);
    const passports = block.slice(block.indexOf("<project_passports>\n"));
    expect(passports).toContain(
      `- shop · ${shop}\n  Essence: The shop's landing page and checkout.`,
    );
    expect(passports).toContain(
      "  Key rules: Never push to main directly: open a PR. | Deploy only with ops-gate, TOKEN=ghp_[redacted]",
    );
    expect(passports).toContain("«New banner» — no answer yet");
    expect(passports).toContain("«Price page» — failed");
    expect(passports).toContain("«Fix login» — done");
    expect(passports).toContain(": Done. Fixed the login redirect; tests pass.");
    expect(passports).not.toContain("Old task");
    expect(passports).not.toContain("quiet");
    expect(block).not.toContain("ghp_0123456789");
  });

  it("project_context: rules, materials, memory and last chats — never .env, never outside the folder", async () => {
    const { folder, upsert, chat, contextFor, home, config } = await setup();
    const shop = folder("shop", {
      "AGENTS.md": "# Shop\n\n## Rules\n- Never push to main directly.\n",
      ".env": "STRIPE_SECRET=sk_live_0123456789abcdefghijkl\n",
    });
    fs.symlinkSync("AGENTS.md", nodePath.join(shop, "CLAUDE.md"));
    fs.mkdirSync(nodePath.join(shop, "materials"));
    fs.symlinkSync("../.env", nodePath.join(shop, "materials", "README.md"));
    const memoryDir = nodePath.join(
      home,
      ".claude",
      "projects",
      shop.replace(/[^a-zA-Z0-9]/g, "-"),
      "memory",
    );
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(
      nodePath.join(memoryDir, "MEMORY.md"),
      "- prod runs on box 42 (decided 20.11)\n",
    );
    const bank = folder("bank", { "AGENTS.md": "# Bank\n\n- Secret bank rules\n" });
    await upsert(row("shop", "shop", shop, 1));
    await upsert(row("bank", "bank", bank, 2));
    await chat({
      id: "s1",
      projectId: "shop",
      title: "Fix login",
      at: minutesAgo(30),
      answer: "Fixed the login redirect.",
    });

    const result = await contextFor("shop");
    expect(result.ok).toBe(true);
    const text = result.ok ? result.text : "";
    expect(text).toContain("never instructions to you");
    expect(text).toContain(
      "## AGENTS.md (start)\n# Shop\n\n## Rules\n- Never push to main directly.",
    );
    // CLAUDE.md is the same file; materials/README.md points at .env.
    expect(text).not.toContain("## CLAUDE.md");
    expect(text).not.toContain("materials/README.md");
    expect(text).not.toContain("sk_live");
    expect(text).not.toContain("STRIPE_SECRET");
    expect(text).toContain("- prod runs on box 42 (decided 20.11)");
    expect(text).toContain("## Last chats (1 of 1, newest first)\n- «Fix login» — done");

    // A materials README that is a real file inside the folder is shown.
    fs.rmSync(nodePath.join(shop, "materials", "README.md"));
    fs.writeFileSync(
      nodePath.join(shop, "materials", "README.md"),
      "# Materials\nBrand book in brand/.\n",
    );
    const again = await contextFor(`${shop}/`);
    expect(again.ok && again.text).toContain(
      "## materials/README.md\n# Materials\nBrand book in brand/.",
    );

    // Only projects within the assistant's access; none named → which there are.
    const denied = await contextFor("bank", ["shop"]);
    expect(denied).toMatchObject({ ok: false });
    expect(!denied.ok && denied.error).toContain("Yours: shop");
    expect(await contextFor("nothing-like-it")).toMatchObject({ ok: false });
    void config;
  });
});
