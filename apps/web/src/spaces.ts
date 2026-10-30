/**
 * Several computers, the spaces option (Misha 28.10: "like two different
 * universes — chats and apps don't overlap; hidden in Settings as an option").
 *
 * Off (default): one space — every computer's chats together, all computers
 * in the top-right chip (variant C). On (`computerSpaces`): the active
 * computer is the space; the sidebar, Home, Inbox, assistants and apps show
 * only what lives on it. The switch is hard: it always lands on the space's
 * Home, a chat of another computer opened from a link moves the space there
 * (never a mix on screen), and the space survives a reload.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { usePrimaryEnvironmentId } from "./environments/primary/context";
import { useSettings } from "./hooks/useSettings";
import { useStore } from "./store";

const SPACE_KEY = "uno:computer-space";

/** The spaces option is on (Settings → General). */
export function useSpacesOn(): boolean {
  return useSettings((settings) => settings.computerSpaces);
}

/** The space's computer when spaces are on; null — one space, everything together. */
export function useSpaceScope(): EnvironmentId | null {
  const on = useSpacesOn();
  const active = useStore((state) => state.activeEnvironmentId);
  const primary = usePrimaryEnvironmentId();
  return on ? (active ?? primary) : null;
}

/** Is this item (a chat, an Inbox card, an assistant) in the current space. */
export function inSpace(scope: EnvironmentId | null, environmentId: string | null | undefined) {
  return scope === null || environmentId === scope;
}

export function readSavedSpace(): string | null {
  try {
    return localStorage.getItem(SPACE_KEY);
  } catch {
    return null;
  }
}

export function saveSpace(environmentId: string) {
  try {
    localStorage.setItem(SPACE_KEY, environmentId);
  } catch {
    // private mode: the space just isn't remembered
  }
}

/** Enter a computer's space: make it active and land on its own Home, every time. */
export function useSwitchSpace() {
  const navigate = useNavigate();
  const setActiveEnvironmentId = useStore((state) => state.setActiveEnvironmentId);
  return useCallback(
    (environmentId: EnvironmentId) => {
      setActiveEnvironmentId(environmentId);
      saveSpace(environmentId);
      void navigate({ to: "/computer" });
    },
    [navigate, setActiveEnvironmentId],
  );
}
