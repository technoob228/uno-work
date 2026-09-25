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
    // Files opens on Cloud storage: that's the half the coach talks about.
    else if (step === "files") void navigate({ to: "/files", search: { cloud: "1" } });
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

/** The strip under the screen's header where the tour's progress bar sits. */
interface BarPlace {
  readonly top: number;
  readonly left: number;
  readonly width: number;
}

function readBarPlace(): BarPlace | null {
  if (typeof document === "undefined") return null;
  const inset = document.querySelector<HTMLElement>('[data-slot="sidebar-inset"]');
  if (!inset) return null;
  const rect = inset.getBoundingClientRect();
  const header = inset.querySelector<HTMLElement>("header");
  const top = header ? header.getBoundingClientRect().bottom : rect.top;
  return { top, left: rect.left, width: rect.width };
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
  const [bar, setBar] = useState<BarPlace | null>(null);

  // Follow the target while the screen settles (the sidebar animates, the
  // App Store opens) and on resize.
  useLayoutEffect(() => {
    if (!step) return;
    let frame = 0;
    let until = performance.now() + 1500;
    const tick = () => {
      setAnchor(readAnchor(step));
      setBar(readBarPlace());
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
        left: Math.min(anchor.left + anchor.width + 16, window.innerWidth - 316),
        top: Math.max(64, anchor.top + anchor.height / 2 - 30),
      }
    : undefined;

  return (
    <>
      {bar ? (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[199] h-[3px] bg-muted"
          style={{ top: bar.top, left: bar.left, width: bar.width }}
        >
          <div
            className="h-full bg-primary transition-[width] duration-300 ease-out"
            style={{ width: `${Math.round(((index + 1) / TOUR_STEPS.length) * 100)}%` }}
          />
        </div>
      ) : null}
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
            ? "fixed z-[201] w-[300px] rounded-2xl bg-[#18181b] p-4 text-white shadow-2xl"
            : "fixed inset-x-3 bottom-3 z-[201] rounded-2xl bg-[#18181b] p-4 text-white shadow-2xl sm:left-auto sm:w-[300px]"
        }
        style={cardStyle}
      >
        {anchor ? (
          <span
            aria-hidden
            className="absolute top-6 -left-1.5 size-3 rotate-45 rounded-[2px] bg-[#18181b]"
          />
        ) : null}
        <div className="text-xs text-white/55">
          {index + 1} of {TOUR_STEPS.length}
        </div>
        <h4 className="mt-1 font-semibold">{copy.title}</h4>
        <p className="mt-1 text-sm leading-relaxed text-white/75">{copy.body}</p>
        <div className="mt-4 flex items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={
              index > 0 ? back : () => void navigate({ to: "/setup", search: { step: "welcome" } })
            }
            className="h-8 rounded-lg px-3 text-sm text-white/85 transition-colors hover:bg-white/10"
          >
            Back
          </button>
          <button
            type="button"
            onClick={finish}
            className="h-8 rounded-lg bg-white/10 px-3 text-sm text-white transition-colors hover:bg-white/15"
          >
            Skip tour
          </button>
          <Button size="sm" onClick={next} data-testid="setup-tour-next">
            {index < TOUR_STEPS.length - 1 ? "Next" : "Done"}
          </Button>
        </div>
      </div>
    </>
  );
}
