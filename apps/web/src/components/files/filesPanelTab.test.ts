import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { filesTabId, isFilesTab, makeFilesTabFile } from "../preview/PreviewPaneContext";
import { previewDownloadSource } from "../preview/previewFileUtils";
import { filesOpensInPanel, usePanelFilesStore } from "./filesPanelTab";

const env = EnvironmentId.make("env-1");

describe("Files in the right panel (Misha 18.10)", () => {
  it("opens beside a chat, never on a phone or without a computer", () => {
    expect(filesOpensInPanel({ inChat: true, isMobile: false, hasEnvironment: true })).toBe(true);
    expect(filesOpensInPanel({ inChat: false, isMobile: false, hasEnvironment: true })).toBe(false);
    expect(filesOpensInPanel({ inChat: true, isMobile: true, hasEnvironment: true })).toBe(false);
    expect(filesOpensInPanel({ inChat: true, isMobile: false, hasEnvironment: false })).toBe(false);
  });

  it("is one tab per computer, not a file: no path, nothing to download", () => {
    const tab = makeFilesTabFile(env);
    expect(tab.id).toBe(filesTabId(env));
    expect(makeFilesTabFile(env).id).toBe(tab.id);
    expect(isFilesTab(tab)).toBe(true);
    expect(tab.path).toBeUndefined();
    expect(previewDownloadSource(tab, env)).toBeNull();
  });

  it("opened from a chat, it is that chat's own tab (Misha 19.10)", () => {
    const inChatA = makeFilesTabFile(env, "thread-a");
    expect(inChatA.id).toBe(filesTabId(env, "thread-a"));
    expect(inChatA.id).not.toBe(makeFilesTabFile(env, "thread-b").id);
    expect(inChatA.id).not.toBe(makeFilesTabFile(env).id);
    expect(isFilesTab(inChatA)).toBe(true);
  });

  it("keeps each tab's place", () => {
    const { setPlace } = usePanelFilesStore.getState();
    setPlace("files:a", { path: "/home/unowork/project" });
    setPlace("files:b", { cloud: "1" });
    expect(usePanelFilesStore.getState().byTab["files:a"]).toEqual({
      path: "/home/unowork/project",
    });
    expect(usePanelFilesStore.getState().byTab["files:b"]).toEqual({ cloud: "1" });
  });
});
