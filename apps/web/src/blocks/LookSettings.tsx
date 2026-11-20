/**
 * Settings → General → Look (T55 demo): mode, accent, the sidebar's surface,
 * density and text size — every change shows at once — and a way into
 * the sidebar's edit mode.
 */
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, LayoutPanelLeftIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { useTheme } from "../hooks/useTheme";
import { cn } from "../lib/utils";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { useSidebarLayoutStore } from "./layoutStore";
import { ACCENTS, DEFAULT_LOOK, lookCss, useLookStore, type Look } from "./lookStore";

/** Puts the look's tokens on the page. Mounted once, in the app's shell. */
export function LookApplier() {
  const look = useLookStore((state) => state.look);
  useEffect(() => {
    let style = document.getElementById("uno-look") as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = "uno-look";
      document.head.append(style);
    }
    style.textContent = lookCss(look);
  }, [look]);
  return null;
}

function Segmented<T extends string>(props: {
  value: T;
  options: ReadonlyArray<{ value: T; label: ReactNode }>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={props.label}
      className="inline-flex rounded-lg border border-border bg-muted/60 p-0.5"
    >
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={props.value === option.value}
          onClick={() => props.onChange(option.value)}
          className={cn(
            "h-7 min-w-9 rounded-md px-2.5 text-xs font-medium",
            props.value === option.value
              ? "bg-background text-foreground shadow-xs"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A small picture of Work in a mode: sidebar, two rows, a card. */
function ModePreview(props: { dark: boolean; half?: boolean }) {
  const pane = (dark: boolean) => (
    <div className={cn("flex h-full w-full", dark ? "bg-neutral-900" : "bg-white")}>
      <div className={cn("w-[34%] space-y-1 p-1.5", dark ? "bg-neutral-950" : "bg-neutral-100")}>
        <div className="h-1.5 w-3/4 rounded-full bg-primary" />
        <div className={cn("h-1.5 rounded-full", dark ? "bg-white/15" : "bg-black/10")} />
        <div className={cn("h-1.5 w-2/3 rounded-full", dark ? "bg-white/15" : "bg-black/10")} />
      </div>
      <div className="flex-1 space-y-1.5 p-2">
        <div className={cn("h-2 w-2/3 rounded-full", dark ? "bg-white/25" : "bg-black/15")} />
        <div
          className={cn(
            "h-5 rounded-md border",
            dark ? "border-white/15 bg-white/5" : "border-black/10 bg-white",
          )}
        />
      </div>
    </div>
  );
  if (props.half) {
    return (
      <div className="relative h-full w-full">
        {pane(false)}
        <div className="absolute inset-0 [clip-path:polygon(100%_0,100%_100%,0_100%)]">
          {pane(true)}
        </div>
      </div>
    );
  }
  return pane(props.dark);
}

export function LookSection() {
  const { theme, setTheme } = useTheme();
  const look = useLookStore((state) => state.look);
  const setLook = useLookStore((state) => state.set);
  const resetLook = useLookStore((state) => state.reset);
  const setEditing = useSidebarLayoutStore((state) => state.setEditing);
  const navigate = useNavigate();
  const changed = (Object.keys(DEFAULT_LOOK) as Array<keyof Look>).some(
    (key) => look[key] !== DEFAULT_LOOK[key],
  );
  return (
    <SettingsSection
      title="Look"
      headerAction={
        changed || theme !== "system" ? (
          <button
            type="button"
            onClick={() => {
              resetLook();
              setTheme("system");
            }}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <RotateCcwIcon className="size-3" />
            Default look
          </button>
        ) : null
      }
    >
      <div className="px-4 py-4 sm:px-5" data-testid="look-modes">
        <p className="text-sm font-medium">Mode</p>
        <div className="mt-2.5 grid grid-cols-3 gap-3">
          {(
            [
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
              { value: "system", label: "Like the system" },
            ] as const
          ).map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setTheme(option.value)}
              className="group text-left"
              aria-pressed={theme === option.value}
            >
              <div
                className={cn(
                  "h-[74px] overflow-hidden rounded-xl border-2",
                  theme === option.value
                    ? "border-primary"
                    : "border-border group-hover:border-primary/40",
                )}
              >
                <ModePreview dark={option.value === "dark"} half={option.value === "system"} />
              </div>
              <span className="mt-1.5 flex items-center gap-1 text-xs font-medium">
                {theme === option.value ? <CheckIcon className="size-3 text-primary" /> : null}
                {option.label}
              </span>
            </button>
          ))}
        </div>
      </div>
      <SettingsRow
        title="Accent"
        description="Buttons, links, the open chat and widgets that follow Uno Work's look."
        control={
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Accent">
            {ACCENTS.map((accent) => (
              <button
                key={accent.id}
                type="button"
                role="radio"
                aria-checked={look.accent === accent.id}
                aria-label={accent.label}
                title={accent.label}
                onClick={() => setLook({ accent: accent.id })}
                className={cn(
                  "inline-flex size-7 items-center justify-center rounded-full ring-offset-2 ring-offset-card",
                  look.accent === accent.id && "ring-2 ring-foreground/70",
                )}
                style={{ background: accent.hex }}
              >
                {look.accent === accent.id ? <CheckIcon className="size-3.5 text-white" /> : null}
              </button>
            ))}
          </div>
        }
      />
      <SettingsRow
        title="Sidebar"
        description="Plain grey, or tinted with the accent."
        control={
          <Segmented
            label="Sidebar surface"
            value={look.sidebar}
            onChange={(sidebar) => setLook({ sidebar })}
            options={[
              { value: "plain", label: "Plain" },
              { value: "tinted", label: "Tinted" },
            ]}
          />
        }
      />
      <SettingsRow
        title="Density"
        description="Compact fits more chats on the screen."
        control={
          <Segmented
            label="Density"
            value={look.density}
            onChange={(density) => setLook({ density })}
            options={[
              { value: "comfortable", label: "Comfortable" },
              { value: "compact", label: "Compact" },
            ]}
          />
        }
      />
      <SettingsRow
        title="Text size"
        description="Everything scales: chats, sidebar, settings."
        control={
          <Segmented
            label="Text size"
            value={look.textSize}
            onChange={(textSize) => setLook({ textSize })}
            options={[
              { value: "s", label: <span className="text-[11px]">Aa</span> },
              { value: "m", label: <span className="text-[13px]">Aa</span> },
              { value: "l", label: <span className="text-[15px]">Aa</span> },
            ]}
          />
        }
      />
      <SettingsRow
        title="Sidebar blocks"
        description="Choose what the sidebar shows and in what order: Needs you, Pinned, your apps' widgets…"
        control={
          <button
            type="button"
            onClick={() => {
              setEditing(true);
              void navigate({ to: "/" });
            }}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-medium hover:border-primary/50"
            data-testid="look-customize-sidebar"
          >
            <LayoutPanelLeftIcon className="size-3.5" />
            Customize sidebar
          </button>
        }
      />
    </SettingsSection>
  );
}
