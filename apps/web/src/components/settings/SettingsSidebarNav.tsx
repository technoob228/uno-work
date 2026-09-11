import { useCallback, useMemo, type ComponentType } from "react";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  BotIcon,
  CircleUserIcon,
  FlaskConicalIcon,
  GitBranchIcon,
  GlobeIcon,
  KeyRoundIcon,
  LayersIcon,
  Link2Icon,
  PlugIcon,
  PuzzleIcon,
  Settings2Icon,
} from "lucide-react";
import { useCanGoBack, useNavigate } from "@tanstack/react-router";

import { isWebApp } from "../../webMode";
import { usePrimaryEnvironmentId } from "~/environments/primary";
import { type FeatureFlagKey, resolveFeatureFlag } from "../../featureFlags";
import { useFeatureFlagOverrides } from "../../hooks/useFeatureFlags";

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
  /** When set, the entry is hidden unless this feature flag is enabled. */
  flag?: FeatureFlagKey;
}> = [
  { label: "General", section: "general", icon: Settings2Icon },
  { label: "Connections", section: "connections", icon: Link2Icon },
  { label: "Browser", section: "browser", icon: GlobeIcon, flag: "browserCompanion" },
  { label: "Labs", section: "labs", icon: FlaskConicalIcon },
];

const ENVIRONMENT_NAV_ITEMS: ReadonlyArray<{
  label: string;
  section: EnvironmentSettingsSection;
  icon: ComponentType<{ className?: string }>;
}> = [
  { label: "General", section: "general", icon: Settings2Icon },
  { label: "Agents", section: "providers", icon: PlugIcon },
  { label: "Assistants", section: "assistants", icon: BotIcon },
  { label: "Source Control", section: "source-control", icon: GitBranchIcon },
  { label: "Archive", section: "archived", icon: ArchiveIcon },
];

/**
 * Vault (credentials) and Extensions (plugins) operate on the active
 * WS-connected box rather than a path-named environment, so they are not part
 * of the scope split above. They ride along in the app-scope nav as direct
 * links. Credentials видны в обеих оболочках: хранилище держит демон, поэтому
 * один и тот же логин доступен и в браузерной версии, и в десктопе.
 */
type FlatNavItem = {
  label: string;
  to: string;
  icon: ComponentType<{ className?: string }>;
  /** When set, the entry is hidden unless this feature flag is enabled. */
  flag?: FeatureFlagKey;
};
const FLAT_APP_NAV_ITEMS: ReadonlyArray<FlatNavItem> = [
  { label: "Credentials", to: "/settings/vault", icon: KeyRoundIcon, flag: "vault" },
  // The machines list is always on; the `workspace` flag now only gates the
  // "Advanced sharing" fold inside the page.
  { label: "My machines", to: "/settings/workspace", icon: LayersIcon },
  { label: "Extensions", to: "/settings/extensions", icon: PuzzleIcon, flag: "plugins" },
];

/**
 * The browser build talks to exactly one execution environment — the box
 * daemon that serves the page — so the desktop device-vs-environment split is
 * meaningless here. Instead of a scope toggle, web mode shows one flat list
 * that folds the app-scope pages together with that single environment's own
 * pages (its providers, its Uno account, its assistants). Every environment
 * entry resolves to the primary environment id, so provider/gateway/model
 * settings read and write the one daemon that actually runs the harness.
 */
type WebNavItem =
  | {
      readonly label: string;
      readonly icon: ComponentType<{ className?: string }>;
      readonly scope: "app";
      readonly section: AppSettingsSection;
      readonly flag?: FeatureFlagKey;
    }
  | {
      readonly label: string;
      readonly icon: ComponentType<{ className?: string }>;
      readonly scope: "environment";
      readonly section: EnvironmentSettingsSection;
      readonly flag?: FeatureFlagKey;
    };

const WEB_NAV_ITEMS: ReadonlyArray<WebNavItem> = [
  { label: "General", icon: Settings2Icon, scope: "app", section: "general" },
  { label: "Account", icon: CircleUserIcon, scope: "environment", section: "general" },
  { label: "Agents", icon: PlugIcon, scope: "environment", section: "providers" },
  { label: "Assistants", icon: BotIcon, scope: "environment", section: "assistants" },
  { label: "Connections", icon: Link2Icon, scope: "app", section: "connections" },
  {
    label: "Source Control",
    icon: GitBranchIcon,
    scope: "environment",
    section: "source-control",
  },
  { label: "Browser", icon: GlobeIcon, scope: "app", section: "browser", flag: "browserCompanion" },
  { label: "Archive", icon: ArchiveIcon, scope: "environment", section: "archived" },
  { label: "Labs", icon: FlaskConicalIcon, scope: "app", section: "labs" },
];

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { isMobile, setOpenMobile } = useSidebar();
  const location = useMemo(() => parseSettingsScopeLocation(pathname), [pathname]);
  const flagOverrides = useFeatureFlagOverrides();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const items = useMemo(() => {
    const isVisible = (flag: FeatureFlagKey | undefined) =>
      flag === undefined || resolveFeatureFlag(flagOverrides, flag);

    // Browser build: one flat list, no scope split. Environment pages point at
    // the single primary environment so the box's providers and Uno gateway
    // key are reachable and resolve to the daemon that runs the harness.
    if (isWebApp) {
      const flatItems = FLAT_APP_NAV_ITEMS.filter((item) => isVisible(item.flag)).map((item) => ({
        label: item.label,
        icon: item.icon,
        to: item.to,
      }));
      return [
        ...WEB_NAV_ITEMS.filter((item) => isVisible(item.flag))
          // Environment pages need the primary id; before it has bootstrapped
          // we simply omit them rather than build a broken path.
          .filter((item) => item.scope === "app" || primaryEnvironmentId !== null)
          .map((item) => ({
            label: item.label,
            icon: item.icon,
            to:
              item.scope === "app"
                ? appSettingsPath(item.section)
                : environmentSettingsPath(primaryEnvironmentId!, item.section),
          })),
        ...flatItems,
      ];
    }

    const environmentId = location.environmentId;
    if (location.kind === "environment" && environmentId) {
      return ENVIRONMENT_NAV_ITEMS.map((item) => ({
        label: item.label,
        icon: item.icon,
        to: environmentSettingsPath(environmentId, item.section),
      }));
    }
    return [
      ...APP_NAV_ITEMS.filter((item) => isVisible(item.flag)).map((item) => ({
        label: item.label,
        icon: item.icon,
        to: appSettingsPath(item.section),
      })),
      ...FLAT_APP_NAV_ITEMS.filter((item) => isVisible(item.flag)).map((item) => ({
        label: item.label,
        icon: item.icon,
        to: item.to,
      })),
    ];
  }, [flagOverrides, location.environmentId, location.kind, primaryEnvironmentId]);
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
