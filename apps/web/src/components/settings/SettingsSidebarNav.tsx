import { useCallback, useMemo } from "react";
import { ArrowLeftIcon, ChevronDownIcon } from "lucide-react";
import { useCanGoBack, useNavigate } from "@tanstack/react-router";

import { isWebApp } from "../../webMode";
import { type FeatureFlagKey, resolveFeatureFlag } from "../../featureFlags";
import { useFeatureFlagOverrides } from "../../hooks/useFeatureFlags";
import { cn } from "../../lib/utils";

import { Menu, MenuGroup, MenuGroupLabel, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "../ui/sidebar";
import { MachineMenuItems, MachineStatusDot } from "./SettingsScopeSwitcher";
import { buildSettingsNavGroups, type SettingsNavGroup } from "./settingsNavGroups";
import { useSettingsScopeModel, type SettingsScopeModel } from "./useSettingsScope";

/**
 * The nav shows two groups at once: the entries that belong to this app
 * wherever it runs, and the entries that belong to one machine — headed by
 * that machine's name, so it is obvious which pages change when the machine
 * at the top of Settings changes. Routes and section ids are unchanged.
 */
export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { isMobile, setOpenMobile } = useSidebar();
  const flagOverrides = useFeatureFlagOverrides();
  const model = useSettingsScopeModel(pathname);
  const { location, selectedMachine, unknownMachine } = model;

  const groups = useMemo(() => {
    const isFlagEnabled = (flag: FeatureFlagKey | undefined) =>
      flag === undefined || resolveFeatureFlag(flagOverrides, flag);
    // A URL naming a machine this device no longer has still gets its group,
    // so the nav matches the page rather than pretending the page is not open.
    const machine =
      unknownMachine && location.environmentId
        ? { environmentId: location.environmentId, label: "Unknown machine" }
        : selectedMachine
          ? { environmentId: selectedMachine.environmentId, label: selectedMachine.label }
          : null;
    return buildSettingsNavGroups({ isWebApp, isFlagEnabled, machine });
  }, [flagOverrides, location.environmentId, selectedMachine, unknownMachine]);

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
        {groups.map((group) => (
          <SidebarGroup key={group.kind} className="px-2 py-2 first:pt-3">
            <NavGroupHeading group={group} model={model} />
            <SidebarMenu>
              {group.entries.map((item) => {
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
        ))}
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

const GROUP_HEADING_CLASS =
  "h-6 px-2.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60";

/**
 * The machine group's heading doubles as a picker when there is more than one
 * machine, so the selector at the top of Settings is reflected right where
 * the per-machine entries live.
 */
function NavGroupHeading({
  group,
  model,
}: {
  readonly group: SettingsNavGroup;
  readonly model: SettingsScopeModel;
}) {
  if (group.kind === "app") {
    return <SidebarGroupLabel className={GROUP_HEADING_CLASS}>{group.heading}</SidebarGroupLabel>;
  }

  const machine =
    model.machines.find((candidate) => candidate.environmentId === group.environmentId) ?? null;
  const heading = (
    <>
      <span className="truncate">{group.heading}</span>
      {machine ? <MachineStatusDot status={machine.status} className="ms-1.5" /> : null}
    </>
  );

  if (model.machines.length <= 1) {
    return (
      <SidebarGroupLabel className={cn(GROUP_HEADING_CLASS, "gap-0")}>{heading}</SidebarGroupLabel>
    );
  }

  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarGroupLabel
            render={<button type="button" aria-label="Choose which machine to configure" />}
            className={cn(
              GROUP_HEADING_CLASS,
              "w-full cursor-pointer gap-0 hover:text-foreground/80 focus-visible:ring-2",
            )}
          />
        }
      >
        {heading}
        <ChevronDownIcon className="ms-auto size-3.5 shrink-0" />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-64">
        <MenuGroup>
          <MenuGroupLabel>Configure which machine?</MenuGroupLabel>
          <MachineMenuItems
            machines={model.machines}
            activeEnvironmentId={group.environmentId}
            onPick={(picked) =>
              model.switchTo({ kind: "environment", environmentId: picked.environmentId })
            }
          />
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
