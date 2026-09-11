/**
 * The control in the Settings header that answers "whose settings am I
 * editing?" and lets the user change the answer without leaving Settings.
 *
 * It lists the app itself first — the settings that belong to this copy on
 * this device and follow the user everywhere — then every environment the app
 * can address, each with its own live status. Switching keeps the current
 * section when the other scope has one by that name, and otherwise lands on
 * that scope's first page rather than inventing a section.
 *
 * @module components/settings/SettingsScopeSwitcher
 */
import { CheckIcon, ChevronDownIcon, LaptopIcon, MonitorIcon, ServerIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import { environmentAvailabilityLabel } from "~/environments/scope/availability";
import { useEnvironmentScopes } from "~/environments/scope/scopes";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  appSettingsPath,
  correspondingSectionForScope,
  environmentSettingsPath,
  parseSettingsScopeLocation,
  type AppSettingsSection,
  type EnvironmentSettingsSection,
} from "./settingsScopeRoutes";

const STATUS_DOT: Record<string, string> = {
  connected: "bg-emerald-500",
  reconnecting: "bg-amber-500 animate-pulse",
  offline: "bg-muted-foreground/50",
};

/** What this copy of the app is called in the scope list. */
export function appScopeLabel(platform: string | undefined = navigator.platform): string {
  if (platform.startsWith("Mac")) return "Uno Work on this Mac";
  if (platform.startsWith("Win")) return "Uno Work on this PC";
  return "Uno Work on this device";
}

export function SettingsScopeSwitcher({ pathname }: { readonly pathname: string }) {
  const navigate = useNavigate();
  const scopes = useEnvironmentScopes();
  const location = useMemo(() => parseSettingsScopeLocation(pathname), [pathname]);

  const activeEnvironmentScope =
    location.kind === "environment"
      ? (scopes.find((scope) => scope.environmentId === location.environmentId) ?? null)
      : null;

  const goToApp = useCallback(() => {
    const section = correspondingSectionForScope(location.section, "app") as AppSettingsSection;
    void navigate({ to: appSettingsPath(section), replace: true });
  }, [location.section, navigate]);

  const goToEnvironment = useCallback(
    (environmentId: Parameters<typeof environmentSettingsPath>[0]) => {
      const section = correspondingSectionForScope(
        location.section,
        "environment",
      ) as EnvironmentSettingsSection;
      void navigate({ to: environmentSettingsPath(environmentId, section), replace: true });
    },
    [location.section, navigate],
  );

  const triggerLabel =
    location.kind === "app"
      ? appScopeLabel()
      : (activeEnvironmentScope?.label ??
        // A URL naming an environment this device no longer has is a real
        // state, not something to silently replace with the active one.
        "Unknown machine");

  const TriggerIcon =
    location.kind === "app"
      ? MonitorIcon
      : activeEnvironmentScope?.placement === "remote"
        ? ServerIcon
        : LaptopIcon;

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="xs" variant="outline" aria-label="Change which settings you are editing" />
        }
      >
        <TriggerIcon className="size-3.5 text-muted-foreground" />
        <span className="max-w-48 truncate">{triggerLabel}</span>
        <ChevronDownIcon className="size-3.5 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-72">
        <MenuGroup>
          <MenuGroupLabel>This device</MenuGroupLabel>
          <MenuItem onClick={goToApp}>
            <MonitorIcon className="size-4 text-muted-foreground" />
            <span className="flex-1 truncate">{appScopeLabel()}</span>
            {location.kind === "app" ? <CheckIcon className="size-3.5" /> : null}
          </MenuItem>
        </MenuGroup>
        <MenuGroup>
          <MenuGroupLabel>Machines</MenuGroupLabel>
          {scopes.map((scope) => {
            const isActive = scope.environmentId === location.environmentId;
            const PlacementIcon = scope.placement === "remote" ? ServerIcon : LaptopIcon;
            return (
              <MenuItem
                key={scope.environmentId}
                onClick={() => goToEnvironment(scope.environmentId)}
              >
                <PlacementIcon className="size-4 text-muted-foreground" />
                <span className="flex-1 truncate">{scope.label}</span>
                <span className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      STATUS_DOT[scope.availability.status] ?? STATUS_DOT.offline,
                    )}
                  />
                  <span className="text-[11px] text-muted-foreground">
                    {environmentAvailabilityLabel(scope.availability.status)}
                  </span>
                </span>
                {isActive ? <CheckIcon className="size-3.5" /> : null}
              </MenuItem>
            );
          })}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
