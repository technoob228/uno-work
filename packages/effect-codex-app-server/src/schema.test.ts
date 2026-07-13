import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { assert, describe, it } from "@effect/vitest";

import * as CodexSchema from "./schema.ts";

describe("effect-codex-app-server schema", () => {
  // Upstream (openai/codex) changed ReasoningEffort from an enum to an open-ended
  // non-empty string; newer Codex CLIs advertise efforts like "max" that older
  // literal unions rejected and broke the provider probe.
  it("decodes model/list payloads with reasoning efforts beyond the legacy enum", () => {
    const payload = {
      data: [
        {
          id: "gpt-5.2-codex",
          model: "gpt-5.2-codex",
          displayName: "gpt-5.2-codex",
          description: "Latest codex model",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "max",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "" },
            { reasoningEffort: "xhigh", description: "" },
            { reasoningEffort: "max", description: "" },
          ],
        },
      ],
    };

    const result = Schema.decodeUnknownResult(CodexSchema.V2ModelListResponse)(payload);
    assert.isTrue(Result.isSuccess(result));
  });
});
