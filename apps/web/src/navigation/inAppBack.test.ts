import { beforeEach, describe, expect, it } from "vitest";

import {
  isUsefulBackTarget,
  previousEntryPath,
  rememberHistoryEntry,
  resetHistoryEntries,
} from "./inAppBack";

describe("Home's Back", () => {
  beforeEach(() => resetHistoryEntries());

  it("is hidden on a fresh first screen: nothing inside Work before it", () => {
    expect(isUsefulBackTarget(undefined, "/computer")).toBe(false);
    expect(previousEntryPath(0)).toBeUndefined();
  });

  it("never leads back into setup, onboarding, pairing or the bouncing landing", () => {
    expect(isUsefulBackTarget("/setup", "/computer")).toBe(false);
    expect(isUsefulBackTarget("/setup/goal", "/computer")).toBe(false);
    expect(isUsefulBackTarget("/onboarding", "/computer")).toBe(false);
    expect(isUsefulBackTarget("/pair", "/computer")).toBe(false);
    expect(isUsefulBackTarget("/", "/computer")).toBe(false);
    expect(isUsefulBackTarget("/computer", "/computer")).toBe(false);
  });

  it("returns to a chat or a screen the person was on", () => {
    expect(isUsefulBackTarget("/env-1/thread-1", "/computer")).toBe(true);
    expect(isUsefulBackTarget("/files", "/computer")).toBe(true);
    expect(isUsefulBackTarget("/settings/general", "/computer")).toBe(true);
    // "/setup-notes" is not the setup screen.
    expect(isUsefulBackTarget("/setup-notes", "/computer")).toBe(true);
  });

  it("knows the path one entry back, replaced entries included", () => {
    rememberHistoryEntry(0, "/");
    rememberHistoryEntry(0, "/setup");
    rememberHistoryEntry(1, "/computer");
    expect(previousEntryPath(1)).toBe("/setup");
    rememberHistoryEntry(1, "/env-1/thread-1");
    rememberHistoryEntry(2, "/computer");
    expect(previousEntryPath(2)).toBe("/env-1/thread-1");
    // After a reload deeper in history, the earlier entries are unknown.
    expect(previousEntryPath(7)).toBeUndefined();
    rememberHistoryEntry(undefined, "/x");
    expect(previousEntryPath(1)).toBe("/setup");
  });
});
