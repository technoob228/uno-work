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
  type RightsLoss,
  assistantKeyOf,
  cascadeRights,
  descendantKeys,
} from "./assistantTeam.logic";

/**
 * Rights cut down the tree (decision 16.10): the Inbox gets "who lost what".
 * The daemon will send that notice itself once it keeps the team; until then
 * whoever shows the Inbox listens here (the demo does).
 */
export const teamEvents = new EventTarget();
export interface RightsCutDetail {
  readonly by: AssistantProfile;
  readonly losses: ReadonlyArray<RightsLoss>;
}

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
  /** A change of rights, cut down to everything it set up; returns who lost what. */
  readonly setRights: (
    key: AssistantKey,
    patch: Partial<
      Pick<AssistantProfile, "preset" | "projects" | "computers" | "access" | "ownComputer">
    >,
    /** Its profile as shown, when the store has none yet (an assistant from before the team). */
    base?: AssistantProfile,
  ) => ReadonlyArray<RightsLoss>;
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
  setRights: (key, patch, base) => {
    const start = { ...get().profiles };
    if (!start[key] && base) start[key] = base;
    const cut = cascadeRights(start, key, patch);
    const at = new Date().toISOString();
    const profiles = { ...cut.profiles };
    const losses = cut.losses;
    // Each one keeps a line in its Activity: who cut what.
    const by = profiles[key];
    for (const loss of losses) {
      const child = profiles[loss.key];
      if (!child || !by) continue;
      profiles[loss.key] = {
        ...child,
        activity: [
          ...(child.activity ?? []),
          {
            at,
            kind: "access",
            text: `Lost ${loss.lost.join(", ")} — ${by.name}'s rights changed`,
          },
        ],
      };
    }
    save(profiles);
    set({ profiles });
    if (by && losses.length > 0) {
      teamEvents.dispatchEvent(
        new CustomEvent<RightsCutDetail>("rights-cut", { detail: { by, losses } }),
      );
    }
    return losses;
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
