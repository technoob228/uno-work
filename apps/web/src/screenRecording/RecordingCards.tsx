/**
 * Loom Work cards: the recording in the composer (saving to Drive, the agent
 * watching it, Retry) and in the sent message (player, link, what the agent
 * saw).
 */
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  EyeIcon,
  HardDriveIcon,
  NotebookPenIcon,
  LoaderCircleIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
  VideoIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { parseKeyFrameName } from "./agentView";
import type { RecordingItem } from "./pipeline";
import { type ParsedRecording, formatBytes, formatClock } from "./recordingLogic";
import { useScreenRecordingStore } from "./recordingStore";

/**
 * A <video> that also works for WebM from MediaRecorder: those files carry
 * no duration, so the bar can't seek until the browser is made to scan to
 * the end once.
 */
export function RecordingPlayer(props: {
  readonly src: string;
  readonly className?: string;
  readonly autoPlay?: boolean;
  readonly testId?: string;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const fixDuration = () => {
      if (video.duration === Number.POSITIVE_INFINITY) {
        const back = () => {
          video.removeEventListener("timeupdate", back);
          video.currentTime = 0;
        };
        video.addEventListener("timeupdate", back);
        video.currentTime = 1e101;
      }
    };
    video.addEventListener("loadedmetadata", fixDuration);
    return () => video.removeEventListener("loadedmetadata", fixDuration);
  }, [props.src]);
  return (
    <video
      ref={ref}
      src={props.src}
      controls
      playsInline
      preload="metadata"
      autoPlay={props.autoPlay}
      data-testid={props.testId}
      className={cn("w-full rounded-md bg-black", props.className)}
    />
  );
}

function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);
  return [
    copied,
    (text: string) => {
      void navigator.clipboard?.writeText(text).then(
        () => setCopied(true),
        () => undefined,
      );
    },
  ];
}

