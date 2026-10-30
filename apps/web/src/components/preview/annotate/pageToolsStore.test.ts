import { beforeEach, describe, expect, it } from "vitest";

import type { PagePick } from "./pageToolsScript";
import { usePageToolsStore } from "./pageToolsStore";

const pick = (): PagePick => ({
  kind: "element",
  selector: "h1",
  label: "h1",
  text: "Hello",
  rect: { x: 1, y: 2, w: 3, h: 4 },
  docRect: { x: 1, y: 2, w: 3, h: 4 },
});

describe("a comment's picture", () => {
  beforeEach(() => usePageToolsStore.setState({ tabs: {} }));

  it("lands on the note being written and stays with the comment", () => {
    const store = usePageToolsStore.getState();
    const picked = pick();
    store.patch("t", { draft: { kind: "new", pick: picked } });
    const shot = new Blob(["png"], { type: "image/png" });
    store.setShot("t", picked, shot);
    store.saveDraft("t", "Bigger");
    expect(usePageToolsStore.getState().tabs.t?.comments[0]?.shot).toBe(shot);
  });

  it("finds the comment when the picture comes after it was saved", () => {
    const store = usePageToolsStore.getState();
    const picked = pick();
    store.patch("t", { draft: { kind: "new", pick: picked } });
    store.saveDraft("t", "Bigger");
    const shot = new Blob(["png"], { type: "image/png" });
    store.setShot("t", picked, shot);
    expect(usePageToolsStore.getState().tabs.t?.comments[0]?.shot).toBe(shot);
    // Another pick's picture doesn't land anywhere.
    store.setShot("t", pick(), new Blob(["x"]));
    expect(usePageToolsStore.getState().tabs.t?.comments[0]?.shot).toBe(shot);
  });
});

describe("developer tools of a tab (Misha 28.10)", () => {
  beforeEach(() => usePageToolsStore.setState({ tabs: {} }));
  const tab = () => usePageToolsStore.getState().tabs.t;

  it("are off on a new page: no Comment, nothing of the page's errors on view", () => {
    const store = usePageToolsStore.getState();
    store.addConsole("t", {
      id: "1",
      level: "error",
      message: "boom",
      stack: null,
      source: null,
      at: 0,
    });
    expect(tab()?.devtools).toBe(false);
    expect(tab()?.commenting).toBe(false);
  });

  it("Comment (or C) opens them; Esc ends Comment and leaves them open", () => {
    const store = usePageToolsStore.getState();
    store.toggleMode("t");
    expect(tab()).toMatchObject({ devtools: true, commenting: true });
    expect(store.escape("t")).toBe(true);
    expect(tab()).toMatchObject({ devtools: true, commenting: false });
    // Nothing left for Esc: the page gets it.
    expect(store.escape("t")).toBe(false);
  });

  it("closing them ends Comment too, the notes written stay", () => {
    const store = usePageToolsStore.getState();
    store.toggleDevtools("t");
    expect(tab()).toMatchObject({ devtools: true, commenting: false });
    store.toggleMode("t");
    store.patch("t", { draft: { kind: "new", pick: pick() } });
    store.saveDraft("t", "Bigger");
    store.toggleDevtools("t");
    expect(tab()).toMatchObject({
      devtools: false,
      commenting: false,
      draft: null,
    });
    expect(tab()?.comments).toHaveLength(1);
  });
});

describe("text selected on the page", () => {
  it("is gone with the document", () => {
    const store = usePageToolsStore.getState();
    const selection = { text: "Price", url: "https://a.test/", rect: { x: 1, y: 2, w: 3, h: 4 } };
    store.patch("selected-tab", { selection });
    expect(usePageToolsStore.getState().tabs["selected-tab"]?.selection).toEqual(selection);
    store.resetLogs("selected-tab");
    expect(usePageToolsStore.getState().tabs["selected-tab"]?.selection).toBeNull();
  });
});
