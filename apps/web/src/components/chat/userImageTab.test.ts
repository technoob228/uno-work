import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { userImagePanelTab } from "./userImageTab";

const environmentId = EnvironmentId.make("env-1");

describe("userImagePanelTab", () => {
  it("opens the copy in ~/Uploads as a panel tab keyed by its path", () => {
    expect(
      userImagePanelTab(
        { name: "screen.png", savedPath: "/home/u/Uploads/2026-10/screen.png" },
        environmentId,
      ),
    ).toEqual({
      id: "/home/u/Uploads/2026-10/screen.png",
      name: "screen.png",
      kind: "image",
      content: "",
      path: "/home/u/Uploads/2026-10/screen.png",
      environmentId,
    });
  });

  it("keeps the full-screen viewer without a copy on the computer or for what the panel can't draw", () => {
    expect(userImagePanelTab({ name: "screen.png" }, environmentId)).toBeNull();
    expect(
      userImagePanelTab(
        { name: "photo.heic", savedPath: "/home/u/Uploads/2026-10/photo.heic" },
        environmentId,
      ),
    ).toBeNull();
  });
});
