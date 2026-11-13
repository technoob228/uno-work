/**
 * "Move my projects here" (13.11): the developer way through the setup — its
 * steps and progress, what it keeps in the answers, the copy's rows — and the
 * saved progress of older versions reading as before.
 */
import { ProjectId, UnoSetupProgress, type ComputerWorkBring } from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  DEV_PROJECTS_KEY,
  broughtRows,
  decodePicks,
  encodePicks,
  selectedRow,
  withPicks,
  type PickedProject,
} from "./devSetup";
import {
  EMPTY_SETUP_PROGRESS,
  appendAgentsMd,
  markCompleted,
  markSkipped,
  markVisited,
  nextStep,
  parseSetupRouteStep,
  previousStep,
  setupFlowOf,
  setupSidebarState,
  skipRemaining,
  withSetupFlow,
} from "./setupModel";

const decode = Schema.decodeUnknownSync(UnoSetupProgress);

describe("the developer way: steps and progress", () => {
  it("is mode ai + flow dev, and switches back cleanly", () => {
    const dev = withSetupFlow(EMPTY_SETUP_PROGRESS, "dev");
    expect(dev).toMatchObject({ mode: "ai", flow: "dev" });
    expect(setupFlowOf(dev)).toBe("dev");
    const ai = withSetupFlow(dev, "ai");
    expect(ai.mode).toBe("ai");
    expect("flow" in ai).toBe(false);
    expect(setupFlowOf(withSetupFlow(dev, "simple"))).toBe("simple");
    // Already on it: the same object (no write).
    expect(withSetupFlow(dev, "dev")).toBe(dev);
  });

  it("three steps in order, ids apart from the eight", () => {
    expect(nextStep("sign-in")).toBe("import");
    expect(nextStep("import")).toBe("first-chat");
    expect(nextStep("first-chat")).toBeNull();
    expect(previousStep("sign-in")).toBeNull();
    expect(nextStep("ai")).toBe("project");
    expect(parseSetupRouteStep("import")).toBe("import");
    expect(parseSetupRouteStep("start")).toBe("start");
    expect(parseSetupRouteStep("first-chat")).toBe("first-chat");
  });

  it("the sidebar says Set up N/3 and goes to the first open step", () => {
    let progress = withSetupFlow(EMPTY_SETUP_PROGRESS, "dev");
    progress = markVisited(progress, "sign-in");
    expect(setupSidebarState(progress)).toMatchObject({
      hidden: false,
      label: "Set up",
      meta: "1/3",
      step: "import",
    });
    progress = markCompleted(progress, "import");
    expect(setupSidebarState(progress).meta).toBe("2/3");
  });

  it("the first chat finishes it; Skip setup leaves Finish setup on the skipped step", () => {
    const base = markCompleted(withSetupFlow(EMPTY_SETUP_PROGRESS, "dev"), "sign-in");
    expect(markCompleted(markCompleted(base, "import"), "first-chat").finished).toBe(true);
    const skipped = skipRemaining(base);
    expect(skipped.finished).toBe(true);
    expect(skipped.skipped).toEqual(["import"]);
    expect(setupSidebarState(skipped)).toMatchObject({
      hidden: false,
      label: "Finish setup",
      meta: "1 left",
      step: "import",
    });
    // The eight steps aren't touched by the developer way.
    expect(skipped.skipped).not.toContain("project");
  });

  it("the AI path counts as before", () => {
    let progress: UnoSetupProgress = { ...EMPTY_SETUP_PROGRESS, mode: "ai" };
    progress = markCompleted(progress, "ai");
    progress = markSkipped(progress, "project");
    expect(setupSidebarState(progress).meta).toBe("1/8");
    expect(markCompleted(progress, "done").finished).toBe(true);
    expect(skipRemaining(progress).skipped).toHaveLength(6);
  });
});

describe("saved progress across versions", () => {
  it("values saved before the developer way read as they did", () => {
    const saved = {
      mode: "ai",
      visited: ["ai", "project"],
      skipped: ["project"],
      finished: false,
      dismissed: false,
      project: { id: "p1", path: "/home/u/acme", name: "acme", kind: "site" },
      answers: { who: "I run a shop" },
    };
    const decoded = decode(saved);
    expect(decoded).toEqual(saved);
    expect(setupFlowOf(decoded)).toBe("ai");
    expect(setupSidebarState(decoded).meta).toBe("1/8");
    expect(setupFlowOf(decode({ mode: "simple" }))).toBe("simple");
    expect(decode({})).toEqual(EMPTY_SETUP_PROGRESS);
  });

  it("the developer way round-trips, and an unknown way reads as the eight steps", () => {
    const dev = withSetupFlow(EMPTY_SETUP_PROGRESS, "dev");
    expect(decode(Schema.encodeSync(UnoSetupProgress)(dev))).toEqual(dev);
    const future = decode({ mode: "ai", flow: "something-newer" });
    expect(setupFlowOf(future)).toBe("ai");
  });

  it("an older daemon (0.0.188's schema) still decodes what this one saves", () => {
    // The schema as it was: `mode` a strict literal, no `flow`. A literal it
    // didn't know would fail the whole settings file (and reset it).
    const Legacy = Schema.Struct({
      mode: Schema.NullOr(Schema.Literals(["simple", "ai"])).pipe(
        Schema.withDecodingDefault(Effect.succeed(null)),
      ),
      visited: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
      skipped: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
      finished: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
      dismissed: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
      answers: Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(2000))).pipe(
        Schema.withDecodingDefault(Effect.succeed({})),
      ),
    });
    const saved = withPicks(
      markCompleted(withSetupFlow(EMPTY_SETUP_PROGRESS, "dev"), "sign-in"),
      "41",
      [{ path: "/Users/m/code/api", name: "api" }],
    );
    const old = Schema.decodeUnknownSync(Legacy)(Schema.encodeSync(UnoSetupProgress)(saved));
    expect(old.mode).toBe("ai");
    expect(old.visited).toEqual(["sign-in"]);
    expect(old.answers[DEV_PROJECTS_KEY]).toContain("/Users/m/code/api");
  });
});

