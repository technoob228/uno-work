/**
 * Word and PowerPoint in the browser — for looking, not (yet) for editing.
 * Word pages render with docx-preview (layout, styles, tables, pictures).
 * Slides render from the file's own XML: text boxes and pictures where they
 * sit, without theme effects — the viewer says so. To change either, the
 * person downloads it, edits it in Word/PowerPoint and uploads the new
 * version; a full office engine can replace these by registering an opener
 * with a higher score (see fileOpeners.ts).
 */
import { useEffect, useRef, useState } from "react";

import { cn } from "../../../lib/utils";
import type { FileOpener, FileViewProps } from "../fileOpeners";
import { useFileBytes } from "../fileSource";
import { ViewerLoading, ViewerMessage, viewerErrorText } from "./common";
import {
  mediaObjectUrl,
  readPresentation,
  type Presentation,
  type Slide,
  type SlideItem,
} from "./pptxModel";

const OFFICE_MAX_BYTES = 60 * 1024 * 1024;
const EDIT_IN_APP =
  "To change it, download it, edit it in Word, then upload the new version here — it replaces this one.";

// ── Word ───────────────────────────────────────────────────────────────────

function DocxView({ source }: FileViewProps) {
  const bytes = useFileBytes(source);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const styleRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<"rendering" | "done" | Error>("rendering");

  useEffect(() => {
    const body = bodyRef.current;
    const styles = styleRef.current;
    if (!bytes.data || !body || !styles) return;
    let cancelled = false;
    setState("rendering");
    body.replaceChildren();
    styles.replaceChildren();
    void import("docx-preview")
      .then(({ renderAsync }) =>
        renderAsync(bytes.data, body, styles, {
          className: "docx",
          inWrapper: true,
          breakPages: true,
          ignoreLastRenderedPageBreak: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          useBase64URL: true,
          experimental: true,
        }),
      )
      .then(
        () => !cancelled && setState("done"),
        (error: unknown) =>
          !cancelled && setState(error instanceof Error ? error : new Error(String(error))),
      );
    return () => {
      cancelled = true;
    };
  }, [bytes.data]);

  if (bytes.error) {
    return (
      <ViewerMessage kind="document" title="Couldn't open this document" tone="error">
        {viewerErrorText(bytes.error)}
      </ViewerMessage>
    );
  }
  if (state instanceof Error) {
    return (
      <ViewerMessage kind="document" title="This document can't be shown in the browser">
        {state.message}. Download it to open it in Word.
      </ViewerMessage>
    );
  }
  return (
    <div className="relative h-full overflow-auto bg-muted/40">
      {state === "rendering" ? (
        <div className="absolute inset-0 z-10 bg-background/60">
          <ViewerLoading label="Laying out pages…" />
        </div>
      ) : null}
      <div ref={styleRef} />
      {/* docx-preview draws white pages on its own grey desk; keep ours. */}
      <div
        ref={bodyRef}
        className="files-docx min-h-full [&_.docx-wrapper]:bg-transparent! [&_.docx-wrapper]:py-6!"
      />
    </div>
  );
}

// ── PowerPoint ─────────────────────────────────────────────────────────────

function useMediaUrls(presentation: Presentation | null) {
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    if (!presentation) return;
    let cancelled = false;
    const created: string[] = [];
    const paths = new Set(
      presentation.slides.flatMap((slide) =>
        slide.items.flatMap((item) => (item.type === "image" ? [item.mediaPath] : [])),
      ),
    );
    void (async () => {
      const next = new Map<string, string>();
      for (const path of paths) {
        const url = await mediaObjectUrl(presentation.zip, path);
        if (url) {
          created.push(url);
          next.set(path, url);
        }
      }
      if (!cancelled) setUrls(next);
    })();
    return () => {
      cancelled = true;
      for (const url of created) URL.revokeObjectURL(url);
    };
  }, [presentation]);
  return urls;
}

function SlideText({ item }: { item: Extract<SlideItem, { type: "text" }> }) {
  const baseSize = item.role === "title" ? 32 : item.role === "subtitle" ? 20 : 16;
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col overflow-hidden",
        item.role === "title" ? "justify-center font-semibold" : "justify-start",
      )}
    >
      {item.paragraphs.map((paragraph, index) => (
        <p
          key={index}
          style={{
            textAlign: paragraph.align,
            paddingLeft: `${paragraph.level * 1.2}em`,
            fontSize: `calc(var(--slide-scale) * ${paragraph.runs.find((run) => run.size)?.size ?? baseSize}px)`,
          }}
          className="m-0 leading-tight"
        >
          {paragraph.bullet ? "• " : ""}
          {paragraph.runs.map((run, runIndex) =>
            run.text === "\n" ? (
              <br key={runIndex} />
            ) : (
              <span
                key={runIndex}
                style={{
                  ...(run.color ? { color: run.color } : {}),
                  ...(run.size ? { fontSize: `calc(var(--slide-scale) * ${run.size}px)` } : {}),
                }}
                className={cn(run.bold && "font-bold", run.italic && "italic")}
              >
                {run.text}
              </span>
            ),
          )}
        </p>
      ))}
    </div>
  );
}

