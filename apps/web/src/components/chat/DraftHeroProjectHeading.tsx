/**
 * "What should we do in [folder] on [computer]?" — upstream T3 Code's
 * `DraftHeroProjectHeading` (one line when it fits, the question and the
 * pickers on two lines when it doesn't), with Uno Work's words and a second
 * picker for the computer.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export function DraftHeroProjectHeading({
  folderPicker,
  computerPicker,
  folderName,
  computerName,
}: {
  folderPicker: ReactNode;
  /** Null: the question is only about the folder. */
  computerPicker: ReactNode | null;
  /** Plain names, for measuring whether the sentence fits on one line. */
  folderName: string;
  computerName: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inlineRef = useRef<HTMLSpanElement>(null);
  const [fitsInline, setFitsInline] = useState(false);

  // Measures the full one-line heading against its container (ResizeObserver)
  // to pick the one-line or the two-line layout.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const inline = inlineRef.current;
    if (!container || !inline) return;

    // Measure the full inline heading independently of its current layout, so
    // moving the names below it cannot make the fit check oscillate.
    const update = () =>
      setFitsInline(
        inline.getBoundingClientRect().width <= container.getBoundingClientRect().width,
      );
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(container);
    observer.observe(inline);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={containerRef} className="group/draft-hero relative w-full" data-inline={fitsInline}>
      <span
        aria-hidden="true"
        className="pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden"
      >
        <span
          ref={inlineRef}
          className="flex w-max items-baseline gap-2 whitespace-nowrap font-normal text-3xl tracking-tight"
        >
          <span>What should we do in</span>
          <span className="font-medium">{folderName}</span>
          {computerName !== null ? (
            <>
              <span>on</span>
              <span>
                <span className="font-medium">{computerName}</span>?
              </span>
            </>
          ) : (
            <span>?</span>
          )}
        </span>
      </span>
      <h1
        className="flex w-full flex-col items-center justify-center gap-2 text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl lg:group-data-[inline=true]/draft-hero:flex-row"
        data-testid="draft-hero-heading"
      >
        <span className="max-w-full lg:group-data-[inline=true]/draft-hero:shrink-0">
          What should we do
          <span className="lg:group-data-[inline=true]/draft-hero:hidden">?</span>
          <span className="hidden lg:group-data-[inline=true]/draft-hero:inline"> in</span>
        </span>
        <span className="flex min-w-0 max-w-full flex-wrap items-baseline justify-center gap-x-2 text-base tracking-normal lg:group-data-[inline=true]/draft-hero:flex-nowrap lg:group-data-[inline=true]/draft-hero:text-3xl lg:group-data-[inline=true]/draft-hero:tracking-tight">
          <span className="min-w-0">{folderPicker}</span>
          {computerPicker !== null ? (
            <>
              <span className="shrink-0 text-muted-foreground lg:group-data-[inline=true]/draft-hero:text-foreground">
                on
              </span>
              <span className="min-w-0">{computerPicker}</span>
            </>
          ) : null}
          <span className="-ml-2 hidden shrink-0 lg:group-data-[inline=true]/draft-hero:inline">
            ?
          </span>
        </span>
      </h1>
    </div>
  );
}
