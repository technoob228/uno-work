/**
 * Loom Work: the control bar while recording — red dot and time, Pause,
 * Done, Discard, and the camera preview. Global (mounted by the app shell):
 * it stays put whatever the person opens in Work.
 */
import { PauseIcon, PlayIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { RECORDING_MAX_MS, RECORDING_WARN_MS, formatClock } from "./recordingLogic";
import { useScreenRecordingStore } from "./recordingStore";

function CameraPreview({ stream }: { readonly stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.srcObject = stream;
    void video.play().catch(() => undefined);
    return () => {
      video.srcObject = null;
    };
  }, [stream]);
  return (
    <video
      ref={ref}
      muted
      playsInline
      data-testid="recording-camera-preview"
      className="size-9 shrink-0 -scale-x-100 rounded-full border-2 border-white/80 object-cover shadow"
    />
  );
}

export function ScreenRecordingBar() {
  const session = useScreenRecordingStore((state) => state.session);
  const elapsedMs = useScreenRecordingStore((state) => state.elapsedMs);
  const pause = useScreenRecordingStore((state) => state.pause);
  const resume = useScreenRecordingStore((state) => state.resume);
  const stop = useScreenRecordingStore((state) => state.stop);
  const cancel = useScreenRecordingStore((state) => state.cancel);
  const [elapsed, setElapsed] = useState(0);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const active = session.phase === "recording" || session.phase === "paused";
  useEffect(() => {
    if (!active) {
      setElapsed(0);
      setConfirmDiscard(false);
      return;
    }
    setElapsed(elapsedMs());
    const id = setInterval(() => setElapsed(elapsedMs()), 250);
    return () => clearInterval(id);
  }, [active, elapsedMs]);

  if (session.phase === "idle") return null;

  if (session.phase === "starting" || session.phase === "finishing") {
    return (
      <div
        data-testid="recording-bar"
        data-phase={session.phase}
        className="fixed top-2 left-1/2 z-[60] -translate-x-1/2 rounded-full border bg-popover px-4 py-2 text-sm text-muted-foreground shadow-lg"
      >
        {session.phase === "starting" ? "Choose what to share…" : "Finishing the recording…"}
      </div>
    );
  }

  const paused = session.phase === "paused";
  const nearLimit = elapsed >= RECORDING_WARN_MS;
  return (
    <div
      data-testid="recording-bar"
      data-phase={session.phase}
      role="toolbar"
      aria-label="Screen recording"
      className="fixed top-2 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-full border bg-popover py-1.5 pr-2 pl-1.5 shadow-lg"
    >
      {session.cameraStream ? <CameraPreview stream={session.cameraStream} /> : null}
      <span className="flex items-center gap-1.5 pl-1 text-sm font-medium tabular-nums">
        <span
          className={cn(
            "size-2.5 rounded-full",
            paused ? "bg-muted-foreground" : "animate-pulse bg-red-500",
          )}
        />
        <span data-testid="recording-time">{formatClock(elapsed)}</span>
        {nearLimit ? (
          <span className="text-xs font-normal text-amber-600 dark:text-amber-400">
            · stops at {formatClock(RECORDING_MAX_MS)}
          </span>
        ) : null}
        {paused ? (
          <span className="text-xs font-normal text-muted-foreground">· paused</span>
        ) : null}
      </span>
      {!session.hasMicrophone ? (
        <span
          className="text-xs text-muted-foreground"
          title="Your microphone isn't recorded — the agent only sees the screen"
          data-testid="recording-no-mic"
        >
          no mic
        </span>
      ) : null}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={paused ? "Resume" : "Pause"}
        title={paused ? "Resume" : "Pause"}
        data-testid="recording-pause"
        onClick={paused ? resume : pause}
      >
        {paused ? <PlayIcon /> : <PauseIcon />}
      </Button>
      {confirmDiscard ? (
        <>
          <span className="text-xs text-muted-foreground">Discard?</span>
          <Button
            size="xs"
            variant="destructive"
            data-testid="recording-discard-confirm"
            onClick={cancel}
          >
            Discard
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setConfirmDiscard(false)}>
            Keep
          </Button>
        </>
      ) : (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Discard recording"
          title="Discard"
          data-testid="recording-discard"
          onClick={() => setConfirmDiscard(true)}
        >
          <Trash2Icon />
        </Button>
      )}
      <Button size="sm" data-testid="recording-stop" onClick={() => void stop("person")}>
        <span className="size-2.5 rounded-[2px] bg-current" />
        Done
      </Button>
    </div>
  );
}
