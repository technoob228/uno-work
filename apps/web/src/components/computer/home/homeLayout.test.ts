import { describe, expect, it } from "vitest";

import {
  DEFAULT_HOME_LAYOUT,
  addableBlocks,
  appWidgetSandbox,
  appWidgetSpan,
  appWidgetUrl,
  customWidgetIdeas,
  homeLayoutReducer,
  isAppWidgetBlockId,
  migrateHomeLayout,
  normalizeHomeLayout,
} from "./homeLayout";

describe("migrateHomeLayout", () => {
  it("puts greeting, composer and Continue before the 0.0.81 widgets, keeping their order", () => {
    expect(migrateHomeLayout(null, ["apps", "ai-spend", "files"])).toEqual([
      "greeting",
      "composer",
      "continue",
      "apps",
      "ai-spend",
      "files",
    ]);
  });

  it("an empty 0.0.81 layout (all widgets removed) stays empty under the fixed blocks", () => {
    expect(migrateHomeLayout(undefined, [])).toEqual(["greeting", "composer", "continue"]);
  });

  it("prefers a saved 0.0.82 layout", () => {
    expect(migrateHomeLayout(["files", "composer"], ["apps"])).toEqual(["files", "composer"]);
  });

  it("gives the default with nothing saved", () => {
    expect(migrateHomeLayout(undefined, undefined)).toEqual([...DEFAULT_HOME_LAYOUT]);
    expect(DEFAULT_HOME_LAYOUT).toEqual(["greeting", "composer", "continue", "files", "apps"]);
  });
});

describe("normalizeHomeLayout", () => {
  it("drops unknown ids and repeats, keeps app widgets", () => {
    expect(
      normalizeHomeLayout(["composer", "bogus", "files", "files", "app:notes", "app:../x"]),
    ).toEqual(["composer", "files", "app:notes"]);
  });

  it("puts a lost composer back at the top, after a leading greeting", () => {
    expect(normalizeHomeLayout(["greeting", "files"])).toEqual(["greeting", "composer", "files"]);
    expect(normalizeHomeLayout(["files"])).toEqual(["composer", "files"]);
  });

  it("anything unreadable gives the default", () => {
    expect(normalizeHomeLayout("x")).toEqual([...DEFAULT_HOME_LAYOUT]);
  });
});

describe("homeLayoutReducer", () => {
  const state = ["greeting", "composer", "continue", "files"] as const;

  it("never removes the composer, removes anything else", () => {
    expect(homeLayoutReducer(state, { type: "remove", id: "composer" })).toEqual([...state]);
    expect(homeLayoutReducer(state, { type: "remove", id: "greeting" })).toEqual([
      "composer",
      "continue",
      "files",
    ]);
  });

  it("moves the composer like any block", () => {
    expect(homeLayoutReducer(state, { type: "move", from: "composer", to: "files" })).toEqual([
      "greeting",
      "continue",
      "files",
      "composer",
    ]);
  });

  it("adds once and resets to the default", () => {
    expect(homeLayoutReducer(state, { type: "add", id: "app:notes" })).toEqual([
      ...state,
      "app:notes",
    ]);
    expect(homeLayoutReducer(state, { type: "add", id: "files" })).toEqual([...state]);
    expect(homeLayoutReducer(state, { type: "reset" })).toEqual([...DEFAULT_HOME_LAYOUT]);
  });

  it("lists what can still be added", () => {
    expect(addableBlocks(state, ["greeting", "apps", "app:notes"])).toEqual(["apps", "app:notes"]);
  });
});

describe("app widgets", () => {
  it("recognises app widget ids", () => {
    expect(isAppWidgetBlockId("app:shop-orders")).toBe(true);
    expect(isAppWidgetBlockId("app:")).toBe(false);
    expect(isAppWidgetBlockId("app:Bad/Id")).toBe(false);
  });

  it("builds the frame address from the app's address and the widget path", () => {
    expect(appWidgetUrl("http://box.example:3000/", "/widget?compact=1")).toBe(
      "http://box.example:3000/widget?compact=1",
    );
    expect(appWidgetUrl("https://notes-box.app.uno4.dev/base/", "/w")).toBe(
      "https://notes-box.app.uno4.dev/base/w",
    );
    expect(appWidgetUrl("javascript:alert(1)", "/w")).toBeNull();
    expect(appWidgetUrl("http://x/", "//evil.example/w")).toBeNull();
    expect(appWidgetUrl("http://x/", "w")).toBeNull();
  });

  it("never gives the frame Work's origin", () => {
    expect(appWidgetSandbox("http://127.0.0.1:3000/w", "http://127.0.0.1:13841")).toContain(
      "allow-same-origin",
    );
    expect(appWidgetSandbox("http://127.0.0.1:13841/app/w", "http://127.0.0.1:13841")).toBe(
      "allow-scripts",
    );
    expect(appWidgetSandbox("http://x:1/w", "http://y")).not.toContain("allow-top-navigation");
  });

  it("maps sizes to columns", () => {
    expect([appWidgetSpan("small"), appWidgetSpan("medium"), appWidgetSpan("wide")]).toEqual([
      1, 2, 4,
    ]);
  });

  it("suggests widget ideas from the person's apps, then generic ones", () => {
    const ideas = customWidgetIdeas(["Shop", "Shop", "Notes", "Bot"]);
    expect(ideas).toHaveLength(3);
    expect(ideas[0]).toContain("Shop");
    expect(ideas[1]).toContain("Notes");
    expect(customWidgetIdeas([])).toHaveLength(3);
  });
});
