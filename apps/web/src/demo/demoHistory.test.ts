import { describe, expect, it } from "vitest";

import { splitRouteHref } from "./demoHistory";

describe("the demo's route is the hash alone", () => {
  it("keeps the route's own query (a direct link to a setup screen)", () => {
    expect(splitRouteHref("/setup?step=start")).toEqual({
      href: "/setup?step=start",
      pathname: "/setup",
      search: "?step=start",
      hash: "",
    });
  });

  it("a bare path, a hash inside the route, no leading slash", () => {
    expect(splitRouteHref("/")).toMatchObject({ pathname: "/", search: "" });
    expect(splitRouteHref("/files?path=a#top")).toMatchObject({
      pathname: "/files",
      search: "?path=a",
      hash: "#top",
    });
    expect(splitRouteHref("computer")).toMatchObject({ pathname: "/computer", search: "" });
  });
});
