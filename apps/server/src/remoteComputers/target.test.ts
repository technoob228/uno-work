import { describe, expect, it } from "vitest";

import { pairingTargetFromUrl, resolveComputerRef } from "./target.ts";

const boxes = [
  { id: 2531, name: "stage-work", status: "running" },
  { id: 2507, name: "uno-product", status: "sleeping" },
  { id: 395, name: "Uno Work", status: "running" },
];

describe("resolveComputerRef", () => {
  it("absent, words and this computer's own id or name are this computer", () => {
    for (const raw of [undefined, null, "", "this", " Local ", 395, "395", "box-395", "uno work"]) {
      expect(resolveComputerRef(raw, { boxes, ownBoxId: 395 }), String(raw)).toEqual({
        kind: "this",
      });
    }
  });

  it("finds another computer by id, box-N or name", () => {
    for (const raw of [2531, "2531", "box-2531", "BOX2531", "Stage-Work", "  stage-work "]) {
      const ref = resolveComputerRef(raw, { boxes, ownBoxId: 395 });
      expect(ref, String(raw)).toEqual({ kind: "box", box: boxes[0] });
    }
  });

  it("an unknown computer names the ones that exist", () => {
    const ref = resolveComputerRef("laptop", { boxes, ownBoxId: 395 });
    expect(ref.kind).toBe("unknown");
    if (ref.kind === "unknown") {
      expect(ref.message).toContain("stage-work (box-2531)");
      expect(ref.message).not.toContain("box-395");
    }
    expect(resolveComputerRef(9999, { boxes, ownBoxId: 395 }).kind).toBe("unknown");
  });

  it("two computers with one name need the id", () => {
    const ref = resolveComputerRef("twin", {
      boxes: [
        { id: 1, name: "twin", status: "running" },
        { id: 2, name: "twin", status: "running" },
      ],
      ownBoxId: null,
    });
    expect(ref.kind).toBe("unknown");
    if (ref.kind === "unknown") expect(ref.message).toContain("box-1, box-2");
  });
});

describe("pairingTargetFromUrl", () => {
  it("reads the console's link like the web app does", () => {
    expect(pairingTargetFromUrl("https://box-1.app.uno4.dev/pair#token=abc")).toEqual({
      httpBaseUrl: "https://box-1.app.uno4.dev/",
      credential: "abc",
    });
    expect(pairingTargetFromUrl("https://box-1.app.uno4.dev/pair?token=q")?.credential).toBe("q");
    expect(
      pairingTargetFromUrl(
        "https://app.uno4.work/pair?host=https%3A%2F%2Fb.example%3A8443#token=t",
      ),
    ).toEqual({ httpBaseUrl: "https://b.example:8443/", credential: "t" });
  });

  it("no token or not http(s): nothing", () => {
    expect(pairingTargetFromUrl("https://box/pair")).toBeNull();
    expect(pairingTargetFromUrl("ftp://box/pair#token=x")).toBeNull();
    expect(pairingTargetFromUrl("not a url")).toBeNull();
  });
});
