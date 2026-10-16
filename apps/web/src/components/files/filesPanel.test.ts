import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { activePanelFilePath, filesOpenTarget, filesPanelBeside } from "./filesPanel";

describe("filesPanelBeside", () => {
  it("is on while the panel is open with tabs on a wide screen", () => {
    expect(
      filesPanelBeside({ isMobile: false, panelOpen: true, panelTabCount: 2, inChat: false }),
    ).toBe(true);
  });

  it("is off with the panel closed, empty outside a chat, or on a phone", () => {
    expect(
      filesPanelBeside({ isMobile: false, panelOpen: false, panelTabCount: 2, inChat: false }),
    ).toBe(false);
    expect(
      filesPanelBeside({ isMobile: false, panelOpen: true, panelTabCount: 0, inChat: false }),
    ).toBe(false);
    expect(
      filesPanelBeside({ isMobile: true, panelOpen: true, panelTabCount: 2, inChat: false }),
    ).toBe(false);
  });
});

describe("filesOpenTarget", () => {
  it("opens in the panel when it is beside and can show the file", () => {
    expect(filesOpenTarget({ panelBeside: true, previewKind: "md", hasEnvironment: true })).toBe(
      "panel",
    );
  });

  it("stays in Files otherwise", () => {
    expect(filesOpenTarget({ panelBeside: false, previewKind: "md", hasEnvironment: true })).toBe(
      "files",
    );
    expect(
      filesOpenTarget({ panelBeside: true, previewKind: "unknown", hasEnvironment: true }),
    ).toBe("files");
    expect(filesOpenTarget({ panelBeside: true, previewKind: "md", hasEnvironment: false })).toBe(
      "files",
    );
  });
});

describe("activePanelFilePath", () => {
  const env = EnvironmentId.make("env-1");
  const other = EnvironmentId.make("env-2");
  const files = [
    { id: "b1" },
    { id: "/home/u/a.md", path: "/home/u/a.md", environmentId: env },
    { id: "/home/u/b.md", path: "/home/u/b.md", environmentId: other },
  ];

  it("is the active tab's file on this computer", () => {
    expect(activePanelFilePath(files, "/home/u/a.md", env)).toBe("/home/u/a.md");
  });

  it("is nothing for a browser tab or another computer's file", () => {
    expect(activePanelFilePath(files, "b1", env)).toBeUndefined();
    expect(activePanelFilePath(files, "/home/u/b.md", env)).toBeUndefined();
    expect(activePanelFilePath(files, "/home/u/a.md", null)).toBeUndefined();
  });
});
