import { afterEach, describe, expect, it } from "vitest";

import {
  currentWorkAddress,
  isNewWorkHost,
  preferWorkHost,
  rememberWorkHost,
  resetWorkAddressForTests,
  workAppLink,
  workHostOf,
} from "./workAddress.ts";

afterEach(() => resetWorkAddressForTests());

describe("the person's Uno Work address (P16)", () => {
  it("reads the account's own address or the shared one from the forwarded host", () => {
    expect(workHostOf({ "x-forwarded-host": "3csvnrcm77.uno4.work" })).toBe("3csvnrcm77.uno4.work");
    expect(workHostOf({ "x-forwarded-host": "App.Uno4.Work:443" })).toBe("app.uno4.work");
    expect(workHostOf({ host: "3csvnrcm77.uno4.work" })).toBe("3csvnrcm77.uno4.work");
  });

  it("ignores anything that isn't a Work address", () => {
    expect(workHostOf({ host: "127.0.0.1:80" })).toBeNull();
    // A port's address is the program's, not Work's.
    expect(workHostOf({ "x-forwarded-host": "p8471--3csvnrcm77.uno4.work" })).toBeNull();
    expect(workHostOf({ "x-forwarded-host": "evil.example" })).toBeNull();
    expect(workHostOf({ "x-forwarded-host": "3csvnrcm77.uno4.work.evil.example" })).toBeNull();
    expect(workHostOf({})).toBeNull();
  });

  it("prefers the account's own address over the shared one", () => {
    expect(preferWorkHost(null, "app.uno4.work")).toBe(true);
    expect(preferWorkHost("app.uno4.work", "3csvnrcm77.uno4.work")).toBe(true);
    expect(preferWorkHost("3csvnrcm77.uno4.work", "app.uno4.work")).toBe(false);
    expect(preferWorkHost("3csvnrcm77.uno4.work", "3csvnrcm77.uno4.work")).toBe(false);
  });

  it("remembers it and builds a link to an app inside Work", () => {
    expect(currentWorkAddress()).toBeNull();
    rememberWorkHost("3csvnrcm77.uno4.work");
    expect(isNewWorkHost("3csvnrcm77.uno4.work")).toBe(false);
    rememberWorkHost("app.uno4.work");
    expect(currentWorkAddress()).toBe("https://3csvnrcm77.uno4.work");
    expect(workAppLink("https://3csvnrcm77.uno4.work", "manifest:plan-limits")).toBe(
      "https://3csvnrcm77.uno4.work/app?app=manifest%3Aplan-limits",
    );
  });
});
