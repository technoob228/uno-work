/**
 * Loom Work: the Record button of the composer (next to Attach and Dictate).
 * Idle → a small popover: what to record (screen / window / tab), camera and
 * microphone switches, Start. While recording → the same button stops it.
 */
import { AppWindowIcon, MonitorIcon, PanelTopIcon, VideoIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { Switch } from "../components/ui/switch";
import { ensureRecordingRuntime } from "./recordingRuntime";
import { type CaptureSource, isScreenRecordingSupported } from "./recordingLogic";
import { useScreenRecordingStore } from "./recordingStore";

const SOURCES: ReadonlyArray<{
  readonly id: CaptureSource;
  readonly label: string;
  readonly hint: string;
  readonly icon: typeof MonitorIcon;
}> = [
  { id: "screen", label: "Screen", hint: "Everything you show", icon: MonitorIcon },
  { id: "window", label: "Window", hint: "One app", icon: AppWindowIcon },
  { id: "tab", label: "Tab", hint: "A browser tab, with its sound", icon: PanelTopIcon },
];

export function screenRecordingAvailable(): boolean {
  if (typeof window === "undefined") return false;
  return isScreenRecordingSupported({
    mediaDevices: navigator.mediaDevices,
    MediaRecorder: typeof MediaRecorder === "undefined" ? undefined : MediaRecorder,
    isSecureContext: window.isSecureContext,
  });
}

export function RecordButton(props: {
  readonly threadKey: string | null;
  readonly environmentId: string | null;
  readonly compact?: boolean;
  readonly disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const options = useScreenRecordingStore((state) => state.options);
  const setOptions = useScreenRecordingStore((state) => state.setOptions);
  const phase = useScreenRecordingStore((state) => state.session.phase);
  const start = useScreenRecordingStore((state) => state.start);
  const stop = useScreenRecordingStore((state) => state.stop);
  const busy = phase !== "idle";
  // The desktop app shows the system's picker (screens and windows), no tabs.
  const sources = isElectron ? SOURCES.filter((source) => source.id !== "tab") : SOURCES;

  if (busy) {
    return (
      <Button
        variant="ghost"
        size="icon-sm"
        type="button"
        aria-label="Stop recording"
        title="Stop recording"
        data-testid="record-button"
        data-recording="true"
        className="animate-pulse text-red-500 hover:text-red-500"
        disabled={phase === "starting" || phase === "finishing"}
        onClick={() => void stop("person")}
      >
        <span className="size-3 rounded-[3px] bg-current" />
      </Button>
    );
  }

  const begin = () => {
    if (!props.threadKey || !props.environmentId) return;
    ensureRecordingRuntime();
    setOpen(false);
    void start({ threadKey: props.threadKey, environmentId: props.environmentId });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        data-testid="record-button"
        aria-label="Record your screen"
        title="Record your screen — the agent watches it and does what you show"
        disabled={props.disabled || !props.threadKey}
        className={cn(
          "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 hover:bg-accent hover:text-foreground/80 disabled:cursor-not-allowed disabled:opacity-50",
          props.compact ? "size-7" : "size-8 sm:size-7",
        )}
      >
        <VideoIcon className="size-4" />
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" className="w-[19rem]" data-testid="record-popup">
        <div className="flex flex-col gap-3">
          <div>
            <div className="text-sm font-semibold">Show the agent</div>
            <div className="text-xs text-muted-foreground">
              Record your screen and talk. The video goes to Uno Drive, the agent watches it and
              does what you showed.
            </div>
          </div>
          <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="What to record">
            {sources.map((source) => {
              const Icon = source.icon;
              const selected = options.source === source.id;
              return (
                <button
                  key={source.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  title={source.hint}
                  data-testid={`record-source-${source.id}`}
                  onClick={() => setOptions({ source: source.id })}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-md border px-2 py-2 text-xs hover:bg-accent",
                    selected ? "border-primary bg-accent font-medium" : "border-input",
                  )}
                >
                  <Icon className="size-4" />
                  {source.label}
                </button>
              );
            })}
          </div>
          <label className="flex items-center justify-between gap-2 text-sm">
            <span>
              Camera
              <span className="block text-xs text-muted-foreground">
                You in a circle, bottom left
              </span>
            </span>
            <Switch
              data-testid="record-camera"
              checked={options.camera}
              onCheckedChange={(checked) => setOptions({ camera: checked })}
            />
          </label>
          <label className="flex items-center justify-between gap-2 text-sm">
            <span>
              Microphone
              <span className="block text-xs text-muted-foreground">
                The agent hears what you say
              </span>
            </span>
            <Switch
              data-testid="record-microphone"
              checked={options.microphone}
              onCheckedChange={(checked) => setOptions({ microphone: checked })}
            />
          </label>
          <Button data-testid="record-start" onClick={begin} className="w-full">
            <span className="size-2.5 rounded-full bg-red-500" />
            Start recording
          </Button>
          <div className="text-[11px] leading-snug text-muted-foreground">
            Up to 10 minutes. {isElectron ? "macOS" : "Your browser"} asks what to share next.
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
