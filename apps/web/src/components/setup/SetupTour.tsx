/**
 * "Just a computer": a three-stop tour over the real app — Home, Files, the
 * App Store — each stop opens the real screen and points at its row in the
 * sidebar (`data-tour="home|files|apps"`). On a narrow screen the sidebar is
 * a sheet, so the card sits at the bottom without a pointer.
 */
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useState } from "react";
import { create } from "zustand";

import { Button } from "../ui/button";
import { TOUR_STEPS, type TourStepId } from "./setupModel";

interface SetupTourState {
  readonly step: TourStepId | null;
  readonly setStep: (step: TourStepId | null) => void;
}

export const useSetupTourStore = create<SetupTourState>((set) => ({
  step: null,
  setStep: (step) => set({ step }),
}));

const COACH: Readonly<Record<TourStepId, { title: string; body: string }>> = {
  home: {
    title: "Home",
    body: "Start here. Type a task, see what the computer is doing, open recent files and apps.",
  },
  files: {
    title: "Files",
    body: "Cloud storage keeps your files safe even when the computer sleeps. Open documents and sheets right here in Office.",
  },
  apps: {
    title: "App Store",
    body: "Install apps in one click: photos, passwords, a VPN, automations. Each one gets its own address.",
  },
};

/** The screen each stop shows. */
function useTourNavigate() {
  const navigate = useNavigate();
  return (step: TourStepId) => {
    if (step === "home") void navigate({ to: "/computer" });
    else if (step === "files") void navigate({ to: "/files" });
    else void navigate({ to: "/computer", search: { store: "1" } });
  };
}

export function useStartSetupTour() {
  const setStep = useSetupTourStore((state) => state.setStep);
  const go = useTourNavigate();
  return (step: TourStepId = "home") => {
    setStep(step);
    go(step);
  };
}

interface Anchor {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

function readAnchor(step: TourStepId): Anchor | null {
  if (typeof window === "undefined" || window.innerWidth < 900) return null;
  const element = document.querySelector<HTMLElement>(`[data-tour="${step}"]`);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

export function SetupTourCoach() {
  const step = useSetupTourStore((state) => state.step);
  const setStep = useSetupTourStore((state) => state.setStep);
  const navigate = useNavigate();
  const go = useTourNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  // Follow the target while the screen settles (the sidebar animates, the
  // App Store opens) and on resize.
  useLayoutEffect(() => {
    if (!step) return;
    let frame = 0;
    let until = performance.now() + 1500;
    const tick = () => {
      setAnchor(readAnchor(step));
      if (performance.now() < until) frame = window.requestAnimationFrame(tick);
    };
    tick();
    const onResize = () => {
      until = performance.now() + 300;
      window.cancelAnimationFrame(frame);
      tick();
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, [step, pathname]);

  // Leaving for somewhere unrelated ends the tour.
  useEffect(() => {
    if (!step) return;
    if (pathname !== "/computer" && pathname !== "/files") setStep(null);
  }, [pathname, setStep, step]);

  if (!step) return null;
  const index = TOUR_STEPS.indexOf(step);
  const copy = COACH[step];
  const finish = () => {
    setStep(null);
    void navigate({ to: "/setup", search: { step: "tour-done" } });
  };
  const next = () => {
    const following = TOUR_STEPS[index + 1];
    if (!following) {
      finish();
      return;
    }
    setStep(following);
    go(following);
  };
  const back = () => {
    const previous = TOUR_STEPS[index - 1];
    if (!previous) return;
    setStep(previous);
    go(previous);
  };

  const cardStyle = anchor
    ? {
        left: Math.min(anchor.left + anchor.width + 16, window.innerWidth - 336),
        top: Math.max(64, anchor.top + anchor.height / 2 - 40),
      }
    : undefined;

  return (
    <>
      {anchor ? (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[200] rounded-lg ring-2 ring-primary ring-offset-2 ring-offset-background transition-all duration-200"
          style={{
            top: anchor.top,
            left: anchor.left,
            width: anchor.width,
            height: anchor.height,
          }}
        />
      ) : null}
      <div
        role="dialog"
        aria-label={copy.title}
        data-testid="setup-tour-coach"
        className={
          anchor
            ? "fixed z-[201] w-80 rounded-2xl border border-border bg-popover p-4 text-popover-foreground shadow-xl"
            : "fixed inset-x-3 bottom-3 z-[201] rounded-2xl border border-border bg-popover p-4 text-popover-foreground shadow-xl sm:left-auto sm:w-80"
        }
        style={cardStyle}
      >
        <div className="text-xs text-muted-foreground">
          {index + 1} of {TOUR_STEPS.length}
        </div>
        <h4 className="mt-1 font-semibold">{copy.title}</h4>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{copy.body}</p>
        <div className="mt-3 flex items-center gap-1">
          {index > 0 ? (
            <Button size="xs" variant="ghost" onClick={back}>
              Back
            </Button>
          ) : null}
          <span className="flex-1" />
          <Button size="xs" variant="ghost" onClick={finish}>
            Skip tour
          </Button>
          <Button size="xs" onClick={next}>
            {index < TOUR_STEPS.length - 1 ? "Next" : "Done"}
          </Button>
        </div>
      </div>
    </>
  );
}
