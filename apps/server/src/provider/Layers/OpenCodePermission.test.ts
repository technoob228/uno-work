import { describe, expect, it } from "vitest";

import { describeOpenCodePermission, mapPermissionToRequestType } from "./OpenCodeAdapter.ts";

describe("OpenCode permission requests", () => {
  it("maps the file and shell permissions to their approval kinds", () => {
    expect(mapPermissionToRequestType("bash")).toBe("command_execution_approval");
    expect(mapPermissionToRequestType("read")).toBe("file_read_approval");
    expect(mapPermissionToRequestType("glob")).toBe("file_read_approval");
    expect(mapPermissionToRequestType("edit")).toBe("file_change_approval");
    expect(mapPermissionToRequestType("write")).toBe("file_change_approval");
  });

  it("keeps other permissions as unknown but names them for the person", () => {
    expect(mapPermissionToRequestType("external_directory")).toBe("unknown");
    expect(describeOpenCodePermission("external_directory", ["/home/unowork/bakery/*"])).toBe(
      "Outside the project folder: /home/unowork/bakery/*",
    );
    expect(describeOpenCodePermission("webfetch", ["*"])).toBe("Open a web page");
    expect(describeOpenCodePermission("some_new_tool", [])).toBe("some_new_tool");
  });

  it("shows the command or path itself for the known kinds", () => {
    expect(describeOpenCodePermission("bash", ["echo hi > hi.txt"])).toBe("echo hi > hi.txt");
    expect(describeOpenCodePermission("edit", [])).toBe("edit");
  });
});
