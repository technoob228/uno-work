/**
 * Sidebar prototype (w0115, NOT FOR MERGE): which sidebar variant and which
 * multi-computer mode the page shows, and how the chat list is grouped and
 * filtered. Outside the prototype build every hook here answers "off", so the
 * product code paths stay as they are.
 */
import { create } from "zustand";

import { GROUP_LEVELS, type GroupLevel } from "./chatGrouping";

/**
 * icp3 09.10: the prototype runs on real data (computerNames.ts) and is on in
 * this build — the stage of the multi-computer view. `?v=D` still shows the
 * 0.0.117 sidebar to compare; `?m=a|b` picks the mode.
 */
export const PROTO = true;

/**
 * Iteration 2 (Misha 08.10: "C and D are fine, add a group / filter button"):
 * G — one list of chats with a "Group by" button on top (T3-like by default);
 * C — projects as rows above the list (click = filter) + the same button;
 * D — today's sidebar (0.0.115), for comparison.
 */
export type ProtoVariant = "G" | "C" | "D";
/** one — one computer, one space (А); all — computers joined (Б). */
export type ProtoMode = "one" | "all";
export const VARIANTS: ReadonlyArray<{ id: ProtoVariant; name: string; hint: string }> = [
  {
    id: "G",
    name: "List + Group by",
    hint: "One list of chats. The button above it groups by project / computer and filters.",
  },
  {
    id: "C",
    name: "Projects on top",
    hint: "Projects as rows above the chats (click = filter), plus the same Group by button.",
  },
  { id: "D", name: "Today", hint: "0.0.115 as is: project groups, Recents, Done." },
];

export const MODES: ReadonlyArray<{ id: ProtoMode; name: string; hint: string }> = [
  {
    id: "one",
    name: "(А) One computer",
    hint: "Everything — chats, Needs you, Inbox, Home — is about the computer picked on top.",
  },
  {
    id: "all",
    name: "(Б) All together",
    hint: "Chats of all computers in one list; each says “project · computer”.",
  },
];

/**
 * Sidebar v2 (Misha 09.10 ~22:00): how the chat list is grouped — any of
 * status / computer / project, in the order picked — and which computers it
 * shows. One saved view for G and C.
 */
export interface ProtoView {
  /** Group levels in order; [] = one list, newest first. */
  readonly levels: ReadonlyArray<GroupLevel>;
  /** Environment ids the list shows; null = all computers. */
  readonly computers: ReadonlyArray<string> | null;
  /** Logical project key (one project across computers), "none" = No project (C's rows). */
  readonly project: string | null;
}

interface ProtoState extends ProtoView {
  readonly variant: ProtoVariant;
  readonly mode: ProtoMode;
  readonly setVariant: (variant: ProtoVariant) => void;
  readonly setMode: (mode: ProtoMode) => void;
  readonly setLevels: (levels: ReadonlyArray<GroupLevel>) => void;
  readonly setComputers: (computers: ReadonlyArray<string> | null) => void;
  readonly setProjectFilter: (project: string | null) => void;
}

/** v3: a new key, so a view saved by the earlier "View" button doesn't override the new default. */
const VIEW_KEY = "proto:view:v3";
/** Default (Misha 09.10): all computers together, grouped by project. */
export const DEFAULT_VIEW: ProtoView = { levels: ["project"], computers: null, project: null };

export function parseView(raw: unknown): ProtoView {
  if (!raw || typeof raw !== "object") return DEFAULT_VIEW;
  const value = raw as Record<string, unknown>;
  const levels = Array.isArray(value.levels)
    ? value.levels.filter(
        (level, index, all): level is GroupLevel =>
          GROUP_LEVELS.some((item) => item.id === level) && all.indexOf(level) === index,
      )
    : DEFAULT_VIEW.levels;
  const computers =
    Array.isArray(value.computers) && value.computers.length > 0
      ? value.computers.filter((id): id is string => typeof id === "string")
      : null;
  return {
    levels,
    computers,
    project: typeof value.project === "string" ? value.project : null,
  };
}

