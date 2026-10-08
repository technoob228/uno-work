/**
 * Sidebar prototype (w0115, NOT FOR MERGE): which sidebar variant and which
 * multi-computer mode the page shows. Outside the prototype build every hook
 * here answers "off", so the product code paths stay as they are.
 */
import { create } from "zustand";

export const PROTO = import.meta.env.VITE_SIDEBAR_PROTO === "1";

/**
 * A — one list + "All chats ▾" filter; B — A + "Group by project" in that menu;
 * C — pinned projects above the list; D — today's sidebar (0.0.114);
 * E — projects as a place (a Projects page), the sidebar is only chats.
 */
export type ProtoVariant = "A" | "B" | "C" | "D" | "E";
/** one — one computer, one space (А); all — computers joined (Б). */
export type ProtoMode = "one" | "all";

export const VARIANTS: ReadonlyArray<{ id: ProtoVariant; name: string; hint: string }> = [
  { id: "A", name: "List + filter", hint: "One list. “All chats ▾” picks a project." },
  { id: "B", name: "List + Group", hint: "Like A, plus “Group by project” in the same menu." },
  { id: "C", name: "Projects on top", hint: "Projects as rows above the list. Click = filter." },
  { id: "D", name: "Today", hint: "0.0.114 as is: project groups, Recents, Done." },
  { id: "E", name: "Projects page", hint: "Sidebar = chats only. Projects live on their own page." },
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
    hint: "Chats of all computers in one list, each says “computer · project”.",
  },
];

interface ProtoState {
  readonly variant: ProtoVariant;
  readonly mode: ProtoMode;
  /** B: the list grouped by project. */
  readonly grouped: boolean;
  /** "environmentId:projectId" of the project the list is narrowed to; "home" = Home folder. */
  readonly filter: string | null;
  /** (Б): narrow the list to one computer. */
  readonly machineFilter: string | null;
  readonly setVariant: (variant: ProtoVariant) => void;
  readonly setMode: (mode: ProtoMode) => void;
  readonly setGrouped: (grouped: boolean) => void;
  readonly setFilter: (filter: string | null, machineFilter?: string | null) => void;
}

function readInitial(): Pick<ProtoState, "variant" | "mode"> {
  const params = new URLSearchParams(location.search);
  const fromUrlVariant = params.get("v")?.toUpperCase();
  const fromUrlMode = params.get("m")?.toLowerCase();
  const variant = (["A", "B", "C", "D", "E"] as const).find(
    (id) => id === (fromUrlVariant ?? localStorage.getItem("proto:variant")),
  );
  const modeRaw = fromUrlMode === "b" ? "all" : fromUrlMode === "a" ? "one" : fromUrlMode;
  const mode = (["one", "all"] as const).find(
    (id) => id === (modeRaw ?? localStorage.getItem("proto:mode")),
  );
  return { variant: variant ?? "A", mode: mode ?? "one" };
}

function writeUrl(variant: ProtoVariant, mode: ProtoMode) {
  const url = new URL(location.href);
  url.searchParams.set("v", variant);
  url.searchParams.set("m", mode === "one" ? "a" : "b");
  history.replaceState(history.state, "", url.toString());
  localStorage.setItem("proto:variant", variant);
  localStorage.setItem("proto:mode", mode);
}

export const useProtoStore = create<ProtoState>((set, get) => ({
  ...(PROTO ? readInitial() : { variant: "D" as const, mode: "one" as const }),
  grouped: false,
  filter: null,
  machineFilter: null,
  setVariant: (variant) => {
    set({ variant, filter: null, machineFilter: null, grouped: false });
    writeUrl(variant, get().mode);
  },
  setMode: (mode) => {
    set({ mode, filter: null, machineFilter: null });
    writeUrl(get().variant, mode);
  },
  setGrouped: (grouped) => set({ grouped }),
  setFilter: (filter, machineFilter = null) => set({ filter, machineFilter }),
}));

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
