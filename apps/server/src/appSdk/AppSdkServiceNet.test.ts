import { describe, expect, it } from "vitest";

import { parseIpAddrShow } from "./AppSdkService.ts";

describe("parseIpAddrShow", () => {
  it("reads the docker bridge address even when the bridge is down", () => {
    expect(
      parseIpAddrShow(
        "4: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\\       valid_lft forever preferred_lft forever\n",
      ),
    ).toBe("172.17.0.1");
    expect(parseIpAddrShow("")).toBeNull();
  });
});
