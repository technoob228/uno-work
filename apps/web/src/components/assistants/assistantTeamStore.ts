/**
 * The team's profiles — what the person picked in the setup for each
 * assistant (where to talk, access, preset, AI, who it is, who made it).
 *
 * Kept in this browser until the daemon stores them next to the assistant's
 * folder (the token already carries scopes and projects; preset, roles,
 * character and the "who set up whom" link have no field there yet). The
 * folders and chats themselves are real: `useAssistantTeam.ts` joins them.
 */
import { create } from "zustand";

import {
  type AssistantKey,
  type AssistantProfile,
  assistantKeyOf,
  descendantKeys,
} from "./assistantTeam.logic";

const KEY = "uno.assistant-team.v1";

function load(): Record<AssistantKey, AssistantProfile> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<AssistantKey, AssistantProfile>) : {};
  } catch {
    return {};
  }
}

function save(profiles: Record<AssistantKey, AssistantProfile>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(profiles));
  } catch {
    // Private mode / full storage: the team still works for this session.
  }
}

interface AssistantTeamState {
  readonly profiles: Readonly<Record<AssistantKey, AssistantProfile>>;
  readonly upsert: (profile: AssistantProfile) => void;
  readonly patch: (key: AssistantKey, patch: Partial<AssistantProfile>) => void;
  /** Revokes it and everything it set up; returns how many went with it. */
  readonly revoke: (key: AssistantKey) => number;
  readonly restore: (key: AssistantKey) => void;
  /** Profiles that aren't there yet (the demo's team, an import). */
  readonly seed: (profiles: ReadonlyArray<AssistantProfile>) => void;
}

export const useAssistantTeamStore = create<AssistantTeamState>((set, get) => ({
  profiles: load(),
  upsert: (profile) => {
    const profiles = {
      ...get().profiles,
      [assistantKeyOf(profile.environmentId, profile.projectId)]: profile,
    };
    save(profiles);
    set({ profiles });
  },
  patch: (key, patch) => {
    const current = get().profiles[key];
    if (!current) return;
    const profiles = { ...get().profiles, [key]: { ...current, ...patch } };
    save(profiles);
    set({ profiles });
  },
  revoke: (key) => {
    const all = Object.entries(get().profiles).map(([itemKey, profile]) => ({
      key: itemKey,
      createdBy: profile.createdBy,
    }));
    const gone = [key, ...descendantKeys(all, key)];
    const at = new Date().toISOString();
    const profiles = { ...get().profiles };
    for (const itemKey of gone) {
      const profile = profiles[itemKey];
      if (profile && profile.revokedAt === null) profiles[itemKey] = { ...profile, revokedAt: at };
    }
    save(profiles);
    set({ profiles });
    return gone.length - 1;
  },
  restore: (key) => {
    const current = get().profiles[key];
    if (!current) return;
    const profiles = { ...get().profiles, [key]: { ...current, revokedAt: null } };
    save(profiles);
    set({ profiles });
  },
  seed: (seeded) => {
    const profiles = { ...get().profiles };
    let changed = false;
    for (const profile of seeded) {
      const key = assistantKeyOf(profile.environmentId, profile.projectId);
      if (!profiles[key]) {
        profiles[key] = profile;
        changed = true;
      }
    }
    if (!changed) return;
    save(profiles);
    set({ profiles });
  },
}));
