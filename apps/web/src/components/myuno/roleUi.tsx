/**
 * How a computer's role looks everywhere on My Uno: its icon, its tint and
 * the small badge. An Uno Work computer reads as "Uno Work".
 */
import {
  BriefcaseIcon,
  FlaskConicalIcon,
  RocketIcon,
  ServerIcon,
  TestTubeDiagonalIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { ROLE_LABEL, type ComputerRole } from "../../account/computerRoles";
import { cn } from "../../lib/utils";

export const ROLE_ICON: Record<ComputerRole, ReactNode> = {
  workspace: <BriefcaseIcon />,
  server: <ServerIcon />,
  production: <RocketIcon />,
  staging: <TestTubeDiagonalIcon />,
  sandbox: <FlaskConicalIcon />,
};

export const ROLE_TINT: Record<ComputerRole, string> = {
  workspace: "bg-primary/10 text-primary",
  server: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  production: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  staging: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  sandbox: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
};

/** Text-only tint for a role word inside a row. */
export const ROLE_TEXT: Record<ComputerRole, string> = {
  workspace: "text-primary",
  server: "text-sky-600 dark:text-sky-400",
  production: "text-emerald-600 dark:text-emerald-400",
  staging: "text-amber-600 dark:text-amber-400",
  sandbox: "text-violet-600 dark:text-violet-400",
};

export function RoleBadge({ role }: { role: ComputerRole }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium [&_svg]:size-3",
        ROLE_TINT[role],
      )}
    >
      {ROLE_ICON[role]}
      {ROLE_LABEL[role]}
    </span>
  );
}
