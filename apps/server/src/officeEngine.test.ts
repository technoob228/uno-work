import * as nodePath from "node:path";
import { describe, expect, it } from "vitest";

import { resolveOfficeEngineFilePath } from "./officeEngine.ts";

const engineDir = nodePath.resolve("/srv/office-engine");

describe("resolveOfficeEngineFilePath", () => {
  it("maps engine asset paths inside the engine dir", () => {
    expect(
      resolveOfficeEngineFilePath({
        engineDir,
        requestPathname: "/office-engine/vendor/web-apps/apps/api/documents/api.js",
      }),
    ).toBe(nodePath.join(engineDir, "vendor/web-apps/apps/api/documents/api.js"));
  });

  it("decodes percent-encoded names", () => {
    expect(
      resolveOfficeEngineFilePath({
        engineDir,
        requestPathname: "/office-engine/fonts/My%20Font.ttf",
      }),
    ).toBe(nodePath.join(engineDir, "fonts/My Font.ttf"));
  });

  it("drops empty segments (the slide editor asks for themes//themes.js) but stays inside", () => {
    expect(
      resolveOfficeEngineFilePath({
        engineDir,
        requestPathname: "/office-engine/vendor/sdkjs/slide/themes//themes.js",
      }),
    ).toBe(nodePath.join(engineDir, "vendor/sdkjs/slide/themes/themes.js"));
    expect(
      resolveOfficeEngineFilePath({ engineDir, requestPathname: "/office-engine//etc/passwd" }),
    ).toBe(nodePath.join(engineDir, "etc/passwd"));
  });

  it.each([
    "/office-engine///",
    "/office-engine/vendor//../../etc",
    "/office-engine/../secret",
    "/office-engine/vendor/../../etc/passwd",
    "/office-engine/%2e%2e/etc/passwd",
    "/office-engine/vendor/%2e%2e%2f%2e%2e%2fetc",
    "/office-engine/a%00b",
    "/office-engine/a\\..\\b",
    "/office-engine/",
    "/office-enginex/api.js",
    "/office-engine/%E0%A4%A",
  ])("rejects %s", (requestPathname) => {
    expect(resolveOfficeEngineFilePath({ engineDir, requestPathname })).toBeNull();
  });
});
