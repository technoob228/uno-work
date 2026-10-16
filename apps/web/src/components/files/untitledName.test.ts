import { describe, expect, it } from "vitest";

import { untitledFileName } from "./untitledName";

describe("untitledFileName", () => {
  it("numbers an Untitled document from 1", () => {
    expect(untitledFileName("Untitled.docx", [])).toBe("Untitled 1.docx");
    expect(untitledFileName("Untitled.xlsx", ["notes.md", "Untitled 1.docx"])).toBe(
      "Untitled 1.xlsx",
    );
  });

  it("takes the first number not taken in the folder", () => {
    expect(untitledFileName("Untitled.docx", ["Untitled 1.docx", "Untitled 2.docx"])).toBe(
      "Untitled 3.docx",
    );
    expect(untitledFileName("Untitled.md", ["Untitled 1.md", "Untitled 3.md"])).toBe(
      "Untitled 2.md",
    );
    expect(untitledFileName("Untitled.pptx", ["untitled 1.PPTX"])).toBe("Untitled 2.pptx");
  });

  it("keeps another template's name while it is free", () => {
    expect(untitledFileName("index.html", ["Untitled 1.docx"])).toBe("index.html");
    expect(untitledFileName("index.html", ["index.html", "index 2.html"])).toBe("index 3.html");
  });
});
