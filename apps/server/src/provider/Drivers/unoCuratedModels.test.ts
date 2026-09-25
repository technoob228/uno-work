import { describe, expect, it } from "vitest";

import { formatUnderlyingModel, resolveUnoDefaultSlug } from "./unoCuratedModels.ts";

const none = () => false;

describe("unoCuratedModels", () => {
  it("formats the real model behind Smart / Fast", () => {
    expect(formatUnderlyingModel("xiaomi/mimo-v2.6-pro")).toBe("MiMo-V2.6-Pro");
    expect(formatUnderlyingModel("deepseek/deepseek-v4.1-flash")).toBe("DeepSeek V4.1 Flash");
    expect(formatUnderlyingModel("MiMo-V2.6-Pro")).toBe("MiMo-V2.6-Pro");
    expect(formatUnderlyingModel("acme/super-v3-mini")).toBe("Super V3 Mini");
    expect(formatUnderlyingModel(undefined)).toBeUndefined();
    expect(formatUnderlyingModel(" ")).toBeUndefined();
  });

  it("falls back to the pre-hours defaults on a gateway without Smart / Fast", () => {
    expect(resolveUnoDefaultSlug("uno/uno/smart", none)).toBe("uno/moonshotai/kimi-k2.7-code");
    expect(resolveUnoDefaultSlug("uno/uno/fast", none)).toBe(
      "uno/~deepseek/deepseek-v4-flash-latest",
    );
    expect(resolveUnoDefaultSlug("uno/uno/fast", () => true)).toBe("uno/uno/fast");
    expect(resolveUnoDefaultSlug("uno/x/y", none)).toBe("uno/x/y");
  });
});
