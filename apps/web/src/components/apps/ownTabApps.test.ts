import { describe, expect, it } from "vitest";

import { OWN_TAB_TTL_MS, isOwnTabApp, parseOwnTabApps, withOwnTabVerdict } from "./ownTabApps";

const VPN = "https://vpn-box.app.uno4.dev/";
const NOW = 1_800_000_000_000;

describe("apps that open in their own tab", () => {
  it("remembers an app that refused to be shown, by origin", () => {
    const record = withOwnTabVerdict({}, VPN, true, NOW);
    expect(record).toEqual({ "https://vpn-box.app.uno4.dev": NOW });
    expect(isOwnTabApp(record, "https://vpn-box.app.uno4.dev/clients?x=1", NOW + 1000)).toBe(true);
    expect(isOwnTabApp(record, "https://other.app.uno4.dev/", NOW)).toBe(false);
  });

  it("forgets it once the app can be shown, and after a month", () => {
    const record = withOwnTabVerdict({}, VPN, true, NOW);
    expect(withOwnTabVerdict(record, VPN, false, NOW + 5)).toEqual({});
    expect(isOwnTabApp(record, VPN, NOW + OWN_TAB_TTL_MS)).toBe(false);
    // An expired entry is dropped when anything else is written.
    expect(withOwnTabVerdict(record, "https://b.example/", true, NOW + OWN_TAB_TTL_MS)).toEqual({
      "https://b.example": NOW + OWN_TAB_TTL_MS,
    });
  });

  it("reads junk as nothing and ignores what is not an address", () => {
    expect(parseOwnTabApps(null)).toEqual({});
    expect(parseOwnTabApps("not json")).toEqual({});
    expect(parseOwnTabApps('["a"]')).toEqual({});
    expect(parseOwnTabApps('{"https://a.example":"soon","https://b.example":5}')).toEqual({
      "https://b.example": 5,
    });
    expect(withOwnTabVerdict({}, "localhost", true, NOW)).toEqual({});
    expect(isOwnTabApp({}, "nope", NOW)).toBe(false);
  });
});
