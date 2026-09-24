/** The end of "Just a computer": what the tour showed, and AI for later. */
import { CheckIcon } from "lucide-react";

import { Button } from "../../ui/button";
import { OwnToolsRow } from "../OwnToolsDialog";
import type { TourStepId } from "../setupModel";
import { SetupFrame } from "../SetupShell";
import { useStartSetupTour } from "../SetupTour";
import { useSetupNavigation } from "../useSetupNavigation";
import { useUpdateSetupProgress } from "../useSetupProgress";

const STOPS: ReadonlyArray<{ step: TourStepId; label: string; value: string }> = [
  { step: "home", label: "Home", value: "Tasks, recent files, apps" },
  { step: "files", label: "Files", value: "Cloud storage + this computer, Office built in" },
  { step: "apps", label: "App Store", value: "Apps in one click" },
];

export function TourDoneStep() {
  const startTour = useStartSetupTour();
  const { goHome, goToStep } = useSetupNavigation();
  const update = useUpdateSetupProgress();
  return (
    <SetupFrame
      title="Welcome"
      progress={1}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={() => startTour("apps")}>
            Back
          </Button>
          <span className="flex-1" />
          <Button size="sm" onClick={goHome} data-testid="setup-primary">
            Go to Home
          </Button>
        </>
      }
    >
      <div className="mx-auto flex w-full max-w-2xl flex-col items-center px-5 pt-12 pb-12 text-center sm:px-8">
        <img
          src="/uno-mark.svg"
          alt=""
          className="size-14 rounded-2xl shadow-lg shadow-primary/20"
        />
        <h1 className="mt-6 text-3xl font-semibold tracking-tight">You’re all set</h1>
        <p className="mt-2 max-w-lg text-[15px] leading-relaxed text-muted-foreground">
          Files, Office and apps are ready on your own computer in the cloud. It stays online when
          you leave.
        </p>
        <div className="mt-8 w-full overflow-hidden rounded-2xl border border-border text-left">
          {STOPS.map((stop, index) => (
            <div
              key={stop.step}
              className={`flex items-center gap-3 px-4 py-3 ${index > 0 ? "border-t border-border" : ""}`}
            >
              <span className="flex size-[18px] items-center justify-center rounded-full bg-primary text-primary-foreground">
                <CheckIcon className="size-3" strokeWidth={3} />
              </span>
              <span className="w-24 shrink-0 text-sm text-muted-foreground">{stop.label}</span>
              <span className="min-w-0 flex-1 text-sm">{stop.value}</span>
              <Button size="xs" variant="ghost" onClick={() => startTour(stop.step)}>
                Show
              </Button>
            </div>
          ))}
        </div>
        <div className="w-full text-left">
          <OwnToolsRow title="Need something the App Store doesn’t have?" />
        </div>
        <p className="mt-6 text-xs text-muted-foreground">
          Want AI later?{" "}
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => {
              void update((current) => ({ ...current, mode: "ai" })).then(() => goToStep("ai"));
            }}
          >
            Set it up now
          </button>
          .
        </p>
      </div>
    </SetupFrame>
  );
}
