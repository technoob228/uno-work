import { describe, expect, it } from "vitest";

import { resolveDraftHeroState, type DraftHeroStateInput } from "./draftHero.logic";

const EMPTY_DRAFT: DraftHeroStateInput = {
  isLocalDraftThread: true,
  hasTimelineEntries: false,
  isWorking: false,
  isEmbedded: false,
  isPreviewFocusMode: false,
  isAssistantConversation: false,
  showComposer: true,
};

describe("resolveDraftHeroState", () => {
  it("centres the composer of a new, empty chat", () => {
    expect(resolveDraftHeroState(EMPTY_DRAFT)).toBe(true);
  });

  it("docks it once the chat has a row or is busy sending", () => {
    expect(resolveDraftHeroState({ ...EMPTY_DRAFT, hasTimelineEntries: true })).toBe(false);
    expect(resolveDraftHeroState({ ...EMPTY_DRAFT, isWorking: true })).toBe(false);
  });

  it("never centres a chat that has started on the server", () => {
    expect(resolveDraftHeroState({ ...EMPTY_DRAFT, isLocalDraftThread: false })).toBe(false);
  });

  it("keeps the bottom composer where centring makes no sense", () => {
    expect(resolveDraftHeroState({ ...EMPTY_DRAFT, isEmbedded: true })).toBe(false);
    expect(resolveDraftHeroState({ ...EMPTY_DRAFT, isPreviewFocusMode: true })).toBe(false);
    expect(resolveDraftHeroState({ ...EMPTY_DRAFT, isAssistantConversation: true })).toBe(false);
    expect(resolveDraftHeroState({ ...EMPTY_DRAFT, showComposer: false })).toBe(false);
  });
});
