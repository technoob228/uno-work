/**
 * Openers the browser renders natively: images, PDF, video, audio, and web
 * pages (in a sandboxed frame: scripts run, but in an opaque origin that
 * can't touch this app or the daemon).
 */
import { MinusIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { HtmlFileFrame } from "../../preview/HtmlFileFrame";
import { Button } from "../../ui/button";
import type { FileOpener, FileViewProps } from "../fileOpeners";
import { fileExtension } from "../fileTypes";
import { useFileText, useFileUrl } from "../fileSource";
import { ViewerLoading, ViewerMessage, viewerErrorText } from "./common";

const IMAGE_MIME: Record<string, string> = {
  svg: "image/svg+xml",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

function ImageView({ source }: FileViewProps) {
  const ext = fileExtension(source.name);
  const { url, error } = useFileUrl(source, IMAGE_MIME[ext] ?? "application/octet-stream");
  const [zoom, setZoom] = useState<number | null>(null); // null = fit
  const [failed, setFailed] = useState(false);
  if (error) {
    return (
      <ViewerMessage kind="image" title="Couldn't open this image" tone="error">
        {viewerErrorText(error)}
      </ViewerMessage>
    );
  }
  if (!url) return <ViewerLoading />;
  if (failed) {
    return (
      <ViewerMessage kind="image" title="This image format can't be shown in the browser">
        Download it to open it on your device.
      </ViewerMessage>
    );
  }
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto bg-[repeating-conic-gradient(var(--color-muted)_0%_25%,transparent_0%_50%)] bg-[length:20px_20px]">
        <div className="flex min-h-full min-w-full items-center justify-center p-6">
          {/* An <img> never runs script, even for SVG. */}
          <img
            src={url}
            alt={source.name}
            onError={() => setFailed(true)}
            onClick={() => setZoom((current) => (current === null ? 1 : null))}
            className={
              zoom === null
                ? "max-h-[calc(100dvh-10rem)] max-w-full cursor-zoom-in object-contain shadow-sm"
                : "max-w-none cursor-zoom-out shadow-sm"
            }
            style={zoom === null ? undefined : { width: `${zoom * 100}%` }}
          />
        </div>
      </div>
      <div className="absolute right-4 bottom-4 flex items-center gap-1 rounded-full border border-border bg-popover/90 p-1 shadow-sm backdrop-blur">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Zoom out"
          onClick={() => setZoom((current) => Math.max(0.25, (current ?? 1) - 0.25))}
        >
          <MinusIcon />
        </Button>
        <button
          type="button"
          className="min-w-12 text-center text-xs text-muted-foreground"
          onClick={() => setZoom(null)}
        >
          {zoom === null ? "Fit" : `${Math.round(zoom * 100)}%`}
        </button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Zoom in"
          onClick={() => setZoom((current) => Math.min(4, (current ?? 1) + 0.25))}
        >
          <PlusIcon />
        </Button>
      </div>
    </div>
  );
}

function PdfView({ source }: FileViewProps) {
  const { url, error } = useFileUrl(source, "application/pdf");
  if (error) {
    return (
      <ViewerMessage kind="pdf" title="Couldn't open this PDF" tone="error">
        {viewerErrorText(error)}
      </ViewerMessage>
    );
  }
  if (!url) return <ViewerLoading />;
  return <iframe title={source.name} src={url} className="h-full w-full border-0 bg-white" />;
}

const MEDIA_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  aac: "audio/aac",
  opus: "audio/ogg",
};

function MediaView({ source }: FileViewProps) {
  const mime = MEDIA_MIME[fileExtension(source.name)] ?? "application/octet-stream";
  const { url, error } = useFileUrl(source, mime);
  if (error) {
    return (
      <ViewerMessage kind={source.kind} title="Couldn't open this file" tone="error">
        {viewerErrorText(error)}
      </ViewerMessage>
    );
  }
  if (!url) return <ViewerLoading />;
  return (
    <div className="flex h-full items-center justify-center bg-black/90 p-4">
      {source.kind === "video" ? (
        <video src={url} controls className="max-h-full max-w-full" />
      ) : (
        <audio src={url} controls className="w-full max-w-xl" />
      )}
    </div>
  );
}

function HtmlView({ source }: FileViewProps) {
  const { data, error, isPending } = useFileText(source);
  if (isPending) return <ViewerLoading />;
  if (error) {
    return (
      <ViewerMessage kind="html" title="Couldn't open this page" tone="error">
        {viewerErrorText(error)}
      </ViewerMessage>
    );
  }
  // Served from its own folder, so its CSS, images and fonts load too. Scripts
  // run, but without allow-same-origin the page lives in an opaque origin: no
  // access to this app, its storage or the daemon.
  return (
    <HtmlFileFrame
      name={source.name}
      environmentId={source.environmentId}
      path={source.path}
      content={data}
      fallbackSrcDoc={data}
      sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals"
    />
  );
}

export const mediaOpeners: ReadonlyArray<FileOpener> = [
  {
    id: "builtin.image",
    label: "Image viewer",
    match: (file) => (file.kind === "image" ? 10 : 0),
    View: ImageView,
    editOutsideHint:
      "To change this image, download it, edit it in any photo app, then upload the new version.",
  },
  {
    id: "builtin.pdf",
    label: "PDF viewer",
    match: (file) => (file.kind === "pdf" ? 10 : 0),
    View: PdfView,
  },
  {
    id: "builtin.media",
    label: "Player",
    match: (file) => (file.kind === "video" || file.kind === "audio" ? 10 : 0),
    View: MediaView,
  },
  {
    id: "builtin.html",
    label: "Web page",
    match: (file) => (file.kind === "html" ? 10 : 0),
    View: HtmlView,
    maxBytes: 20 * 1024 * 1024,
  },
];
