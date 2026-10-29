/**
 * The centred composer glides to the bottom when the chat starts (and back,
 * should it ever return) instead of jumping — upstream T3 Code's
 * `useDraftHeroLayoutTransition` (#4055): a FLIP Web Animation on the
 * composer group, measured before paint. Off for reduced motion.
 */
import { useLayoutEffect, useRef } from "react";

export const DRAFT_HERO_TRANSITION_ANIMATION_ID = "uno-draft-hero-transition";
const DRAFT_HERO_TRANSITION_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";
const DRAFT_HERO_TRANSITION_MS = 220;

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);

export function useDraftHeroLayoutTransition(isDraftHeroState: boolean) {
  const transitionGroupRef = useRef<HTMLDivElement | null>(null);
  const previousStateRef = useRef(isDraftHeroState);
  const previousRectRef = useRef<DOMRect | null>(null);
  const animationRef = useRef<Animation | null>(null);

  // While centred, remember where the composer is after every commit: the
  // send that docks it is measured against its last on-screen place.
  useLayoutEffect(() => {
    if (isDraftHeroState && previousStateRef.current === isDraftHeroState) {
      previousRectRef.current = transitionGroupRef.current?.getBoundingClientRect() ?? null;
    }
  });

  // Measures the committed composer rect and starts a FLIP animation before paint.
  useLayoutEffect(() => {
    const group = transitionGroupRef.current;
    const nextRect = group?.getBoundingClientRect() ?? null;
    const stateChanged = previousStateRef.current !== isDraftHeroState;
    animationRef.current?.cancel();
    animationRef.current = null;
    const previousRect = previousRectRef.current;
    if (
      stateChanged &&
      group &&
      previousRect &&
      nextRect &&
      typeof group.animate === "function" &&
      !prefersReducedMotion()
    ) {
      const translateX = previousRect.left - nextRect.left;
      const translateY = previousRect.top - nextRect.top;
      if (Math.abs(translateX) >= 0.5 || Math.abs(translateY) >= 0.5) {
        const animation = group.animate(
          [
            { transform: `translate3d(${translateX}px, ${translateY}px, 0)` },
            { transform: "translate3d(0, 0, 0)" },
          ],
          { duration: DRAFT_HERO_TRANSITION_MS, easing: DRAFT_HERO_TRANSITION_EASING },
        );
        animation.id = DRAFT_HERO_TRANSITION_ANIMATION_ID;
        animationRef.current = animation;
        void animation.finished
          .catch(() => undefined)
          .then(() => {
            if (animationRef.current === animation) animationRef.current = null;
          });
      }
    }
    previousStateRef.current = isDraftHeroState;
    previousRectRef.current = nextRect;
  }, [isDraftHeroState]);

  return transitionGroupRef;
}