function StepLine(props: {
  readonly icon: typeof HardDriveIcon;
  readonly status: RecordingItem["save"]["status"];
  readonly running: string;
  readonly done: React.ReactNode;
  readonly error: string | null;
  readonly progress?: number;
  readonly onRetry?: () => void;
  readonly testId: string;
}) {
  const Icon = props.icon;
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 text-xs"
      data-testid={props.testId}
      data-status={props.status}
    >
      {props.status === "running" || props.status === "waiting" ? (
        <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : props.status === "done" ? (
        <CheckIcon className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
      ) : props.status === "failed" ? (
        <TriangleAlertIcon className="size-3.5 shrink-0 text-red-500" />
      ) : (
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate" title={props.error ?? undefined}>
        {props.status === "running" || props.status === "waiting"
          ? `${props.running}${props.progress !== undefined && props.progress > 0 ? ` ${Math.round(props.progress * 100)}%` : ""}`
          : props.status === "done"
            ? props.done
            : props.error}
      </span>
      {props.status === "failed" && props.onRetry ? (
        <Button
          size="xs"
          variant="outline"
          onClick={props.onRetry}
          data-testid={`${props.testId}-retry`}
        >
          <RotateCcwIcon />
          Retry
        </Button>
      ) : null}
    </div>
  );
}

/** The recording waiting in the composer. */
export function RecordingComposerCard(props: { readonly item: RecordingItem }) {
  const { item } = props;
  const retrySave = useScreenRecordingStore((state) => state.retrySave);
  const retryWatch = useScreenRecordingStore((state) => state.retryWatch);
  const remove = useScreenRecordingStore((state) => state.remove);
  const [expanded, setExpanded] = useState(false);
  const [copied, copy] = useCopied();
  return (
    <div
      data-testid="recording-composer-card"
      className="flex w-full max-w-[460px] flex-col gap-2 rounded-lg border border-border/80 bg-background/70 p-2"
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          className="relative h-14 w-24 shrink-0 overflow-hidden rounded-md bg-black"
          onClick={() => setExpanded((value) => !value)}
          aria-label={expanded ? "Hide the recording" : "Play the recording"}
          data-testid="recording-thumb"
        >
          <video
            src={item.previewUrl}
            muted
            preload="metadata"
            className="size-full object-cover"
          />
          <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-[10px] text-white tabular-nums">
            {formatClock(item.durationMs)}
          </span>
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <VideoIcon className="size-3.5 shrink-0 text-foreground/70" />
            <span className="truncate text-xs font-medium" title={item.name}>
              {item.name}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {formatBytes(item.sizeBytes)}
            </span>
          </div>
          <StepLine
            icon={HardDriveIcon}
            testId="recording-save"
            status={item.save.status}
            running="Saving to Uno Drive…"
            progress={item.save.progress}
            error={item.save.error}
            onRetry={() => retrySave(item.threadKey)}
            done={
              <span className="inline-flex items-center gap-1.5">
                In Uno Drive · {item.save.driveKey?.split("/").slice(0, -1).join("/")}/
                {item.save.shareUrl ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    onClick={() => copy(item.save.shareUrl!)}
                    data-testid="recording-copy-link"
                  >
                    <CopyIcon className="size-3" />
                    {copied ? "Copied" : "Copy link"}
                  </button>
                ) : null}
              </span>
            }
          />
          <StepLine
            icon={EyeIcon}
            testId="recording-watch"
            status={item.watch.status}
            running="The agent is watching it…"
            error={item.watch.error}
            onRetry={() => retryWatch(item.threadKey)}
            done={
              item.watch.speech
                ? "Watched — your words are in the box, edit and send"
                : "Watched — add what to do and send"
            }
          />
          {item.meetingFolder ? (
            <div
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
              data-testid="recording-notetaker"
              title={`~/${item.meetingFolder}`}
            >
              <NotebookPenIcon className="size-3 shrink-0" />
              Also in Notetaker — notes and to-dos are on their way
            </div>
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Remove the recording"
          title="Remove (the copy in Uno Drive stays)"
          data-testid="recording-remove"
          onClick={() => remove(item.threadKey)}
        >
          <XIcon />
        </Button>
      </div>
      {expanded ? (
        <RecordingPlayer src={item.previewUrl} autoPlay testId="recording-composer-player" />
      ) : null}
    </div>
  );
}

/** The recording in a sent message. */
export function RecordingMessageCard(props: {
  readonly recording: ParsedRecording;
  /** The key frames that went with the message as pictures. */
  readonly frames?: ReadonlyArray<{ id: string; name: string; previewUrl: string | null }>;
  /** This session still has the bytes (plays even before Drive answers). */
  readonly localUrl?: string | null;
}) {
  const { recording } = props;
  const [showWhat, setShowWhat] = useState(false);
  const [copied, copy] = useCopied();
  const src =
    props.localUrl ??
    (recording.shareUrl
      ? `${recording.shareUrl}${recording.shareUrl.includes("?") ? "&" : "?"}view=1`
      : null);
  return (
    <div
      data-testid="recording-message-card"
      className="mb-2 flex w-full max-w-[420px] flex-col gap-1.5 rounded-lg border border-border/80 bg-background/70 p-2"
    >
      {src ? <RecordingPlayer src={src} testId="recording-message-player" /> : null}
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <VideoIcon className="size-3.5 shrink-0 text-foreground/70" />
        <span
          className="min-w-0 flex-1 truncate font-medium text-foreground/80"
          title={recording.name}
        >
          {recording.name}
        </span>
        {recording.duration ? (
          <span className="shrink-0 text-muted-foreground tabular-nums">{recording.duration}</span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {recording.driveKey ? (
          <span className="inline-flex items-center gap-1" title={recording.driveKey}>
            <HardDriveIcon className="size-3" />
            Uno Drive · Recordings
          </span>
        ) : (
          <span>Not in Uno Drive</span>
        )}
        {recording.shareUrl ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 hover:text-foreground"
            onClick={() => copy(recording.shareUrl!)}
            data-testid="recording-message-copy-link"
          >
            <CopyIcon className="size-3" />
            {copied ? "Copied" : "Copy link"}
          </button>
        ) : null}
        {recording.speech ||
        recording.visual ||
        recording.timeline ||
        (props.frames?.length ?? 0) > 0 ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 hover:text-foreground"
            onClick={() => setShowWhat((value) => !value)}
            data-testid="recording-message-what"
          >
            <EyeIcon className="size-3" />
            What the agent saw
            <ChevronDownIcon
              className={cn("size-3 transition-transform", showWhat && "rotate-180")}
            />
          </button>
        ) : null}
      </div>
      {showWhat ? (
        <div
          className="flex flex-col gap-1.5 rounded-md bg-muted/50 p-2 text-xs"
          data-testid="recording-message-summary"
        >
          {recording.speech ? (
            <div>
              <div className="font-medium text-foreground/80">You said</div>
              <div className="whitespace-pre-wrap text-muted-foreground">{recording.speech}</div>
            </div>
          ) : null}
          {recording.visual ? (
            <div>
              <div className="font-medium text-foreground/80">On screen</div>
              <div className="whitespace-pre-wrap text-muted-foreground">{recording.visual}</div>
            </div>
          ) : null}
          {recording.timeline ? (
            <div data-testid="recording-message-timeline">
              <div className="font-medium text-foreground/80">Second by second</div>
              <div className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground">
                {recording.timeline}
              </div>
            </div>
          ) : null}
          {props.frames && props.frames.length > 0 ? (
            <div data-testid="recording-message-frames">
              <div className="font-medium text-foreground/80">
                Key frames the agent got ({props.frames.length})
              </div>
              <div className="mt-1 flex gap-1.5 overflow-x-auto pb-1">
                {props.frames.map((frame) => {
                  const moment = parseKeyFrameName(frame.name);
                  return (
                    <figure key={frame.id} className="shrink-0" title={frame.name}>
                      {frame.previewUrl ? (
                        <img
                          src={frame.previewUrl}
                          alt={frame.name}
                          className="h-16 w-auto rounded border border-border/70"
                        />
                      ) : (
                        <div className="flex h-16 w-24 items-center justify-center rounded border border-border/70 text-[10px]">
                          picture
                        </div>
                      )}
                      {moment ? (
                        <figcaption className="mt-0.5 text-center text-[10px] tabular-nums text-muted-foreground">
                          {formatClock(moment.t)} · {moment.reason}
                        </figcaption>
                      ) : null}
                    </figure>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
