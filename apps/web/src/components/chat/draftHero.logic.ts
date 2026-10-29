/**
 * The "draft hero" (upstream T3 Code #4055, `resolveDraftHeroState`): a new
 * chat that hasn't been sent yet shows its composer in the middle of the page
 * under "What should we do in [folder] on [computer]?", instead of an empty
 * timeline with the box at the bottom. Sending (or anything else that puts a
 * row in the chat) docks the composer back to the bottom.
 */

export interface DraftHeroStateInput {
  /** A local draft (route `/draft/$draftId`, not yet a server thread). */
  readonly isLocalDraftThread: boolean;
  readonly hasTimelineEntries: boolean;
  /** A turn runs, a send is in flight or the session is connecting. */
  readonly isWorking: boolean;
  /** The chat inside the right panel (an app's own chat): never centred. */
  readonly isEmbedded: boolean;
  /** Full-screen preview: the chat is a dock over the app. */
  readonly isPreviewFocusMode: boolean;
  /** Uno's own conversation has its own empty state. */
  readonly isAssistantConversation: boolean;
  readonly showComposer: boolean;
}

export function resolveDraftHeroState(input: DraftHeroStateInput): boolean {
  if (!input.showComposer || input.isEmbedded || input.isPreviewFocusMode) return false;
  if (input.isAssistantConversation) return false;
  return input.isLocalDraftThread && !input.hasTimelineEntries && !input.isWorking;
}
