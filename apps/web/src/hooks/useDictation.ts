/**
 * useDictation - Voice input for the chat composer.
 *
 * Records with MediaRecorder, ships the clip to the local backend
 * (`server.transcribeAudio`), which forwards it to the Uno Gateway's
 * `/audio/transcriptions`; the account API key never reaches the browser.
 */

import { useCallback, useRef, useState } from "react";

import { readLocalApi } from "../localApi";

export type DictationState = "idle" | "recording" | "transcribing";

/** Safari records audio/mp4; everything else prefers opus-in-webm. */
const RECORDER_MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

const pickRecorderMimeType = (): string | undefined =>
  RECORDER_MIME_CANDIDATES.find((candidate) => MediaRecorder.isTypeSupported(candidate));

const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read recorded audio."));
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      const commaIndex = dataUrl.indexOf(",");
      resolve(commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : "");
    };
    reader.readAsDataURL(blob);
  });

export const isDictationSupported = (): boolean =>
  typeof navigator !== "undefined" &&
  typeof navigator.mediaDevices?.getUserMedia === "function" &&
  typeof MediaRecorder !== "undefined";

export function useDictation(callbacks: {
  readonly onTranscript: (text: string) => void;
  readonly onError: (message: string) => void;
}): {
  readonly state: DictationState;
  readonly start: () => Promise<void>;
  readonly stop: () => void;
  readonly cancel: () => void;
} {
  const [state, setState] = useState<DictationState>("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const discardRef = useRef(false);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const start = useCallback(async () => {
    if (recorderRef.current) {
      return;
    }
    if (!isDictationSupported()) {
      callbacksRef.current.onError(
        typeof window !== "undefined" && window.isSecureContext === false
          ? "Microphone access requires a secure (https) connection."
          : "Microphone recording is not supported in this browser.",
      );
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      callbacksRef.current.onError("Microphone access was denied.");
      return;
    }
    const mimeType = pickRecorderMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    discardRef.current = false;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    recorder.onstop = () => {
      for (const track of recorder.stream.getTracks()) {
        track.stop();
      }
      recorderRef.current = null;
      if (discardRef.current) {
        setState("idle");
        return;
      }
      setState("transcribing");
      void (async () => {
        try {
          const type = recorder.mimeType || mimeType || "audio/webm";
          const baseType = type.split(";")[0] ?? type;
          const blob = new Blob(chunks, { type: baseType });
          if (blob.size === 0) {
            throw new Error("Nothing was recorded.");
          }
          const api = readLocalApi();
          if (!api) {
            throw new Error("Local backend API is unavailable.");
          }
          const audioBase64 = await blobToBase64(blob);
          const extension = baseType.includes("mp4")
            ? "mp4"
            : baseType.includes("ogg")
              ? "ogg"
              : "webm";
          const result = await api.server.transcribeAudio({
            audioBase64,
            mimeType: baseType,
            fileName: `dictation.${extension}`,
          });
          const text = result.text.trim();
          if (text.length === 0) {
            throw new Error("No speech was recognized.");
          }
          callbacksRef.current.onTranscript(text);
        } catch (error) {
          callbacksRef.current.onError(error instanceof Error ? error.message : String(error));
        } finally {
          setState("idle");
        }
      })();
    };
    recorderRef.current = recorder;
    recorder.start(1000);
    setState("recording");
  }, []);

  const stop = useCallback(() => {
    recorderRef.current?.stop();
  }, []);

  const cancel = useCallback(() => {
    if (!recorderRef.current) {
      return;
    }
    discardRef.current = true;
    recorderRef.current.stop();
  }, []);

  return { state, start, stop, cancel };
}
