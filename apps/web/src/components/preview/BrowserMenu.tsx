/**
 * The browser tab's ⋯ (Misha 28.10): everything of the browser in one menu,
 * grouped like Chrome's — zoom with − 100% + right in it (the menu stays
 * open while you click), passwords, developer tools, device size, data, and
 * the browser's settings. It replaced a flat native list where every "Zoom
 * in" closed the menu and the current zoom was nowhere to be seen.
 */
import type { CredentialMetadata } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  CameraIcon,
  CodeXmlIcon,
  EraserIcon,
  KeyRoundIcon,
  MessageSquarePlusIcon,
  MinusIcon,
  MonitorSmartphoneIcon,
  MoreVerticalIcon,
  MousePointerClickIcon,
  PlusIcon,
  RotateCwIcon,
  SettingsIcon,
} from "lucide-react";

import { useFeatureFlag } from "../../hooks/useFeatureFlags";
import { cn } from "../../lib/utils";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { isDefaultPageZoom, PAGE_ZOOM_MAX, PAGE_ZOOM_MIN, pageZoomLabel } from "./pageZoom";

export type BrowserDevice = "off" | "responsive" | "mobile" | "tablet" | "desktop";
export type BrowserClearKind = "cache" | "cookies" | "all";

export const BROWSER_DEVICE_SIZES: Record<
  Exclude<BrowserDevice, "off" | "responsive">,
  { readonly width: number; readonly height: number }
> = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 },
};

/** Which item of "Device size" the tab's device toolbar is on. */
export function browserDeviceOf(input: {
  readonly toolbarOpen: boolean;
  readonly size: { readonly width: number; readonly height: number } | null;
}): BrowserDevice {
  if (!input.toolbarOpen) return "off";
  if (!input.size) return "responsive";
  for (const [id, size] of Object.entries(BROWSER_DEVICE_SIZES)) {
    if (size.width === input.size.width && size.height === input.size.height) {
      return id as BrowserDevice;
    }
  }
  return "responsive";
}

export interface BrowserMenuProps {
  readonly disabled?: boolean;
  /** The page zoom; absent where the page can't be zoomed (the agent's browser). */
  readonly zoom?: {
    readonly factor: number;
    readonly onStep: (direction: 1 | -1) => void;
    readonly onReset: () => void;
  };
  /** Saved logins of this site; the key fills one in. */
  readonly logins: ReadonlyArray<CredentialMetadata>;
  readonly onFillLogin: (credential: CredentialMetadata) => void;
  /** Developer tools; absent where they don't reach the page. */
  readonly devtools?: {
    readonly open: boolean;
    readonly commenting: boolean;
    readonly onToggle: () => void;
    readonly onComment: () => void;
  };
  readonly device?: {
    readonly current: BrowserDevice;
    readonly onPick: (device: BrowserDevice) => void;
  };
  readonly onScreenshot?: () => void;
  readonly onHardReload?: () => void;
  /** Clearing cache and cookies (the desktop app's own browser). */
  readonly onClear?: (kind: BrowserClearKind) => void;
  readonly onOpenInAgentBrowser?: () => void;
  readonly triggerClassName?: string;
}

