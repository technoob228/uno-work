import { type EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { computersMissingDefaultModel } from "./useDefaultModelMirror";

const terra = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-terra" };
const env = (id: string) => id as EnvironmentId;

describe("the Default model reaches each computer's server (13.11 v2)", () => {
  it("copies the app's choice to a computer that answers and has none", () => {
    expect(
      computersMissingDefaultModel(terra, [
        { environmentId: env("box"), connected: true, settings: { defaultModelSelection: null } },
        { environmentId: env("mac"), connected: true, settings: { defaultModelSelection: terra } },
        { environmentId: env("off"), connected: false, settings: { defaultModelSelection: null } },
        { environmentId: env("new"), connected: true, settings: null },
      ]),
    ).toEqual(["box"]);
  });

  it("does nothing on Auto", () => {
    expect(
      computersMissingDefaultModel(null, [
        { environmentId: env("box"), connected: true, settings: { defaultModelSelection: null } },
      ]),
    ).toEqual([]);
  });
});
