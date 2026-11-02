/**
 * Reasoning, context and permissions behind one chip on Home's box (Misha
 * 01.11: "the buttons no longer fit", then "why hide reasoning and context,
 * show them tighter"): the chip says "High · 1M", the row short of room drops
 * the words and keeps the icon. A newcomer's first screen has room, so it keeps
 * the reasoning picker (Misha 28.10).
 */
import type { RuntimeMode } from "@t3tools/contracts";
import {
  LockIcon,
  LockOpenIcon,
  PenLineIcon,
  SlidersHorizontalIcon,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { PERMISSION_MODES, PERMISSION_MODE_ORDER, plainLabel } from "../../../plainLanguage";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../../ui/menu";

const RUNTIME_MODE_ICON: Record<RuntimeMode, LucideIcon> = {
  "approval-required": LockIcon,
  "auto-accept-edits": PenLineIcon,
  "full-access": LockOpenIcon,
};

export function HomeComposerSettings({
  traits,
  summary,
  runtimeMode,
  onRuntimeModeChange,
}: {
  /** The model's reasoning and speed; null while the model has none. */
  traits: ReactNode;
  /** The same in a few words: "High · 1M". */
  summary: string;
  runtimeMode: RuntimeMode;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        aria-label="Reasoning and permissions"
        title={[summary, PERMISSION_MODES[runtimeMode].label].filter(Boolean).join(" · ")}
        data-testid="home-composer-settings"
        className="flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-full px-2 text-xs whitespace-nowrap text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:h-7"
      >
        <SlidersHorizontalIcon className="size-3.5 shrink-0" />
        {summary ? (
          <span className="hidden @lg/chips:inline" data-testid="home-composer-settings-summary">
            {summary}
          </span>
        ) : null}
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-64">
        {traits ? (
          <>
            {traits}
            <MenuSeparator />
          </>
        ) : null}
        <MenuGroup>
          <MenuGroupLabel>{plainLabel("permissions")}</MenuGroupLabel>
          <MenuRadioGroup
            value={runtimeMode}
            onValueChange={(value) => onRuntimeModeChange(value as RuntimeMode)}
          >
            {PERMISSION_MODE_ORDER.map((mode) => {
              const Icon = RUNTIME_MODE_ICON[mode];
              return (
                <MenuRadioItem
                  key={mode}
                  value={mode}
                  className="py-2"
                  data-testid={`home-permission-${mode}`}
                >
                  <span className="grid min-w-0 gap-0.5">
                    <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                      {PERMISSION_MODES[mode].label}
                    </span>
                    <span className="text-xs leading-4 text-muted-foreground">
                      {PERMISSION_MODES[mode].consequence}
                    </span>
                  </span>
                </MenuRadioItem>
              );
            })}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