export function BrowserMenu(props: BrowserMenuProps) {
  const navigate = useNavigate();
  const vault = useFeatureFlag("vault");
  const { zoom, devtools, device } = props;
  const pageGroup = props.onScreenshot || props.onHardReload || device;
  return (
    <Menu>
      <MenuTrigger
        disabled={props.disabled}
        aria-label="More actions"
        title="More actions"
        data-testid="browser-more-menu"
        className={cn(
          "inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 data-popup-open:bg-accent data-popup-open:text-foreground",
          props.triggerClassName,
        )}
      >
        <MoreVerticalIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" className="w-64" data-testid="browser-menu">
        {zoom ? (
          <>
            <div
              className="flex min-h-8 items-center gap-1 px-2 text-sm sm:min-h-7"
              data-testid="browser-menu-zoom"
            >
              <span className="flex-1 text-foreground">Zoom</span>
              <ZoomButton
                label="Zoom out"
                disabled={zoom.factor <= PAGE_ZOOM_MIN + 0.001}
                onClick={() => zoom.onStep(-1)}
              >
                <MinusIcon className="size-3.5" />
              </ZoomButton>
              <button
                type="button"
                onClick={zoom.onReset}
                title="Back to 100%"
                data-testid="browser-menu-zoom-value"
                className={cn(
                  "h-6 w-12 rounded text-center text-xs tabular-nums hover:bg-accent",
                  isDefaultPageZoom(zoom.factor)
                    ? "text-muted-foreground"
                    : "font-medium text-foreground",
                )}
              >
                {pageZoomLabel(zoom.factor)}
              </button>
              <ZoomButton
                label="Zoom in"
                disabled={zoom.factor >= PAGE_ZOOM_MAX - 0.001}
                onClick={() => zoom.onStep(1)}
              >
                <PlusIcon className="size-3.5" />
              </ZoomButton>
            </div>
            <MenuSeparator />
          </>
        ) : null}
        <MenuGroup>
          {props.logins.map((credential) => (
            <MenuItem key={credential.id} onClick={() => props.onFillLogin(credential)}>
              <KeyRoundIcon />
              <span className="min-w-0 truncate">Fill in {credential.username}</span>
            </MenuItem>
          ))}
          <MenuItem
            onClick={() =>
              void navigate({
                to: vault ? "/settings/vault" : "/settings/app/browser",
              })
            }
          >
            <KeyRoundIcon className="opacity-50" />
            Passwords…
          </MenuItem>
        </MenuGroup>
        {devtools ? (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuCheckboxItem
                variant="switch"
                checked={devtools.open}
                onCheckedChange={devtools.onToggle}
                data-testid="browser-menu-devtools"
              >
                <span className="flex items-center gap-2">
                  <CodeXmlIcon className="opacity-80" />
                  Developer tools
                </span>
              </MenuCheckboxItem>
              <MenuItem onClick={devtools.onComment}>
                <MessageSquarePlusIcon />
                {devtools.commenting ? "Stop commenting" : "Comment on the page"}
                <MenuShortcut>C</MenuShortcut>
              </MenuItem>
            </MenuGroup>
          </>
        ) : null}
        {pageGroup ? (
          <>
            <MenuSeparator />
            <MenuGroup>
              {device ? (
                <MenuSub>
                  <MenuSubTrigger>
                    <MonitorSmartphoneIcon />
                    Device size
                  </MenuSubTrigger>
                  <MenuSubPopup className="w-52">
                    <MenuRadioGroup
                      value={device.current}
                      onValueChange={(value) => device.onPick(value as BrowserDevice)}
                    >
                      <MenuRadioItem value="off">Fit the panel</MenuRadioItem>
                      <MenuRadioItem value="responsive">Responsive</MenuRadioItem>
                      <MenuRadioItem value="mobile">Mobile 390 × 844</MenuRadioItem>
                      <MenuRadioItem value="tablet">Tablet 768 × 1024</MenuRadioItem>
                      <MenuRadioItem value="desktop">Desktop 1280 × 800</MenuRadioItem>
                    </MenuRadioGroup>
                  </MenuSubPopup>
                </MenuSub>
              ) : null}
              {props.onScreenshot ? (
                <MenuItem onClick={props.onScreenshot}>
                  <CameraIcon />
                  Take a screenshot
                </MenuItem>
              ) : null}
              {props.onHardReload ? (
                <MenuItem onClick={props.onHardReload}>
                  <RotateCwIcon />
                  Reload without cache
                </MenuItem>
              ) : null}
            </MenuGroup>
          </>
        ) : null}
        {props.onClear || props.onOpenInAgentBrowser ? (
          <>
            <MenuSeparator />
            <MenuGroup>
              {props.onClear ? (
                <MenuSub>
                  <MenuSubTrigger>
                    <EraserIcon />
                    Clear browsing data
                  </MenuSubTrigger>
                  <MenuSubPopup className="w-56">
                    <MenuItem onClick={() => props.onClear?.("cookies")}>
                      Cookies for this site
                    </MenuItem>
                    <MenuItem onClick={() => props.onClear?.("cache")}>Cache</MenuItem>
                    <MenuItem onClick={() => props.onClear?.("all")}>Cookies and cache</MenuItem>
                  </MenuSubPopup>
                </MenuSub>
              ) : null}
              {props.onOpenInAgentBrowser ? (
                <MenuItem onClick={props.onOpenInAgentBrowser}>
                  <MousePointerClickIcon />
                  Open in agent's browser
                </MenuItem>
              ) : null}
            </MenuGroup>
          </>
        ) : null}
        <MenuSeparator />
        <MenuItem onClick={() => void navigate({ to: "/settings/app/browser" })}>
          <SettingsIcon />
          Browser settings
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function ZoomButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-6 items-center justify-center rounded border border-border text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}
