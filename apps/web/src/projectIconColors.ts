// Ported from upstream T3 Code (apps/web/src/projectIconColors.ts): the
// palette of project monograms, without upstream's color picker labels.
export type ProjectIconColor =
  | "gray"
  | "red"
  | "orange"
  | "amber"
  | "yellow"
  | "lime"
  | "green"
  | "emerald"
  | "teal"
  | "cyan"
  | "sky"
  | "blue"
  | "indigo"
  | "violet"
  | "purple"
  | "fuchsia"
  | "pink"
  | "rose";

export const PROJECT_ICON_COLORS: ReadonlyArray<{
  readonly value: ProjectIconColor;
  readonly className: string;
}> = [
  { value: "gray", className: "text-gray-600 dark:text-gray-400" },
  { value: "red", className: "text-red-600 dark:text-red-400" },
  { value: "orange", className: "text-orange-600 dark:text-orange-400" },
  { value: "amber", className: "text-amber-600 dark:text-amber-400" },
  { value: "yellow", className: "text-yellow-600 dark:text-yellow-400" },
  { value: "lime", className: "text-lime-600 dark:text-lime-400" },
  { value: "green", className: "text-green-600 dark:text-green-400" },
  { value: "emerald", className: "text-emerald-600 dark:text-emerald-400" },
  { value: "teal", className: "text-teal-600 dark:text-teal-400" },
  { value: "cyan", className: "text-cyan-600 dark:text-cyan-400" },
  { value: "sky", className: "text-sky-600 dark:text-sky-400" },
  { value: "blue", className: "text-blue-600 dark:text-blue-400" },
  { value: "indigo", className: "text-indigo-600 dark:text-indigo-400" },
  { value: "violet", className: "text-violet-600 dark:text-violet-400" },
  { value: "purple", className: "text-purple-600 dark:text-purple-400" },
  { value: "fuchsia", className: "text-fuchsia-600 dark:text-fuchsia-400" },
  { value: "pink", className: "text-pink-600 dark:text-pink-400" },
  { value: "rose", className: "text-rose-600 dark:text-rose-400" },
];

const PROJECT_ICON_COLOR_CLASSES = Object.fromEntries(
  PROJECT_ICON_COLORS.map(({ value, className }) => [value, className]),
) as Record<ProjectIconColor, string>;

export function projectIconColorClassName(color: ProjectIconColor): string {
  return PROJECT_ICON_COLOR_CLASSES[color];
}
