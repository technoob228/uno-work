import { scopeProjectRef } from "@t3tools/client-runtime";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { DraftId, useComposerDraftStore } from "~/composerDraftStore";

import { placeLinkedPrompt } from "./linkedPrompt";

const draftId = DraftId.make("draft-link");
const projectRef = scopeProjectRef(
  EnvironmentId.make("environment-link"),
  ProjectId.make("project-link"),
);
const linked = { text: "Summarize this repo", hiddenCharacters: 0 };

function draft() {
  const store = useComposerDraftStore.getState();
  return { box: store.getComposerDraft(draftId), thread: store.getDraftThread(draftId) };
}

describe("placeLinkedPrompt", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    });
    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId("project-link", projectRef, draftId, {
        runtimeMode: "full-access",
      });
  });

  it("starts the chat on confirmations for someone on Full access", () => {
    placeLinkedPrompt(draftId, linked);
    expect(draft().box?.prompt).toBe(linked.text);
    expect(draft().box?.runtimeMode).toBe("approval-required");
    expect(draft().thread?.runtimeMode).toBe("approval-required");
  });

  it("leaves the person's own draft and its permissions until they replace it", () => {
    useComposerDraftStore.getState().setPrompt(draftId, "my own words");
    placeLinkedPrompt(draftId, linked);
    expect(draft().box?.prompt).toBe("my own words");
    expect(draft().box?.runtimeMode ?? null).toBeNull();
    expect(draft().thread?.runtimeMode).toBe("full-access");
  });
});
