import { describe, expect, it } from "vitest";

import { formatWorkspaceRelativePath } from "./filePathDisplay";

describe("formatWorkspaceRelativePath", () => {
  it("spells a home path outside the workspace from ~, like Files does", () => {
    expect(formatWorkspaceRelativePath("/home/unowork/projects/hello/index.html", undefined)).toBe(
      "~/projects/hello/index.html",
    );
    expect(
      formatWorkspaceRelativePath("/Users/mike/notes/todo.md:12", "/Users/mike/dev/t3code"),
    ).toBe("~/notes/todo.md:12");
    expect(formatWorkspaceRelativePath("~/projects/hello/index.html", undefined)).toBe(
      "~/projects/hello/index.html",
    );
    expect(formatWorkspaceRelativePath("/etc/caddy/Caddyfile", undefined)).toBe(
      "/etc/caddy/Caddyfile",
    );
  });

  it("keeps a home path inside the workspace relative to the workspace", () => {
    expect(
      formatWorkspaceRelativePath(
        "/home/unowork/projects/site/index.html",
        "/home/unowork/projects/site",
      ),
    ).toBe("site/index.html");
  });

  it("formats absolute workspace paths from the workspace root", () => {
    expect(
      formatWorkspaceRelativePath(
        "C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501");
  });

  it("prefixes relative paths with the workspace root label", () => {
    expect(
      formatWorkspaceRelativePath(
        "apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501");
  });

  it("keeps paths already rooted at the workspace label stable", () => {
    expect(
      formatWorkspaceRelativePath(
        "t3code/apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501");
  });

  it("preserves columns when present", () => {
    expect(
      formatWorkspaceRelativePath(
        "/C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts:501:9",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toBe("t3code/apps/web/src/session-logic.ts:501:9");
  });
});
