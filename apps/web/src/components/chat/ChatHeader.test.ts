import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { shouldShowOpenInPicker, shouldShowRunsOn } from "./ChatHeader";

describe("shouldShowOpenInPicker", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows the picker for projects in the primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(true);
  });

  it("hides the picker when hosted static mode has no primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId: null,
      }),
    ).toBe(false);
  });

  it("hides the picker for remote environments", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });

  it("hides the picker when there is no active project", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });
});

describe("shouldShowRunsOn", () => {
  it("shows what a running chat runs on", () => {
    expect(shouldShowRunsOn({ runsOn: "claude-plan", isDraft: false, isMobile: false })).toBe(true);
    expect(shouldShowRunsOn({ runsOn: "uno-ai", isDraft: false, isMobile: false })).toBe(true);
  });

  it("says nothing when the daemon can't tell", () => {
    expect(shouldShowRunsOn({ runsOn: null, isDraft: false, isMobile: false })).toBe(false);
    expect(shouldShowRunsOn({ runsOn: undefined, isDraft: false, isMobile: false })).toBe(false);
  });

  it("stays out of a new chat (its picker is below) and of a phone's header", () => {
    expect(shouldShowRunsOn({ runsOn: "uno-ai", isDraft: true, isMobile: false })).toBe(false);
    expect(shouldShowRunsOn({ runsOn: "uno-ai", isDraft: false, isMobile: true })).toBe(false);
  });
});
