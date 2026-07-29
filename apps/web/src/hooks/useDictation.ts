/**
 * useDictation - composer voice input state machine.
 *
 * idle → starting → recording → transcribing → idle. Errors surface as toasts
 * and always return to idle; a failed take must never leave the mic hot or the
 * button stuck in a busy state.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { DICTATION_MAX_DURATION_MS, type DictationTranscribeResult } from "@t3tools/contracts";

import {
  blobToBase64,
  DictationRecorderError,
  type DictationRecording,
  isDictationSupported,
  startDictationRecording,
} from "~/dictation/dictationRecorder";
import { ensureLocalApi } from "~/localApi";
import { toastManager } from "~/components/ui/toast";

export type DictationStatus = "idle" | "starting" | "recording" | "transcribing";

export interface UseDictationOptions {
  readonly enabled: boolean;
  readonly projectPath?: string | undefined;
  /** Extra glossary hints the client knows (branch, model, provider). */
  readonly contextTerms?: readonly string[] | undefined;
  readonly onTranscript: (result: DictationTranscribeResult) => void;
}

export interface UseDictationResult {
  readonly status: DictationStatus;
  readonly supported: boolean;
  readonly elapsedMs: number;
  readonly level: number;
  readonly start: () => void;
  readonly stopAndTranscribe: () => void;
  readonly cancel: () => void;
  readonly toggle: () => void;
}

const errorMessage = (error: unknown): string => {
  if (error instanceof DictationRecorderError) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  return "Диктовка не удалась.";
};

export function useDictation(options: UseDictationOptions): UseDictationResult {
  const { enabled, projectPath, contextTerms, onTranscript } = options;
  const [status, setStatus] = useState<DictationStatus>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const recordingRef = useRef<DictationRecording | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  const statusRef = useRef<DictationStatus>("idle");
  const supported = isDictationSupported();

  onTranscriptRef.current = onTranscript;
  statusRef.current = status;

  const resetIndicators = useCallback(() => {
    setElapsedMs(0);
    setLevel(0);
  }, []);

  const cancel = useCallback(() => {
    const recording = recordingRef.current;
    recordingRef.current = null;
    recording?.cancel();
    if (statusRef.current !== "transcribing") {
      setStatus("idle");
    }
    resetIndicators();
  }, [resetIndicators]);

  // Recording indicators tick from a single interval instead of one timer per
  // concern; they are decorative, so 100ms is plenty.
  useEffect(() => {
    if (status !== "recording") return;
    const interval = window.setInterval(() => {
      const recording = recordingRef.current;
      if (!recording) return;
      setElapsedMs(Date.now() - recording.startedAt);
      setLevel(recording.readLevel());
    }, 100);
    return () => window.clearInterval(interval);
  }, [status]);

  const transcribe = useCallback(
    async (recording: DictationRecording) => {
      setStatus("transcribing");
      try {
        const capture = await recording.stop();
        const audioBase64 = await blobToBase64(capture.blob);
        const result = await ensureLocalApi().server.transcribeDictation({
          audioBase64,
          mimeType: capture.mimeType,
          durationMs: capture.durationMs,
          ...(projectPath !== undefined && projectPath.length > 0 ? { projectPath } : {}),
          ...(contextTerms && contextTerms.length > 0 ? { contextTerms } : {}),
        });
        if (result.text.trim().length === 0) {
          toastManager.add({ type: "warning", title: "Ничего не распознано" });
          return;
        }
        onTranscriptRef.current(result);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Диктовка не удалась",
          description: errorMessage(error),
        });
      } finally {
        recordingRef.current = null;
        setStatus("idle");
        resetIndicators();
      }
    },
    [contextTerms, projectPath, resetIndicators],
  );

  const stopAndTranscribe = useCallback(() => {
    const recording = recordingRef.current;
    if (!recording || statusRef.current !== "recording") return;
    void transcribe(recording);
  }, [transcribe]);

  const start = useCallback(() => {
    if (!enabled || !supported) return;
    if (statusRef.current !== "idle") return;
    setStatus("starting");
    void (async () => {
      try {
        const recording = await startDictationRecording();
        recordingRef.current = recording;
        setStatus("recording");
        setElapsedMs(0);
      } catch (error) {
        setStatus("idle");
        toastManager.add({
          type: "error",
          title: "Микрофон недоступен",
          description: errorMessage(error),
        });
      }
    })();
  }, [enabled, supported]);

  const toggle = useCallback(() => {
    if (statusRef.current === "recording") {
      stopAndTranscribe();
      return;
    }
    if (statusRef.current === "idle") {
      start();
    }
  }, [start, stopAndTranscribe]);

  // A take longer than the upload cap would be rejected server-side, so close
  // it out and transcribe what we have rather than losing the whole recording.
  useEffect(() => {
    if (status !== "recording") return;
    if (elapsedMs < DICTATION_MAX_DURATION_MS) return;
    stopAndTranscribe();
  }, [elapsedMs, status, stopAndTranscribe]);

  useEffect(() => () => recordingRef.current?.cancel(), []);

  return { status, supported, elapsedMs, level, start, stopAndTranscribe, cancel, toggle };
}
