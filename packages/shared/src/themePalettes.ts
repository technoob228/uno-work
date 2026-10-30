/**
 * The colors a page in the chat starts with (`htmlRender.ts`): the app's own
 * tokens (`apps/web/src/index.css`), spelled out for places that can't read
 * them (the page's first paint, the server's screenshot). The app sends the
 * live ones when the page loads and on every theme change.
 *
 * Upstream's `themePalettes.ts` carries five themes and every role of the app
 * chrome; we have one theme, so only the roles a page uses are here.
 */
export type ThemeAppearance = "light" | "dark";

export const THEME_COLOR_ROLES = [
  "canvas",
  "text",
  "muted",
  "mutedForeground",
  "surface",
  "surfaceOverlay",
  "secondary",
  "secondaryForeground",
  "border",
  "input",
  "focus",
  "messageAction",
  "messageActionForeground",
  "accent",
  "accentForeground",
  "accentSurface",
  "accentSurfaceForeground",
  "error",
  "errorForeground",
  "errorSurface",
  "warning",
  "warningForeground",
  "warningSurface",
  "codeBackground",
  "codeForeground",
] as const;

export type ThemeColorRole = (typeof THEME_COLOR_ROLES)[number];
export type ThemeColors = Readonly<Record<ThemeColorRole, string>>;

export const UNO_LIGHT_THEME_COLORS: ThemeColors = {
  canvas: "#ffffff",
  text: "#18181b",
  muted: "rgb(0 0 0 / 4%)",
  mutedForeground: "#71717a",
  surface: "#ffffff",
  surfaceOverlay: "#ffffff",
  secondary: "rgb(0 0 0 / 4%)",
  secondaryForeground: "#27272a",
  border: "rgb(0 0 0 / 9%)",
  input: "rgb(0 0 0 / 12%)",
  focus: "#4f5bdb",
  messageAction: "#4f5bdb",
  messageActionForeground: "#ffffff",
  accent: "#4f5bdb",
  accentForeground: "#ffffff",
  accentSurface: "rgb(79 91 219 / 10%)",
  accentSurfaceForeground: "#3641b8",
  error: "#ef4444",
  errorForeground: "#b91c1c",
  errorSurface: "rgb(239 68 68 / 10%)",
  warning: "#f59e0b",
  warningForeground: "#b45309",
  warningSurface: "rgb(245 158 11 / 12%)",
  codeBackground: "rgb(0 0 0 / 4%)",
  codeForeground: "#18181b",
};

export const UNO_DARK_THEME_COLORS: ThemeColors = {
  canvas: "#161616",
  text: "#f5f5f5",
  muted: "rgb(255 255 255 / 4%)",
  mutedForeground: "#a3a3a3",
  surface: "#1b1b1b",
  surfaceOverlay: "#1b1b1b",
  secondary: "rgb(255 255 255 / 4%)",
  secondaryForeground: "#f5f5f5",
  border: "rgb(255 255 255 / 8%)",
  input: "rgb(255 255 255 / 11%)",
  focus: "#4f6ef7",
  messageAction: "#7c86f8",
  messageActionForeground: "#ffffff",
  accent: "#7c86f8",
  accentForeground: "#ffffff",
  accentSurface: "rgb(124 134 248 / 14%)",
  accentSurfaceForeground: "#b4baff",
  error: "#ef4444",
  errorForeground: "#f87171",
  errorSurface: "rgb(239 68 68 / 14%)",
  warning: "#f59e0b",
  warningForeground: "#fbbf24",
  warningSurface: "rgb(245 158 11 / 14%)",
  codeBackground: "rgb(255 255 255 / 5%)",
  codeForeground: "#f5f5f5",
};
