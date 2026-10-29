import { describe, expect, it } from "vitest";

import { capText, capToolResultBody } from "./capToolResult.ts";

describe("capToolResultBody", () => {
  it("cuts long text blocks with a note, leaves short ones", () => {
    const long = "x".repeat(10_000);
    const body = {
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: long }], structuredContent: { big: long } },
    };
    const capped = capToolResultBody(body, 4_000) as {
      result: { content: Array<{ text: string }>; structuredContent?: unknown };
    };
    expect(capped.result.content[0]!.text.length).toBeLessThan(4_100);
    expect(capped.result.content[0]!.text).toContain("[cut: ");
    expect(capped.result.structuredContent).toBeUndefined();
    const short = { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "ok" }] } };
    expect(capToolResultBody(short)).toBe(short);
    expect(capText("abc", 10)).toBe("abc");
  });
});