describe("what the import step keeps", () => {
  it("picks round-trip and always fit one answer", () => {
    const picks: PickedProject[] = [
      { path: "/Users/m/code/api", name: "api" },
      { path: "/Users/m/projects/landing", name: "landing" },
    ];
    expect(decodePicks(encodePicks(picks))).toEqual(picks);
    const many = Array.from({ length: 200 }, (_, index) => ({
      path: `/Users/m/projects/a-rather-long-project-folder-name-${index}`,
      name: `project-${index}`,
    }));
    const encoded = encodePicks(many);
    expect(encoded.length).toBeLessThanOrEqual(2000);
    expect(decodePicks(encoded)[0]).toEqual(many[0]);
    expect(decodePicks("not json")).toEqual([]);
    expect(decodePicks(undefined)).toEqual([]);
    // The whole progress still decodes with it (each answer ≤ 2000).
    expect(() => decode(withPicks(EMPTY_SETUP_PROGRESS, "41", many))).not.toThrow();
  });
});

describe("the copy's rows", () => {
  const picks: PickedProject[] = [
    { path: "/Users/m/projects/landing", name: "landing" },
    { path: "/Users/m/code/api", name: "api" },
    { path: "/Users/m/Developer/ios-app", name: "ios-app" },
  ];
  const result = (path: string, name: string, patch: Record<string, unknown> = {}) => ({
    path,
    name,
    ok: true,
    keysSaved: 0,
    message: null,
    projectId: ProjectId.make(`p-${name}`),
    folder: `/home/uno/projects/${name}`,
    ...patch,
  });

  it("copying until its result is in, then ready or failed", () => {
    const bring: ComputerWorkBring = {
      state: "running",
      done: 2,
      total: 3,
      message: null,
      results: [
        result("/Users/m/projects/landing", "landing", { message: "1 of the chosen keys…" }),
        result("/Users/m/code/api", "api", {
          ok: false,
          message: "The project is 2380 MB packed",
          projectId: null,
          folder: null,
        }),
      ],
    };
    const rows = broughtRows({ picks, bring, known: [] });
    expect(rows.map((row) => row.state.kind)).toEqual(["ready", "failed", "copying"]);
    expect(rows[0]!.state).toMatchObject({
      projectId: "p-landing",
      folder: "/home/uno/projects/landing",
      note: "1 of the chosen keys…",
    });
    expect(rows[1]!.state).toEqual({ kind: "failed", message: "The project is 2380 MB packed" });
    // The first that hasn't failed is selected, even while it copies.
    expect(selectedRow(rows, null)?.name).toBe("landing");
    expect(selectedRow(rows, "/Users/m/Developer/ios-app")?.state.kind).toBe("copying");
  });

  it("copied but sync didn't turn on: still a project to open", () => {
    const rows = broughtRows({
      picks: picks.slice(0, 1),
      bring: {
        state: "done",
        done: 1,
        total: 1,
        message: null,
        results: [
          result("/Users/m/projects/landing", "landing", {
            ok: false,
            message: 'Copied, but "On all my computers" didn\'t turn on: offline',
          }),
        ],
      },
      known: [],
    });
    expect(rows[0]!.state.kind).toBe("ready");
  });

  it("an older daemon names no project: found by its folder name in ~/projects", () => {
    const rows = broughtRows({
      picks: picks.slice(0, 1),
      bring: {
        state: "done",
        done: 1,
        total: 1,
        message: null,
        results: [{ path: picks[0]!.path, name: "landing", ok: true, keysSaved: 0, message: null }],
      },
      known: [
        {
          id: ProjectId.make("p-9"),
          title: "landing",
          workspaceRoot: "/home/uno/projects/landing",
        },
      ],
    });
    expect(rows[0]!.state).toMatchObject({ kind: "ready", projectId: "p-9" });
  });

  it("nothing known about the copy (the cloud computer restarted): says so", () => {
    const rows = broughtRows({
      picks: picks.slice(1, 2),
      bring: { state: "idle", done: 0, total: 0, message: null, results: [] },
      known: [],
    });
    expect(rows[0]!.state.kind).toBe("failed");
    // Not asked yet: still on its way.
    expect(broughtRows({ picks, bring: undefined, known: [] })[0]!.state.kind).toBe("copying");
  });
});

describe("an imported project's AGENTS.md", () => {
  it("is kept: the answers go after it, replaced when written again", () => {
    const generated = "# AGENTS.md — api\n\n## About me\nI build APIs.\n";
    const own = "# API\n\nRun `make test` before every commit.\n";
    const first = appendAgentsMd(own, generated);
    expect(first.startsWith(own.trimEnd())).toBe(true);
    expect(first).toContain("## About me\nI build APIs.");
    expect(first).not.toContain("# AGENTS.md — api");
    const again = appendAgentsMd(first, "# AGENTS.md — api\n\n## About me\nI build tools.\n");
    expect(again).toContain("I build tools.");
    expect(again).not.toContain("I build APIs.");
    expect(again.match(/uno-setup:begin/g)).toHaveLength(1);
    expect(appendAgentsMd(null, generated)).toBe(generated);
  });
});