function readView(): ProtoView {
  if (typeof localStorage === "undefined") return DEFAULT_VIEW;
  try {
    return parseView(JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null"));
  } catch {
    return DEFAULT_VIEW;
  }
}

function writeView(view: ProtoView) {
  localStorage.setItem(
    VIEW_KEY,
    JSON.stringify({ levels: view.levels, computers: view.computers, project: view.project }),
  );
}

function readInitial(): Pick<ProtoState, "variant" | "mode"> {
  // Unit tests import this without a page.
  if (typeof location === "undefined" || typeof localStorage === "undefined") {
    return { variant: "G", mode: "all" };
  }
  const params = new URLSearchParams(location.search);
  const fromUrlVariant = params.get("v")?.toUpperCase();
  const fromUrlMode = params.get("m")?.toLowerCase();
  // Iteration 1 links (A, B, E) land on the new list.
  const legacy = fromUrlVariant && ["A", "B", "E"].includes(fromUrlVariant) ? "G" : null;
  const variant = (["G", "C", "D"] as const).find(
    (id) => id === (legacy ?? fromUrlVariant ?? localStorage.getItem("proto:variant")),
  );
  const modeRaw = fromUrlMode === "b" ? "all" : fromUrlMode === "a" ? "one" : fromUrlMode;
  const mode = (["one", "all"] as const).find(
    // v2 key: "Only this computer" saved by the earlier prototype doesn't stick (default: all).
    (id) => id === (modeRaw ?? localStorage.getItem("proto:mode:v2")),
  );
  return { variant: variant ?? "G", mode: mode ?? "all" };
}

function writeUrl(variant: ProtoVariant, mode: ProtoMode) {
  // Remembered, not put in the address: the address is the person's.
  localStorage.setItem("proto:variant", variant);
  localStorage.setItem("proto:mode:v2", mode);
}

export const useProtoStore = create<ProtoState>((set, get) => {
  const persist = (patch: Partial<ProtoView>) => {
    set(patch);
    const { levels, computers, project } = get();
    writeView({ levels, computers, project });
  };
  const initial = PROTO ? readInitial() : { variant: "D" as const, mode: "one" as const };
  return {
    ...initial,
    ...(PROTO ? readView() : DEFAULT_VIEW),
    setVariant: (variant) => {
      set({ variant });
      writeUrl(variant, get().mode);
    },
    setMode: (mode) => {
      set({ mode });
      // (А) is one computer: a computer filter means nothing there.
      if (mode === "one") persist({ computers: null });
      writeUrl(get().variant, mode);
    },
    setLevels: (levels) => persist({ levels: [...levels] }),
    setComputers: (computers) => persist({ computers: computers ? [...computers] : null }),
    setProjectFilter: (project) => persist({ project }),
  };
});

/** The variant on screen; "off" outside the prototype build. */
export function useProtoVariant(): ProtoVariant | "off" {
  const variant = useProtoStore((state) => state.variant);
  return PROTO ? variant : "off";
}

/** (Б) — computers joined. False outside the prototype build. */
export function useProtoAllMachines(): boolean {
  const mode = useProtoStore((state) => state.mode);
  return PROTO && mode === "all";
}

/** (А) — everything about the active computer only. False outside the prototype. */
export function useProtoOneMachine(): boolean {
  const mode = useProtoStore((state) => state.mode);
  return PROTO && mode === "one";
}

export function readProtoMode(): ProtoMode | "off" {
  return PROTO ? useProtoStore.getState().mode : "off";
}

/**
 * Done chats fold inside the list (per group, or under the filter) rather
 * than in the shelf at the bottom of the real sidebar.
 */
export function useProtoDoneInsideList(): boolean {
  return useProtoStore((state) => PROTO && state.variant !== "D");
}
