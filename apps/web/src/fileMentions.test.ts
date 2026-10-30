import { describe, expect, it } from "vitest";

import { fileMentionInCode, fileMentionInHref, fileMentionsInText } from "./fileMentions";

const inText = (text: string) => fileMentionsInText(text).map((mention) => mention.path);

describe("fileMentionInCode", () => {
  it.each([
    ["~/UnoWork/reports/report.md", true],
    ["/home/uno/projects/x/index.html", true],
    ["/Users/mikhail/uno-project/CLAUDE.md", true],
    ["reports/foo.md", true],
    ["web/index.html", true],
    ["./notes.txt", true],
    ["../shared/util.ts", true],
    ["index.html", false],
    [".env", false],
    [".env.local", false],
    [".gitignore", false],
    ["Dockerfile", false],
    ["Makefile", false],
    ["README", false],
    ["~/.ssh/config", false],
    ["web/", false],
    ["~/uno-project/", false],
  ])("takes %s", (code, strong) => {
    expect(fileMentionInCode(code)).toMatchObject({ path: code, strong });
  });

  it("doesn't take spaces in a path that starts nowhere", () => {
    expect(fileMentionInCode("docs/My Folder")).toBeNull();
  });

  it("keeps a path with spaces when it starts somewhere", () => {
    expect(fileMentionInCode("~/UnoWork/Мои отчёты/итог за год.md")).toMatchObject({
      path: "~/UnoWork/Мои отчёты/итог за год.md",
      strong: true,
    });
  });

  it("takes names of any script", () => {
    expect(fileMentionInCode("отчёты/квартал.md")?.path).toBe("отчёты/квартал.md");
    expect(fileMentionInCode("отчёт.docx")?.path).toBe("отчёт.docx");
  });

  it("splits line and column off", () => {
    expect(fileMentionInCode("src/app.ts:12:3")).toMatchObject({
      path: "src/app.ts",
      line: 12,
      column: 3,
    });
    expect(fileMentionInCode("src/app.ts#L40")).toMatchObject({ path: "src/app.ts", line: 40 });
    expect(fileMentionInCode("app.py:7")).toMatchObject({ path: "app.py", line: 7 });
  });

  it("takes file links", () => {
    expect(fileMentionInCode("file:///home/uno/a%20b.md")?.path).toBe("/home/uno/a b.md");
  });

  it("takes framework route folders", () => {
    expect(fileMentionInCode("app/[id]/(auth)/page.tsx")?.path).toBe("app/[id]/(auth)/page.tsx");
  });

  it.each([
    "https://example.com/report.md",
    "http://185.130.227.16:30017",
    "ftp://x.org/a.txt",
    "mailto:hello@getuno.xyz",
    "example.com",
    "console.uno4.dev/v1",
    "ecorouter.org",
    "github.com/foo/bar.md",
    "localhost:3000",
    "localhost/health",
    "127.0.0.1:8080/x",
    "10.0.0.1",
    "1.2.3",
    "v1.2.3",
    "3.12",
    "1.2.3-beta.1",
    "24/7",
    "10/03/2026",
    "cat reports/foo.md",
    "npm test",
    "go vet ./...",
    "git checkout main",
    "/usr/bin/env -S foo",
    "web/*.html",
    "users/95/buckets/<имя>/",
    "$HOME/report.md",
    "~/.claude/projects/...",
    "~/uno-billing/…",
    "FOO=bar",
    "a && b.txt",
    "@t3tools/contracts",
    "useEffect",
    "main",
    "~",
    "/",
    "..",
  ])("leaves %s", (code) => {
    expect(fileMentionInCode(code)).toBeNull();
  });

  it("is not sure of API routes and leaves them to the computer", () => {
    expect(fileMentionInCode("/api/v1/openapi.yaml")).toMatchObject({ strong: false });
    expect(fileMentionInCode("/v1/stats")).toMatchObject({ strong: false });
    expect(fileMentionInCode("and/or")).toMatchObject({ strong: false });
  });
});

describe("fileMentionsInText", () => {
  it("finds every kind of path in a sentence", () => {
    expect(
      inText(
        "Сделал отчёт: ~/UnoWork/report.md, страница /home/uno/projects/x/index.html и reports/foo.md (см. также ./a/b.txt).",
      ),
    ).toEqual([
      "~/UnoWork/report.md",
      "/home/uno/projects/x/index.html",
      "reports/foo.md",
      "./a/b.txt",
    ]);
  });

  it("finds a bare name of a known type", () => {
    expect(inText("Открой index.html и CLAUDE.md, потом Sidebar.tsx.")).toEqual([
      "index.html",
      "CLAUDE.md",
      "Sidebar.tsx",
    ]);
  });

  it("reports where the mention sits, without the punctuation around it", () => {
    const text = "see (reports/foo.md), done";
    const [mention] = fileMentionsInText(text);
    expect(mention).toMatchObject({ text: "reports/foo.md", start: 5, end: 19 });
    expect(text.slice(mention!.start, mention!.end)).toBe("reports/foo.md");
  });

  it("keeps the line and the whole token in place", () => {
    expect(fileMentionsInText("error in src/app.ts:12:3.")[0]).toMatchObject({
      path: "src/app.ts",
      line: 12,
      column: 3,
      text: "src/app.ts:12:3",
    });
  });

  it.each([
    "and/or",
    "client/server",
    "CLI/API",
    "$5/мес",
    "24/7",
    "10/03/2026",
    "version 1.2.3",
    "v2.0",
    "e.g. this",
    "i.e. that",
    "example.com",
    "visit https://example.com/report.md now",
    "ecorouter.org",
    "uno.place",
    "the /chat page",
    "/docs",
    "2.5GB",
    "done.Next sentence",
    "Fish",
    "...",
    "a/b/c",
  ])("leaves %s", (text) => {
    expect(inText(text)).toEqual([]);
  });

  it("asks about names that only look like files; the computer says no", () => {
    expect(inText("Написано на Node.js")).toEqual(["Node.js"]);
    expect(fileMentionsInText("Node.js")[0]?.strong).toBe(false);
  });
});

describe("fileMentionInHref", () => {
  it("treats a link's address as sure", () => {
    expect(fileMentionInHref("fishcode/docs/api/proxy-api.md")).toMatchObject({
      path: "fishcode/docs/api/proxy-api.md",
      strong: true,
    });
    expect(fileMentionInHref("/Users/mikhail/x/app.ts:57")).toMatchObject({
      path: "/Users/mikhail/x/app.ts",
      line: 57,
    });
    expect(fileMentionInHref("/home/uno/a.go#L1678")).toMatchObject({ line: 1678 });
  });

  it("decodes the address", () => {
    expect(fileMentionInHref("reports/my%20file.md")?.path).toBe("reports/my file.md");
  });

  it("leaves web links", () => {
    expect(fileMentionInHref("https://uno.place/developers")).toBeNull();
    expect(fileMentionInHref("console.uno.place/docs")).toBeNull();
  });
});
