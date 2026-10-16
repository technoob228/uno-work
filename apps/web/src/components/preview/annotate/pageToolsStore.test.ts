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
