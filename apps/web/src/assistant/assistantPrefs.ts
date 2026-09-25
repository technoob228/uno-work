/**
 * Per-device preferences of the Uno row (0.0.85): whether it shows in the
 * sidebar at all (Settings → Assistant → Show in sidebar; Uno stays reachable
 * from Home and ⌘K) and whether its conversations are unfolded.
 */
import { Schema } from "effect";

import { useLocalStorage } from "../hooks/useLocalStorage";

const SHOW_IN_SIDEBAR_KEY = "uno:assistant:show-in-sidebar";
const EXPANDED_KEY = "uno:assistant:conversations-expanded";

export function useShowAssistantInSidebar() {
  return useLocalStorage<boolean, boolean>(SHOW_IN_SIDEBAR_KEY, true, Schema.Boolean);
}

export function useAssistantConversationsExpanded() {
  return useLocalStorage<boolean, boolean>(EXPANDED_KEY, false, Schema.Boolean);
}
