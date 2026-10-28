import type { UnoMachineApp } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { homeWidgetSource } from "./homeAppWidget.logic";
import { newAppWidgetBlocks } from "./homeLayout";

function app(overrides: Partial<UnoMachineApp> = {}): UnoMachineApp {
  return {
    id: "manifest:plan-limits",
    source: "manifest",
    name: "Plan limits",
    status: "running",
    port: 8471,
    http: true,
    url: null,
    localUrl: "http://localhost:8471/",
    publication: null,
    widget: { path: "/widget", size: "medium" },
    ...overrides,
  } as UnoMachineApp;
}

const cloud = { browserOnMachine: false, cloudComputer: true, pageProtocol: "https:" };

describe("homeWidgetSource (P16: a widget of a cloud computer's app shows inside Work)", () => {
  it("a cloud computer's app: from the port's address, the widget's path on the port", () => {
    expect(homeWidgetSource(app(), cloud)).toEqual({
      kind: "port",
      localUrl: "http://localhost:8471/widget",
    });
  });

  it("an app registered with path /widget: still /widget, never /widget/widget", () => {
    const registered = app({ localUrl: "http://localhost:8471/widget" });
    expect(homeWidgetSource(registered, cloud)).toEqual({
      kind: "port",
      localUrl: "http://localhost:8471/widget",
    });
    expect(homeWidgetSource(registered, { browserOnMachine: true, cloudComputer: false })).toEqual({
      kind: "direct",
      url: "http://localhost:8471/widget",
    });
  });

  it("the desktop app (its page on 127.0.0.1) never takes a cloud computer's localhost for its own", () => {
    expect(homeWidgetSource(app(), { browserOnMachine: true, cloudComputer: true })).toEqual({
      kind: "port",
      localUrl: "http://localhost:8471/widget",
    });
  });

  it("an app with its own https address keeps using it", () => {
    expect(homeWidgetSource(app({ privateUrl: "https://plan-box.app.uno4.dev/" }), cloud)).toEqual({
      kind: "direct",
      url: "https://plan-box.app.uno4.dev/widget",
    });
  });

  it("a plain-http public address can't show in https Work: still the port's address", () => {
    expect(
      homeWidgetSource(
        app({ publication: { url: "http://203.0.113.5:31080/", forwards: [] } as never }),
        cloud,
      ),
    ).toEqual({ kind: "port", localUrl: "http://localhost:8471/widget" });
  });

  it("stopped, or nowhere to show it", () => {
    expect(homeWidgetSource(app({ status: "stopped" }), cloud)).toEqual({
      kind: "none",
      why: "stopped",
    });
    expect(homeWidgetSource(app(), { browserOnMachine: false, cloudComputer: false })).toEqual({
      kind: "none",
      why: "no-address",
    });
    expect(homeWidgetSource(app({ widget: null }), cloud)).toBeNull();
  });
});

describe("newAppWidgetBlocks (a new app widget lands on Home by itself)", () => {
  it("adds a widget this device hasn't seen", () => {
    expect(
      newAppWidgetBlocks({
        widgetAppIds: ["notes", "plan-limits"],
        seen: ["notes"],
        layoutSaved: true,
      }),
    ).toEqual({ add: ["app:plan-limits"], seen: ["notes", "plan-limits"] });
  });

  it("never brings back a widget the person removed", () => {
    expect(
      newAppWidgetBlocks({ widgetAppIds: ["notes"], seen: ["notes"], layoutSaved: true }),
    ).toEqual({ add: [], seen: ["notes"] });
  });

  it("an updated device: today's widgets count as seen (one removed earlier stays removed)", () => {
    expect(newAppWidgetBlocks({ widgetAppIds: ["notes"], seen: null, layoutSaved: true })).toEqual({
      add: [],
      seen: ["notes"],
    });
  });

  it("a new device: every app widget is on Home", () => {
    expect(
      newAppWidgetBlocks({
        widgetAppIds: ["notes", "notes", "Bad Id"],
        seen: null,
        layoutSaved: false,
      }),
    ).toEqual({ add: ["app:notes"], seen: ["notes"] });
  });
});
