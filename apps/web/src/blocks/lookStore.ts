/**
 * The look (T55 demo): accent colour, density, text size and the sidebar's
 * surface, on top of Light / Dark / System (useTheme). Applied as one <style>
 * that overrides the design tokens (`--primary`, `--ring`, `--sidebar`…), so
 * every screen follows without touching its components. Apps' widgets get
 * the accent and the mode in their address (`uno-accent`, `uno-theme`).
 *
 * Kept per device in the demo; the plan syncs it with the layout.
 */
import { create } from "zustand";

export type AccentId = "indigo" | "blue" | "teal" | "green" | "amber" | "rose" | "graphite";
export type Density = "comfortable" | "compact";
export type TextSize = "s" | "m" | "l";
export type SidebarSurface = "plain" | "tinted";

export interface Accent {
  readonly id: AccentId;
  readonly label: string;
  /** Hue and chroma; lightness differs for light and dark. */
  readonly hue: number;
  readonly chroma: number;
  readonly hex: string;
}

export const ACCENTS: ReadonlyArray<Accent> = [
  { id: "indigo", label: "Indigo", hue: 273, chroma: 0.22, hex: "#5b5bd6" },
  { id: "blue", label: "Blue", hue: 252, chroma: 0.18, hex: "#2f6fde" },
  { id: "teal", label: "Teal", hue: 190, chroma: 0.12, hex: "#0f9488" },
  { id: "green", label: "Green", hue: 152, chroma: 0.15, hex: "#1f9d55" },
  { id: "amber", label: "Amber", hue: 62, chroma: 0.16, hex: "#d07f0e" },
  { id: "rose", label: "Rose", hue: 10, chroma: 0.2, hex: "#e0457b" },
  { id: "graphite", label: "Graphite", hue: 270, chroma: 0.02, hex: "#3f414d" },
];

export interface Look {
  readonly accent: AccentId;
  readonly density: Density;
  readonly textSize: TextSize;
  readonly sidebar: SidebarSurface;
}

export const DEFAULT_LOOK: Look = {
  accent: "indigo",
  density: "comfortable",
  textSize: "m",
  sidebar: "plain",
};

const KEY = "uno-work:look:v1";

function read(): Look {
  if (typeof window === "undefined") return DEFAULT_LOOK;
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "null") as Partial<Look> | null;
    if (!raw) return DEFAULT_LOOK;
    return {
      accent: ACCENTS.some((a) => a.id === raw.accent) ? (raw.accent as AccentId) : "indigo",
      density: raw.density === "compact" ? "compact" : "comfortable",
      textSize: raw.textSize === "s" || raw.textSize === "l" ? raw.textSize : "m",
      sidebar: raw.sidebar === "tinted" ? "tinted" : "plain",
    };
  } catch {
    return DEFAULT_LOOK;
  }
}

interface LookState {
  readonly look: Look;
  set: (patch: Partial<Look>) => void;
  reset: () => void;
  /** The accent for widgets; null for the default (they keep their own). */
  accentHex: () => string | null;
}

export const useLookStore = create<LookState>((set, get) => ({
  look: read(),
  set: (patch) => {
    const look = { ...get().look, ...patch };
    try {
      window.localStorage.setItem(KEY, JSON.stringify(look));
    } catch {
      // Private mode.
    }
    set({ look });
  },
  reset: () => {
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      // Private mode.
    }
    set({ look: DEFAULT_LOOK });
  },
  accentHex: () => {
    const { accent } = get().look;
    return accent === "indigo" ? null : (ACCENTS.find((a) => a.id === accent)?.hex ?? null);
  },
}));

const TEXT_PX: Record<TextSize, number> = { s: 15, m: 16, l: 17.5 };

/** The CSS for a look: token overrides only, nothing per component. */
export function lookCss(look: Look): string {
  const accent = ACCENTS.find((a) => a.id === look.accent) ?? ACCENTS[0]!;
  const rules: string[] = [];
  if (accent.id !== "indigo") {
    const light = `oklch(${accent.id === "graphite" ? 0.32 : 0.56} ${accent.chroma} ${accent.hue})`;
    const dark = `oklch(${accent.id === "graphite" ? 0.82 : 0.68} ${accent.chroma} ${accent.hue})`;
    rules.push(`:root{--primary:${light};--ring:${light};}`);
    rules.push(`:root.dark{--primary:${dark};--ring:${dark};}`);
    if (accent.id === "graphite") rules.push(`:root.dark{--primary-foreground:#111;}`);
  }
  if (look.sidebar === "tinted") {
    rules.push(
      `:root{--sidebar:oklch(0.965 ${Math.min(accent.chroma, 0.12) * 0.16} ${accent.hue});}`,
      `:root.dark{--sidebar:oklch(0.2 ${Math.min(accent.chroma, 0.12) * 0.3} ${accent.hue});}`,
    );
  }
  if (look.textSize !== "m") rules.push(`html{font-size:${TEXT_PX[look.textSize]}px;}`);
  if (look.density === "compact") {
    // The demo's density: the sidebar's rows and places a step tighter. The
    // plan moves row heights into tokens (--row-h) first.
    rules.push(
      `[data-sidebar=sidebar] [data-testid=sidebar-row-d]{height:1.625rem;}`,
      `[data-sidebar=sidebar] [data-testid=sidebar-assistant] > *{min-height:1.625rem;}`,
      `[data-sidebar=sidebar] .gap-px{gap:0;}`,
      `main .space-y-2\\.5 > :not(:first-child){margin-top:0.4rem;}`,
    );
  }
  return rules.join("\n");
}