function SlideCanvas({
  slide,
  aspect,
  media,
}: {
  slide: Slide;
  aspect: number;
  media: ReadonlyMap<string, string>;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Font sizes are in points on a 960px-wide slide; scale with the card.
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setScale(entry.contentRect.width / 960);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const positioned = slide.items.filter((item) => item.box !== null);
  const flowing = slide.items.filter((item) => item.box === null);
  return (
    <div
      ref={ref}
      className="relative w-full overflow-hidden rounded-lg border border-border/70 bg-white text-neutral-900 shadow-sm"
      style={{ aspectRatio: String(aspect), ["--slide-scale" as string]: String(scale) }}
    >
      {positioned.map((item, index) => (
        <div
          key={index}
          className="absolute"
          style={{
            left: `${item.box!.x * 100}%`,
            top: `${item.box!.y * 100}%`,
            width: `${item.box!.w * 100}%`,
            height: `${item.box!.h * 100}%`,
          }}
        >
          {item.type === "text" ? (
            <SlideText item={item} />
          ) : media.get(item.mediaPath) ? (
            <img src={media.get(item.mediaPath)} alt="" className="h-full w-full object-contain" />
          ) : null}
        </div>
      ))}
      {flowing.length > 0 ? (
        <div className="absolute inset-[6%] flex flex-col gap-3">
          {flowing.map((item, index) =>
            item.type === "text" ? (
              <SlideText key={index} item={item} />
            ) : media.get(item.mediaPath) ? (
              <img
                key={index}
                src={media.get(item.mediaPath)}
                alt=""
                className="max-h-40 object-contain"
              />
            ) : null,
          )}
        </div>
      ) : null}
    </div>
  );
}

function PptxView({ source }: FileViewProps) {
  const bytes = useFileBytes(source);
  const [presentation, setPresentation] = useState<Presentation | Error | null>(null);
  useEffect(() => {
    if (!bytes.data) return;
    let cancelled = false;
    readPresentation(bytes.data).then(
      (result) => !cancelled && setPresentation(result),
      (error: unknown) =>
        !cancelled && setPresentation(error instanceof Error ? error : new Error(String(error))),
    );
    return () => {
      cancelled = true;
    };
  }, [bytes.data]);
  const media = useMediaUrls(presentation instanceof Error ? null : presentation);

  if (bytes.error || presentation instanceof Error) {
    return (
      <ViewerMessage kind="presentation" title="This presentation can't be shown in the browser">
        {viewerErrorText(bytes.error ?? presentation)} Download it to open it in PowerPoint or
        Keynote.
      </ViewerMessage>
    );
  }
  if (!presentation) return <ViewerLoading label="Reading slides…" />;
  if (presentation.slides.length === 0) {
    return <ViewerMessage kind="presentation" title="This presentation has no slides" />;
  }
  return (
    <div className="h-full overflow-y-auto bg-muted/40">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-8">
        <p className="rounded-lg border border-border/60 bg-card px-3 py-2 text-xs text-muted-foreground">
          Simplified preview: text and pictures are shown where they sit, but themes, charts and
          animations aren&apos;t. Download it to see it exactly as in PowerPoint.
        </p>
        {presentation.slides.map((slide) => (
          <figure key={slide.index} className="m-0">
            <figcaption className="mb-1.5 text-xs text-muted-foreground">
              Slide {slide.index + 1}
            </figcaption>
            <SlideCanvas slide={slide} aspect={presentation.aspect} media={media} />
            {slide.notes ? (
              <p className="mt-2 text-xs whitespace-pre-wrap text-muted-foreground">
                <span className="font-medium text-foreground">Notes:</span> {slide.notes}
              </p>
            ) : null}
          </figure>
        ))}
      </div>
    </div>
  );
}

// ── Anything else ──────────────────────────────────────────────────────────

function NoPreview({ source }: FileViewProps) {
  const legacy = /\.(doc|ppt|xls|odt|odp|pages|key|numbers)$/i.test(source.name);
  return (
    <ViewerMessage
      kind={source.kind}
      title={legacy ? "This format opens in its own app" : "No preview for this kind of file"}
    >
      Download it to open it on your device.
      {legacy ? " Newer .docx, .xlsx and .pptx files open right here." : null}
    </ViewerMessage>
  );
}

export const officeOpeners: ReadonlyArray<FileOpener> = [
  {
    id: "builtin.docx",
    label: "Word viewer",
    match: (file) => (/\.docx$/i.test(file.name) ? 10 : 0),
    View: DocxView,
    editOutsideHint: EDIT_IN_APP,
    maxBytes: OFFICE_MAX_BYTES,
  },
  {
    id: "builtin.pptx",
    label: "Slides viewer",
    match: (file) => (/\.pptx$/i.test(file.name) ? 10 : 0),
    View: PptxView,
    editOutsideHint:
      "To change it, download it, edit it in PowerPoint or Keynote, then upload the new version here — it replaces this one.",
    maxBytes: OFFICE_MAX_BYTES,
  },
  {
    id: "builtin.fallback",
    label: "File",
    match: () => 1,
    View: NoPreview,
  },
];
