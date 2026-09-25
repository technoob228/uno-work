/**
 * The first screen in the browser, inside the app (the sidebar with
 * "Set up 0/8" stays on the left): this is your computer, and two ways to
 * use it — just a computer (a three-stop tour) or a computer with AI (the
 * eight steps). "Use your own tools" opens the agent / SSH dialog.
 */
import { ArrowRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { getClientSettings, useUpdateSettings } from "../../../hooks/useSettings";
import { useServerConfig } from "../../../rpc/serverState";
import { WorkWelcomeStep } from "../../onboarding/steps/web/WorkWelcomeStep";
import { Button } from "../../ui/button";
import { OwnToolsDialog, type OwnToolsTab } from "../OwnToolsDialog";
import { SetupFrame } from "../SetupShell";
import { useSetupNavigation } from "../useSetupNavigation";
import { useWelcomeActions, type WelcomeMode } from "../useWelcomeActions";

export function WelcomeStep() {
  const [mode, setMode] = useState<WelcomeMode>("ai");
  const [ownTools, setOwnTools] = useState<OwnToolsTab | null>(null);
  const welcome = useWelcomeActions();
  const { updateSettings } = useUpdateSettings();
  const { goHome } = useSetupNavigation();

  // Welcome is remembered per machine too: the same computer opened from
  // another address or device (its own local settings) goes straight in.
  const machineOnboarded = useServerConfig()?.settings.machineOnboarded === true;
  // Coming back here on purpose (Back from the tour, Settings) is not "opened
  // elsewhere": only a first visit on this interface redirects.
  const decided = useRef(getClientSettings().onboardingCompleted);
  useEffect(() => {
    if (!machineOnboarded || decided.current) return;
    decided.current = true;
    void updateSettings({ onboardingCompleted: true });
    goHome();
  }, [machineOnboarded, goHome, updateSettings]);
  const choose = (picked: WelcomeMode) => {
    decided.current = true;
    void welcome.choose(picked);
  };
  const skip = () => {
    decided.current = true;
    void welcome.skip();
  };

  return (
    <SetupFrame
      title="Welcome"
      icon={false}
      progress={null}
      headerAction={
        <Button
          size="xs"
          variant="ghost"
          onClick={skip}
          disabled={welcome.leaving}
          data-testid="setup-skip-all"
        >
          Skip setup
        </Button>
      }
      footer={
        <>
          <span className="flex-1" />
          <span className="hidden text-xs text-muted-foreground sm:inline">
            You can switch any time in Settings
          </span>
          <Button
            size="sm"
            onClick={() => choose(mode)}
            disabled={welcome.leaving}
            data-testid="setup-primary"
          >
            Continue
            <ArrowRightIcon className="size-3.5" />
          </Button>
        </>
      }
    >
      <div className="flex min-h-full px-5 pt-14 pb-12 sm:px-8">
        <WorkWelcomeStep
          className="mx-auto mt-0"
          mode={mode}
          onModeChange={setMode}
          onConfirm={choose}
          onOwnTools={setOwnTools}
        />
      </div>
      <OwnToolsDialog
        open={ownTools !== null}
        tab={ownTools ?? "agent"}
        onTabChange={setOwnTools}
        onOpenChange={(open) => {
          if (!open) setOwnTools(null);
        }}
      />
    </SetupFrame>
  );
}
