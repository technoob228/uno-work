/**
 * Sidebar prototype (w0115, NOT FOR MERGE): which sidebar variant and which
 * multi-computer mode the page shows, and how the chat list is grouped and
 * filtered. Outside the prototype build every hook here answers "off", so the
 * product code paths stay as they are.
 */
import { create } from "zustand";

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
  { id: "none", name: "Nothing — newest first", short: "Newest first" },
  { id: "project", name: "Project", short: "By project" },
  { id: "computer", name: "Computer", short: "By computer", multi: true },
  {
    id: "computer-project",
    name: "Computer, then project",
    short: "Computer & project",
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

const viewKey = (variant: ProtoVariant) => `proto:view:v2:${variant}`;
const DEFAULT_VIEW: ProtoView = { groupBy: "none", project: null, computer: null };
/** Critics 3–4: G reads best grouped by project; C already shows projects on top. */
const defaultViewOf = (variant: ProtoVariant): ProtoView =>
  variant === "G" ? { ...DEFAULT_VIEW, groupBy: "project" } : DEFAULT_VIEW;

function readView(variant: ProtoVariant): ProtoView {
  const fallback = defaultViewOf(variant);
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw = JSON.parse(
      localStorage.getItem(viewKey(variant)) ?? "null",
    ) as Partial<ProtoView> | null;
    if (!raw) return fallback;
    const groupBy = GROUP_BY.find((item) => item.id === raw.groupBy)?.id ?? fallback.groupBy;
    return {
      groupBy,
      project: typeof raw.project === "string" ? raw.project : null,
      computer: typeof raw.computer === "string" ? raw.computer : null,
    };
  } catch {
    return fallback;
  }
}

function writeView(variant: ProtoVariant, view: ProtoView) {
  localStorage.setItem(
    viewKey(variant),
    JSON.stringify({ groupBy: view.groupBy, project: view.project, computer: view.computer }),
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
    (id) => id === (modeRaw ?? localStorage.getItem("proto:mode")),
  );
  return { variant: variant ?? "G", mode: mode ?? "all" };
}

function writeUrl(variant: ProtoVariant, mode: ProtoMode) {
  // Remembered, not put in the address: the address is the person's.
  localStorage.setItem("proto:variant", variant);
  localStorage.setItem("proto:mode", mode);
}

export const useProtoStore = create<ProtoState>((set, get) => {
  const persist = (patch: Partial<ProtoView>) => {
    set(patch);
    const { groupBy, project, computer, variant } = get();
    writeView(variant, { groupBy, project, computer });
  };
  const initial = PROTO ? readInitial() : { variant: "D" as const, mode: "one" as const };
  return {
    ...initial,
    ...(PROTO ? readView(initial.variant) : DEFAULT_VIEW),
    setVariant: (variant) => {
      set({ variant, ...readView(variant) });
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
  return useProtoStore((state) => PROTO && state.variant !== "D");
}
