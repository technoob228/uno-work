import {
  HTML_RENDER_DEFAULT_FONTS,
  htmlRenderTheme,
  type HtmlRenderTheme,
} from "@t3tools/shared/htmlRender";
import {
  UNO_DARK_THEME_COLORS,
  UNO_LIGHT_THEME_COLORS,
  type ThemeAppearance,
  type ThemeColors,
} from "@t3tools/shared/themePalettes";
import { useMemo } from "react";

import { useTheme } from "./useTheme";

/** The app's tokens as they are right now; a page's `--accent` is the brand color (`--primary` here). */
function readAppThemeColors(appearance: ThemeAppearance): ThemeColors {
  const base = appearance === "light" ? UNO_LIGHT_THEME_COLORS : UNO_DARK_THEME_COLORS;
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  const primary = token("--primary", base.accent);
  return {
    ...base,
    canvas: token("--background", base.canvas),
    text: token("--foreground", base.text),
    muted: token("--muted", base.muted),
    mutedForeground: token("--muted-foreground", base.mutedForeground),
    surface: token("--card", base.surface),
    surfaceOverlay: token("--popover", base.surfaceOverlay),
    secondary: token("--secondary", base.secondary),
    secondaryForeground: token("--secondary-foreground", base.secondaryForeground),
    border: token("--border", base.border),
    input: token("--input", base.input),
    focus: token("--ring", base.focus),
    messageAction: primary,
    messageActionForeground: token("--primary-foreground", base.messageActionForeground),
    accent: primary,
    accentForeground: token("--primary-foreground", base.accentForeground),
    error: token("--destructive", base.error),
    errorForeground: token("--destructive-foreground", base.errorForeground),
    warning: token("--warning", base.warning),
    warningForeground: token("--warning-foreground", base.warningForeground),
  };
}

/** What a page in the chat wears: the app's own theme, light or dark as the app is. */
export function useHtmlRenderTheme(): HtmlRenderTheme {
  const { resolvedTheme } = useTheme();
  return useMemo(
    () =>
      htmlRenderTheme(readAppThemeColors(resolvedTheme), resolvedTheme, HTML_RENDER_DEFAULT_FONTS),
    [resolvedTheme],
  );
}
