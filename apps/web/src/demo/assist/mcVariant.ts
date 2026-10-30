/**
 * Multi-computer variants (28.10): which variant this build is. Each variant
 * branch (demo/multi-computer-<id>-1028) sets its own here; the "what to look
 * at" card shows the title and the hint, Playwright flows read the id.
 */
export const MC_VARIANT = {
  id: "final",
  title: "C + пространства в настройках",
  hint: "По умолчанию все компьютеры справа сверху (C). Settings → General → «A separate space for each computer»: каждая машина — своя вселенная, переключение полоской слева или вкладкой справа сверху.",
} as const;
