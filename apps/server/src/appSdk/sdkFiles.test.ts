import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { renderBundle } from "../../scripts/embed-app-sdk.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("embedded App SDK", () => {
  it("matches packages/app-sdk and sdk/python (run apps/server/scripts/embed-app-sdk.ts)", () => {
    const expected = renderBundle((file) => readFileSync(path.join(root, file), "utf8"));
    const actual = readFileSync(
      path.join(root, "apps/server/src/appSdk/sdkBundle.generated.ts"),
      "utf8",
    );
    expect(actual).toBe(expected);
  });
});
