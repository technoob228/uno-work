import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig } from "../config.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
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
afterEach(async () => {
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
  const configLayer = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
    Layer.provide(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(AssistantProjectsLive, ProjectionProjectRepositoryLive).pipe(
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
  return { config, folder, upsert, blockFor };
}

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
});
