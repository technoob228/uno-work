import { describe, expect, it } from "vitest";

import { shikiLanguageForFileName } from "./codeHighlighter";

describe("shikiLanguageForFileName", () => {
  it("passes common extensions through as-is", () => {
    expect(shikiLanguageForFileName("index.ts")).toBe("ts");
    expect(shikiLanguageForFileName("App.tsx")).toBe("tsx");
    expect(shikiLanguageForFileName("main.go")).toBe("go");
    expect(shikiLanguageForFileName("script.py")).toBe("py");
    expect(shikiLanguageForFileName("style.scss")).toBe("scss");
  });

  it("maps extensions whose language id differs", () => {
    expect(shikiLanguageForFileName("header.h")).toBe("c");
    expect(shikiLanguageForFileName("impl.hpp")).toBe("cpp");
    expect(shikiLanguageForFileName("config.yml")).toBe("yaml");
    expect(shikiLanguageForFileName("module.mjs")).toBe("js");
    expect(shikiLanguageForFileName("icon.svg")).toBe("xml");
    expect(shikiLanguageForFileName("schema.gql")).toBe("graphql");
  });

  it("recognises special filenames without extension", () => {
    expect(shikiLanguageForFileName("Dockerfile")).toBe("docker");
    expect(shikiLanguageForFileName("Makefile")).toBe("make");
    expect(shikiLanguageForFileName(".gitignore")).toBe("ini");
    expect(shikiLanguageForFileName(".env")).toBe("ini");
    expect(shikiLanguageForFileName(".env.local")).toBe("ini");
  });

  it("treats plain text formats and unknowns as text", () => {
    expect(shikiLanguageForFileName("notes.txt")).toBe("text");
    expect(shikiLanguageForFileName("server.log")).toBe("text");
    expect(shikiLanguageForFileName("noextension")).toBe("text");
    expect(shikiLanguageForFileName("")).toBe("text");
  });

  it("uses only the basename of a path", () => {
    expect(shikiLanguageForFileName("/a/b/main.rs")).toBe("rs");
    expect(shikiLanguageForFileName("C:\\dir\\Dockerfile")).toBe("docker");
  });
});
