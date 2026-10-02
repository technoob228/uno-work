import type { UnoMachineApp } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { openOutsideTarget } from "./openOutsideTarget";

function app(patch: Partial<UnoMachineApp> = {}): UnoMachineApp {
  return {
    id: "manifest:orders",
    source: "manifest",
    name: "Orders",
    description: null,
    icon: null,
    iconImage: null,
    status: "running",
    port: 8087,
    udpPorts: [],
    http: true,
    loopbackOnly: false,
    detail: null,
    url: null,
    localUrl: "http://localhost:8087/",
    publication: null,
    canStart: false,
    canStop: true,
    ...patch,
  };
}

describe("openOutsideTarget", () => {
  it("opens a page on the internet as is", () => {
    expect(openOutsideTarget("https://example.com/a?b=1", [])).toEqual({
      kind: "open",
      url: "https://example.com/a?b=1",
    });
  });

  it("opens an app's public address, same page, instead of localhost", () => {
    const shown = app({
      publication: { url: "http://203.0.113.5:31080/", forwards: [] } as never,
    });
    expect(openOutsideTarget("http://localhost:8087/orders?day=1", [shown])).toEqual({
      kind: "open",
      url: "http://203.0.113.5:31080/orders?day=1",
    });
  });

  it("offers Show on the internet for an app that answers only inside", () => {
    expect(openOutsideTarget("http://localhost:8087/", [app()])).toEqual({
      kind: "publish",
      appId: "manifest:orders",
      name: "Orders",
    });
  });

  it("explains why a localhost page can't leave the computer", () => {
    expect(openOutsideTarget("http://127.0.0.1:9999/", [app()]).kind).toBe("none");
    expect(
      openOutsideTarget("http://localhost:8087/", [app({ loopbackOnly: true })]),
    ).toMatchObject({ kind: "none" });
    expect(openOutsideTarget("http://localhost:8087/", [app()], "Not an Uno computer")).toEqual({
      kind: "none",
      reason: "Not an Uno computer",
    });
    expect(openOutsideTarget("about:blank", []).kind).toBe("none");
  });
});
