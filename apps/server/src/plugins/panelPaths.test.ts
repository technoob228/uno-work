import { describe, expect, it } from "vitest";

import {
  isPanelNavigationRequest,
  parsePluginPanelRequestPath,
  resolvePluginPanelAssetPath,
  resolvePluginPanelLocation,
} from "./panelPaths.ts";

const pluginDir = "/tmp/plugins/demo";
const location = resolvePluginPanelLocation({ pluginDir, panelPath: "panel/index.html" })!;

describe("plugin panel paths", () => {
  it("resolves the entry file and its directory", () => {
    expect(location.entryFilePath).toBe("/tmp/plugins/demo/panel/index.html");
    expect(location.rootDir).toBe("/tmp/plugins/demo/panel");
  });

  it("rejects entry paths that are absolute, empty or escape the plugin", () => {
    for (const panelPath of ["", "   ", "/etc/passwd", "../../etc/passwd", "..", "./"]) {
      expect(resolvePluginPanelLocation({ pluginDir, panelPath })).toBeNull();
    }
  });

  it("serves an empty rest as the entry file", () => {
    for (const rest of ["", "/"]) {
      expect(resolvePluginPanelAssetPath({ location, pluginDir, rest })).toBe(
        location.entryFilePath,
      );
    }
  });

  it("resolves siblings of the entry file", () => {
    expect(resolvePluginPanelAssetPath({ location, pluginDir, rest: "data.json" })).toBe(
      "/tmp/plugins/demo/panel/data.json",
    );
    expect(resolvePluginPanelAssetPath({ location, pluginDir, rest: "assets/app.js" })).toBe(
      "/tmp/plugins/demo/panel/assets/app.js",
    );
  });

  it("rejects traversal, encoded traversal and NUL bytes", () => {
    for (const rest of [
      "../plugin.json",
      "..%2fplugin.json",
      "%2e%2e%2f%2e%2e%2foutside.txt",
      "../../../etc/passwd",
      "sub/../../plugin.json",
      "data%00.json",
    ]) {
      expect(resolvePluginPanelAssetPath({ location, pluginDir, rest })).toBeNull();
    }
  });

  it("parses the route path and keeps the plugin id a single segment", () => {
    expect(parsePluginPanelRequestPath("/api/plugins/demo/panel/data.json")).toEqual({
      pluginId: "demo",
      rest: "data.json",
    });
    expect(parsePluginPanelRequestPath("/api/plugins/demo/panel/")).toEqual({
      pluginId: "demo",
      rest: "",
    });
    expect(parsePluginPanelRequestPath("/api/plugins/demo/panel")).toEqual({
      pluginId: "demo",
      rest: "",
    });
    expect(parsePluginPanelRequestPath("/api/plugins/..%2f..%2fetc/panel/passwd")).toBeNull();
    expect(parsePluginPanelRequestPath("/api/plugins/demo/other/data.json")).toBeNull();
    expect(parsePluginPanelRequestPath("/attachments/demo")).toBeNull();
  });

  it("treats documents and unknown clients as navigation, subresources as not", () => {
    for (const dest of ["iframe", "document", "frame", undefined, ""]) {
      expect(isPanelNavigationRequest(dest)).toBe(true);
    }
    for (const dest of ["empty", "script", "style", "image", "font"]) {
      expect(isPanelNavigationRequest(dest)).toBe(false);
    }
  });
});
