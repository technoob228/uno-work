import { RotateCcwIcon } from "lucide-react";
import {
  Outlet,
  createFileRoute,
  redirect,
  useCanGoBack,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { useSettingsRestore } from "../components/settings/SettingsPanels";
import { SettingsScopeSwitcher } from "../components/settings/SettingsScopeSwitcher";
import { settingsLandingPath } from "../components/settings/settingsScopeRoutes";
import {
  SettingsScopeBadgeContext,
  settingsScopeBadgeInfo,
  useSettingsScopeModel,
} from "../components/settings/useSettingsScope";
import { Button } from "../components/ui/button";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { isElectron } from "../env";
import { readPrimaryEnvironmentDescriptor } from "../environments/primary";
import { useSavedEnvironmentRegistryStore } from "../environments/runtime";
import { useUiStateStore } from "../uiStateStore";
import { LITE_HOME_PATH } from "../lite/webLite";

function RestoreDefaultsButton({ onRestored }: { onRestored: () => void }) {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(onRestored);

  return (
    <Button
      size="xs"
      variant="outline"
      disabled={changedSettingLabels.length === 0}
      onClick={() => void restoreDefaults()}
    >
      <RotateCcwIcon className="size-3.5" />
      Restore defaults
    </Button>
  );
}

/**
 * The one-line hint queued by a scope switch that could not keep the section.
 * Shown only on the page the switch landed on; moving anywhere else clears it.
 */
function ScopeSwitchNotice({ pathname }: { readonly pathname: string }) {
  const notice = useUiStateStore((state) => state.settingsScopeNotice);
  const setNotice = useUiStateStore((state) => state.setSettingsScopeNotice);
  const isForThisPage = notice !== null && notice.pathname === pathname;

  useEffect(() => {
    if (notice !== null && !isForThisPage) setNotice(null);
  }, [isForThisPage, notice, setNotice]);

  if (!isForThisPage) return null;
  return (
    <p
      role="status"
      className="border-b border-border bg-muted/40 px-5 py-1.5 text-xs text-muted-foreground"
    >
      {notice.message}
    </p>
  );
}

function SettingsContentLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const [restoreSignal, setRestoreSignal] = useState(0);
  const scopeModel = useSettingsScopeModel(location.pathname);
  const badgeInfo = settingsScopeBadgeInfo(scopeModel);
  // Restoring defaults only ever resets this device's own preferences, so it
  // is offered on the app scope's general page and nowhere else — a button
  // that could mean "reset a daemon" depending on the page would be worse
  // than no button.
  const showRestoreDefaults = location.pathname === "/settings/app/general";
  const handleRestored = () => setRestoreSignal((value) => value + 1);
  const navigateBackWithinApp = useCallback(() => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, navigate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        navigateBackWithinApp();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [navigateBackWithinApp]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {!isElectron && (
          <header className="border-b border-border px-3 py-2 sm:px-5">
            <div className="flex min-h-7 flex-wrap items-center gap-2 sm:min-h-6">
              <SidebarTrigger className="size-7 shrink-0 md:hidden" />
              <span className="text-sm font-medium text-foreground">Settings</span>
              {/* The browser build serves one machine, so the control mostly
                  reads "This app | <that box>" — still the one place that
                  says which of the two a page belongs to. */}
              <div className="ms-1 min-w-0">
                <SettingsScopeSwitcher model={scopeModel} />
              </div>
              {showRestoreDefaults ? (
                <div className="ms-auto flex items-center gap-2">
                  <RestoreDefaultsButton onRestored={handleRestored} />
                </div>
              ) : null}
            </div>
          </header>
        )}

        {isElectron && (
          <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5 wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]">
            <span className="text-xs font-medium tracking-wide text-muted-foreground/70">
              Settings
            </span>
            <div className="no-drag ms-3 min-w-0">
              <SettingsScopeSwitcher model={scopeModel} />
            </div>
            {showRestoreDefaults ? (
              <div className="no-drag ms-auto flex items-center gap-2">
                <RestoreDefaultsButton onRestored={handleRestored} />
              </div>
            ) : null}
          </div>
        )}

        <ScopeSwitchNotice pathname={location.pathname} />

        <SettingsScopeBadgeContext.Provider value={badgeInfo}>
          <div key={restoreSignal} className="min-h-0 flex flex-1 flex-col">
            <Outlet />
          </div>
        </SettingsScopeBadgeContext.Provider>
      </div>
    </SidebarInset>
  );
}

function SettingsRouteLayout() {
  return <SettingsContentLayout />;
}

export const Route = createFileRoute("/settings")({
  beforeLoad: async ({ context, location }) => {
    // Web lite: settings belong to a machine; the account lives in My Uno.
    if (context.authGateState.status === "account-only") {
      throw redirect({ to: LITE_HOME_PATH, replace: true });
    }
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }

    if (location.pathname === "/settings") {
      // Come back to the machine the user was configuring last, as long as
      // the app still knows it; otherwise the app's own general page.
      const primaryId = readPrimaryEnvironmentDescriptor()?.environmentId ?? null;
      const savedIds = Object.values(useSavedEnvironmentRegistryStore.getState().byId).map(
        (record) => record.environmentId,
      );
      throw redirect({
        to: settingsLandingPath({
          memory: useUiStateStore.getState().settingsScopeMemory,
          knownEnvironmentIds: primaryId ? [primaryId, ...savedIds] : savedIds,
        }),
        replace: true,
      });
    }
  },
  component: SettingsRouteLayout,
});
