import { useCallback, useMemo, type ComponentType } from "react";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  BotIcon,
  GitBranchIcon,
  GlobeIcon,
  KeyRoundIcon,
  Link2Icon,
  PlugIcon,
  PuzzleIcon,
  Settings2Icon,
} from "lucide-react";
import { useCanGoBack, useNavigate } from "@tanstack/react-router";

import { isWebApp } from "../../webMode";

import {
  appSettingsPath,
  environmentSettingsPath,
  parseSettingsScopeLocation,
  type AppSettingsSection,
  type EnvironmentSettingsSection,
} from "./settingsScopeRoutes";

import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "../ui/sidebar";

/**
 * The nav lists the sections of whichever scope the URL names: this device's
 * own settings, or one environment's. A section from the other scope is never
 * shown, so there is no way to click from "my theme" straight into a daemon's
 * providers without noticing the machine changed.
 */
const APP_NAV_ITEMS: ReadonlyArray<{
  label: string;
  section: AppSettingsSection;
  icon: ComponentType<{ className?: string }>;
}> = [
  { label: "General", section: "general", icon: Settings2Icon },
  { label: "Connections", section: "connections", icon: Link2Icon },
  { label: "Browser", section: "browser", icon: GlobeIcon },
];

const ENVIRONMENT_NAV_ITEMS: ReadonlyArray<{
  label: string;
  section: EnvironmentSettingsSection;
  icon: ComponentType<{ className?: string }>;
}> = [
  { label: "General", section: "general", icon: Settings2Icon },
  { label: "Providers", section: "providers", icon: PlugIcon },
  { label: "Assistants", section: "assistants", icon: BotIcon },
  { label: "Source Control", section: "source-control", icon: GitBranchIcon },
  { label: "Archive", section: "archived", icon: ArchiveIcon },
];

/**
 * Vault (credentials) and Extensions (plugins) operate on the active
 * WS-connected box rather than a path-named environment, so they are not part
 * of the scope split above. They ride along in the app-scope nav as direct
 * links; Credentials is web-only, matching the desktop shell where it has no
 * meaning.
 */
type FlatNavItem = { label: string; to: string; icon: ComponentType<{ className?: string }> };
const FLAT_APP_NAV_ITEMS: ReadonlyArray<FlatNavItem> = [
  ...(isWebApp
    ? [{ label: "Credentials", to: "/settings/vault", icon: KeyRoundIcon } as FlatNavItem]
    : []),
  { label: "Extensions", to: "/settings/extensions", icon: PuzzleIcon },
];

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { isMobile, setOpenMobile } = useSidebar();
  const location = useMemo(() => parseSettingsScopeLocation(pathname), [pathname]);
  const items = useMemo(() => {
    const environmentId = location.environmentId;
    if (location.kind === "environment" && environmentId) {
      return ENVIRONMENT_NAV_ITEMS.map((item) => ({
        label: item.label,
        icon: item.icon,
        to: environmentSettingsPath(environmentId, item.section),
      }));
    }
    return [
      ...APP_NAV_ITEMS.map((item) => ({
        label: item.label,
        icon: item.icon,
        to: appSettingsPath(item.section),
      })),
      ...FLAT_APP_NAV_ITEMS.map((item) => ({
        label: item.label,
        icon: item.icon,
        to: item.to,
      })),
    ];
  }, [location.environmentId, location.kind]);
  const handleSectionClick = useCallback(
    (to: string) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({ to, replace: true });
    },
    [isMobile, navigate, setOpenMobile],
  );
  const handleBackClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, isMobile, navigate, setOpenMobile]);

  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup className="px-2 py-3">
          <SidebarMenu>
            {items.map((item) => {
              const Icon = item.icon;
              const isActive = pathname === item.to;
              return (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    size="sm"
                    isActive={isActive}
                    className={
                      isActive
                        ? "gap-2.5 px-2.5 py-2 text-left text-[13px] font-medium text-foreground"
                        : "gap-2.5 px-2.5 py-2 text-left text-[13px] text-muted-foreground/70 hover:text-foreground/80"
                    }
                    onClick={() => handleSectionClick(item.to)}
                  >
                    <Icon
                      className={
                        isActive
                          ? "size-4 shrink-0 text-foreground"
                          : "size-4 shrink-0 text-muted-foreground/60"
                      }
                    />
                    <span className="truncate">{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarSeparator />
      <SidebarFooter className="p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="gap-2 px-2 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={handleBackClick}
            >
              <ArrowLeftIcon className="size-4" />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}
