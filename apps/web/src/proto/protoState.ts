/**
 * Sidebar prototype (w0115, NOT FOR MERGE): which sidebar variant and which
 * multi-computer mode the page shows, and how the chat list is grouped and
 * filtered. Outside the prototype build every hook here answers "off", so the
 * product code paths stay as they are.
 */
import { create } from "zustand";

export const PROTO = import.meta.env.VITE_SIDEBAR_PROTO === "1";

/**
 * Iteration 2 (Misha 08.10: "C and D are fine, add a group / filter button"):
 * G — one list of chats with a "Group by" button on top (T3-like by default);
 * C — projects as rows above the list (click = filter) + the same button;
 * D — today's sidebar (0.0.115), for comparison.
 */
export type ProtoVariant = "G" | "C" | "D";
/** one — one computer, one space (А); all — computers joined (Б). */
export type ProtoMode = "one" | "all";
/** How the chat list is grouped. */
export type ProtoGroupBy = "none" | "project" | "computer" | "computer-project";

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

export const GROUP_BY: ReadonlyArray<{
  id: ProtoGroupBy;
  /** In the menu. */
  name: string;
  /** On the button. */
  short: string;
  /** Needs 2+ computers. */
  multi?: boolean;
}> = [
  { id: "none", name: "Nothing — one list", short: "One list" },
  { id: "project", name: "Project", short: "By project" },
  { id: "computer", name: "Computer", short: "By computer", multi: true },
  {
    id: "computer-project",
    name: "Computer, then project",
    short: "By computer & project",
    multi: true,
  },
];

export interface ProtoView {
  readonly groupBy: ProtoGroupBy;
  /** Logical project key (one project across computers), "none" = No project. */
  readonly project: string | null;
  /** Environment id of the computer the list is narrowed to. */
  readonly computer: string | null;
}

interface ProtoState extends ProtoView {
  readonly variant: ProtoVariant;
  readonly mode: ProtoMode;
  readonly setVariant: (variant: ProtoVariant) => void;
  readonly setMode: (mode: ProtoMode) => void;
  readonly setGroupBy: (groupBy: ProtoGroupBy) => void;
  readonly setProjectFilter: (project: string | null) => void;
  readonly setComputerFilter: (computer: string | null) => void;
}

const VIEW_KEY = "proto:view:v2";
const DEFAULT_VIEW: ProtoView = { groupBy: "none", project: null, computer: null };

function readView(): ProtoView {
  try {
    const raw = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null") as Partial<ProtoView> | null;
    if (!raw) return DEFAULT_VIEW;
    const groupBy = GROUP_BY.find((item) => item.id === raw.groupBy)?.id ?? "none";
    return {
      groupBy,
      project: typeof raw.project === "string" ? raw.project : null,
      computer: typeof raw.computer === "string" ? raw.computer : null,
    };
  } catch {
    return DEFAULT_VIEW;
  }
}

function writeView(view: ProtoView) {
  localStorage.setItem(
    VIEW_KEY,
    JSON.stringify({ groupBy: view.groupBy, project: view.project, computer: view.computer }),
  );
}

function readInitial(): Pick<ProtoState, "variant" | "mode"> {
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
    (id) => id === (modeRaw ?? localStorage.getItem("proto:mode")),
  );
  return { variant: variant ?? "G", mode: mode ?? "all" };
}

function writeUrl(variant: ProtoVariant, mode: ProtoMode) {
  const url = new URL(location.href);
  url.searchParams.set("v", variant);
  url.searchParams.set("m", mode === "one" ? "a" : "b");
  history.replaceState(history.state, "", url.toString());
  localStorage.setItem("proto:variant", variant);
  localStorage.setItem("proto:mode", mode);
}

export const useProtoStore = create<ProtoState>((set, get) => {
  const persist = (patch: Partial<ProtoView>) => {
    set(patch);
    const { groupBy, project, computer } = get();
    writeView({ groupBy, project, computer });
  };
  return {
    ...(PROTO ? readInitial() : { variant: "D" as const, mode: "one" as const }),
    ...(PROTO ? readView() : DEFAULT_VIEW),
    setVariant: (variant) => {
      set({ variant });
      writeUrl(variant, get().mode);
    },
    setMode: (mode) => {
      set({ mode });
      // (А) is one computer: a computer filter means nothing there.
      if (mode === "one") persist({ computer: null });
      writeUrl(get().variant, mode);
    },
    setGroupBy: (groupBy) => persist({ groupBy }),
    setProjectFilter: (project) => persist({ project }),
    setComputerFilter: (computer) => persist({ computer }),
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

/** The grouping that applies: (А) has one computer, so "by computer" falls back. */
export function effectiveGroupBy(groupBy: ProtoGroupBy, multi: boolean): ProtoGroupBy {
  if (multi) return groupBy;
  if (groupBy === "computer") return "none";
  if (groupBy === "computer-project") return "project";
  return groupBy;
}

/**
 * Done chats fold inside the list (per group, or under the filter) rather
 * than in the shelf at the bottom of the real sidebar.
 */
export function useProtoDoneInsideList(): boolean {
  return useProtoStore(
    (state) =>
      PROTO &&
      state.variant !== "D" &&
      (state.groupBy !== "none" || state.project !== null || state.computer !== null),
  );
}
