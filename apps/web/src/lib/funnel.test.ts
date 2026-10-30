import { describe, expect, it } from "vitest";

import { BRING_YOUR_OWN_FUNNEL, funnelBody } from "./funnel";

describe("funnelBody", () => {
  it("sends the Bring your own click in the shape the console accepts", () => {
    const body = funnelBody("connect_path", BRING_YOUR_OWN_FUNNEL);
    // back/internal/api/funnel.go: path from funnelPaths, props of strings.
    expect(body).toMatchObject({
      event: "connect_path",
      path: "ssh",
      props: { card: "bring_your_own", from: "add_machine" },
    });
    expect(["work", "work_lite", "desktop"]).toContain(body.surface);
  });
});
