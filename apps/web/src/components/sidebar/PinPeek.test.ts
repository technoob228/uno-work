import type { UnoMachineApp, UnoPin } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { ProgramTile } from "../computer/programModel";
import { pinnedMachineApp } from "./PinPeek";

const app = (id: string, url: string) => ({ id, name: id, url }) as unknown as UnoMachineApp;
const tile = (machineApp: UnoMachineApp | null, openUrl: string | null) =>
  ({ machineApp, openUrl }) as unknown as ProgramTile;
const pin = (target: string, kind: UnoPin["kind"] = "app") =>
  ({ id: "p", kind, title: "t", target }) as UnoPin;

describe("pinnedMachineApp", () => {
  const sales = app("sales", "http://localhost:8124");
  const bot = app("bot", "https://bot-misha.app.uno4.dev");
  const tiles = [
    tile(sales, "https://sales-misha.app.uno4.dev/"),
    tile(bot, "https://bot-misha.app.uno4.dev/"),
    tile(null, "https://site.uno4.me/"),
  ];

  it("finds the app by the address its tile opened at", () => {
    expect(pinnedMachineApp(pin("https://sales-misha.app.uno4.dev/"), tiles)).toBe(sales);
  });

  it("or by the app's own address", () => {
    expect(pinnedMachineApp(pin("http://localhost:8124"), tiles)).toBe(sales);
  });

  it("a page deeper in the same app is still it", () => {
    expect(pinnedMachineApp(pin("https://bot-misha.app.uno4.dev/chats?x=1"), tiles)).toBe(bot);
  });

  it("not an app of this computer, a site, or another kind of pin", () => {
    expect(pinnedMachineApp(pin("https://example.com/"), tiles)).toBeNull();
    expect(pinnedMachineApp(pin("https://site.uno4.me/"), tiles)).toBeNull();
    expect(pinnedMachineApp(pin("https://sales-misha.app.uno4.dev/", "link"), tiles)).toBeNull();
  });

  it("two apps on one origin: only an exact address tells them apart", () => {
    const a = app("a", "http://localhost:9000/a/");
    const b = app("b", "http://localhost:9000/b/");
    const shared = [tile(a, "http://localhost:9000/a/"), tile(b, "http://localhost:9000/b/")];
    expect(pinnedMachineApp(pin("http://localhost:9000/b/"), shared)).toBe(b);
    expect(pinnedMachineApp(pin("http://localhost:9000/c/"), shared)).toBeNull();
  });
});
