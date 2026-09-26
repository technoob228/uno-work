import { describe, expect, it } from "vitest";

import { EMPTY_SETUP_PROGRESS, setupSidebarState } from "./setupModel";
import {
  GOALS,
  GOAL_COPY,
  NEXT_STEP,
  detectBuiltOwn,
  detectFirstResult,
  goalAgentsMd,
  goalAsksHow,
  goalFirstPrompt,
  goalState,
  hasIndexHtml,
  impliedConnectPath,
  parseConnectPath,
  parseGoal,
  siteSlugFrom,
  stripSharedTopFolder,
  withAnswer,
  withGoal,
} from "./goals";

describe("goal-first start", () => {
  it("has five goals, each with copy and one next step", () => {
    expect(GOALS).toEqual(["assistant", "site", "bot", "own_agent", "server"]);
    for (const goal of GOALS) {
      expect(GOAL_COPY[goal].title.length).toBeGreaterThan(0);
      expect(NEXT_STEP[goal].title.length).toBeGreaterThan(0);
    }
  });

  it("asks how you work only for goals Uno builds", () => {
    expect(GOALS.filter(goalAsksHow)).toEqual(["assistant", "site", "bot"]);
    expect(impliedConnectPath("own_agent")).toBe("own_agent");
    expect(impliedConnectPath("server")).toBe("ssh");
    expect(impliedConnectPath("site")).toBeNull();
  });

  it("parses route values strictly", () => {
    expect(parseGoal("site")).toBe("site");
    expect(parseGoal("wordpress")).toBeNull();
    expect(parseConnectPath("uno_ai")).toBe("uno_ai");
    expect(parseConnectPath(1)).toBeNull();
  });

  it("picking a goal finishes onboarding and hides the Set up row", () => {
    const next = withGoal(EMPTY_SETUP_PROGRESS, "bot");
    expect(next.finished).toBe(true);
    expect(setupSidebarState(next).hidden).toBe(true);
    const state = goalState(next);
    expect(state.goal).toBe("bot");
    expect(state.goalAt).not.toBeNull();
    // the clock starts at the first pick only
    const again = withGoal(next, "site");
    expect(again.answers["goal_at"]).toBe(next.answers["goal_at"]);
  });

  it("never mentions skills or project names in first-run copy", () => {
    const copy = GOALS.map((goal) => `${GOAL_COPY[goal].title} ${GOAL_COPY[goal].sub}`).join(" ");
    expect(copy.toLowerCase()).not.toMatch(/skill|project|wordpress/);
  });

  it("writes goal prompts that keep secrets out of chat", () => {
    expect(goalFirstPrompt("bot", { description: "take orders" })).toContain(".env");
    expect(goalFirstPrompt("site", { description: "yoga" })).toContain("send me the link");
    expect(goalFirstPrompt("bot", { description: "take orders." })).toContain("take orders. The bot");
    expect(goalAgentsMd("site", "My website")).toContain("ONE concrete next step");
  });

  it("strips the shared top folder of a zip or a folder, drops junk", () => {
    const files = [
      { relativePath: "shop/index.html" },
      { relativePath: "shop/css/a.css" },
      { relativePath: "__MACOSX/shop/._index.html" },
    ];
    const out = stripSharedTopFolder(files, (file, relativePath) => ({ ...file, relativePath }));
    expect(out.map((file) => file.relativePath)).toEqual(["index.html", "css/a.css"]);
    expect(hasIndexHtml(out)).toBe(true);
    const flat = [{ relativePath: "index.html" }, { relativePath: "a.css" }];
    expect(stripSharedTopFolder(flat, (f) => f)).toEqual(flat);
  });

  it("makes a site name from the folder", () => {
    expect(siteSlugFrom("My Shop.zip")).toMatch(/^my-shop-[a-z0-9]{1,4}$/);
    expect(siteSlugFrom("???").startsWith("site-")).toBe(true);
    expect(siteSlugFrom("a".repeat(80)).length).toBeLessThanOrEqual(30);
  });

  it("detects the first result: a site published after the pick, a bot running from its folder", () => {
    const picked = withGoal(EMPTY_SETUP_PROGRESS, "site");
    const at = Date.parse(goalState(picked).goalAt!);
    const before = new Date(at - 60_000).toISOString();
    const after = new Date(at + 60_000).toISOString();
    expect(
      detectFirstResult(goalState(picked), { sites: [{ updatedAt: before }], apps: [] }),
    ).toBeNull();
    expect(detectFirstResult(goalState(picked), { sites: [{ updatedAt: after }], apps: [] })).toBe(
      "chat",
    );

    const bot = withAnswer(
      withGoal(EMPTY_SETUP_PROGRESS, "bot"),
      "goal_project",
      "/home/u/telegram-bot",
    );
    expect(
      detectFirstResult(goalState(bot), {
        sites: [],
        apps: [{ codeDir: "/home/u/telegram-bot", status: "stopped" }],
      }),
    ).toBeNull();
    expect(
      detectFirstResult(goalState(bot), {
        sites: [],
        apps: [{ codeDir: "/home/u/telegram-bot/src", status: "running" }],
      }),
    ).toBe("app");
    const done = withAnswer(bot, "first_result_at", after);
    expect(
      detectFirstResult(goalState(done), {
        sites: [],
        apps: [{ codeDir: "/home/u/telegram-bot", status: "running" }],
      }),
    ).toBeNull();
  });

  it("built-own = a later chat (not the assistant) that finished a turn", () => {
    const first = "2026-09-25T10:00:00.000Z";
    const state = goalState(
      withAnswer(withGoal(EMPTY_SETUP_PROGRESS, "site"), "first_result_at", first),
    );
    expect(
      detectBuiltOwn(state, [
        { createdAt: "2026-09-25T09:00:00.000Z", completedAt: "x", isAssistant: false },
        { createdAt: "2026-09-25T11:00:00.000Z", completedAt: "x", isAssistant: true },
        { createdAt: "2026-09-25T11:00:00.000Z", completedAt: null, isAssistant: false },
      ]),
    ).toBe(false);
    expect(
      detectBuiltOwn(state, [
        { createdAt: "2026-09-25T11:00:00.000Z", completedAt: "x", isAssistant: false },
      ]),
    ).toBe(true);
  });
});
