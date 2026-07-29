/**
 * dictationRecorder - microphone capture for composer dictation.
 *
 * Thin imperative wrapper over `getUserMedia` + `MediaRecorder`: React state
 * lives in `useDictation`, everything that touches browser media APIs lives
 * here so the hook stays testable and the teardown path (tracks, recorder,
 * audio graph) has exactly one owner.
 */

import type { DictationAudioMimeType } from "@t3tools/contracts";

/** Ordered by preference: opus in webm is small and always available in Electron. */
const CANDIDATE_MIME_TYPES: ReadonlyArray<{
  readonly recorder: string;
  readonly upload: DictationAudioMimeType;
}> = [
  { recorder: "audio/webm;codecs=opus", upload: "audio/webm" },
  { recorder: "audio/webm", upload: "audio/webm" },
  { recorder: "audio/ogg;codecs=opus", upload: "audio/ogg" },
  { recorder: "audio/mp4", upload: "audio/mp4" },
];

export type DictationRecorderErrorKind = "unsupported" | "permission" | "device" | "empty";

export class DictationRecorderError extends Error {
  readonly kind: DictationRecorderErrorKind;

  constructor(kind: DictationRecorderErrorKind, message: string) {
    super(message);
    this.name = "DictationRecorderError";
    this.kind = kind;
  }
}

export interface DictationCapture {
  readonly blob: Blob;
  readonly mimeType: DictationAudioMimeType;
  readonly durationMs: number;
}

export interface DictationRecording {
  /** Stop capture and resolve with the recorded audio. */
  readonly stop: () => Promise<DictationCapture>;
  /** Stop capture and throw the audio away. */
  readonly cancel: () => void;
  /** Current input loudness in `0..1`, for the level indicator. */
  readonly readLevel: () => number;
  readonly startedAt: number;
}

export function isDictationSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

function pickMimeType(): { recorder: string; upload: DictationAudioMimeType } | null {
  for (const candidate of CANDIDATE_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(candidate.recorder)) return candidate;
  }
  return null;
}

function translateMediaError(error: unknown): DictationRecorderError {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new DictationRecorderError(
      "permission",
      "Доступ к микрофону запрещён. Разрешите его в системных настройках и повторите.",
    );
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return new DictationRecorderError("device", "Микрофон не найден.");
  }
  return new DictationRecorderError(
    "device",
    error instanceof Error ? error.message : "Не удалось начать запись.",
  );
}

export async function startDictationRecording(): Promise<DictationRecording> {
  if (!isDictationSupported()) {
    throw new DictationRecorderError(
      "unsupported",
      "Этот клиент не умеет записывать звук (нет MediaRecorder).",
    );
  }

  const mimeType = pickMimeType();
  if (!mimeType) {
    throw new DictationRecorderError("unsupported", "Не найден поддерживаемый аудиокодек.");
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (error) {
    throw translateMediaError(error);
  }

  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream, { mimeType: mimeType.recorder });
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });

  // Separate graph purely for the level meter; failing to build it must not
  // block dictation, so every step is optional.
  let audioContext: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let levelBuffer: Uint8Array<ArrayBuffer> | null = null;
  try {
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    levelBuffer = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
  } catch {
    audioContext = null;
    analyser = null;
    levelBuffer = null;
  }

  const startedAt = Date.now();
  let settled = false;

  const teardown = () => {
    for (const track of stream.getTracks()) track.stop();
    if (audioContext) void audioContext.close().catch(() => {});
    audioContext = null;
    analyser = null;
    levelBuffer = null;
  };

  recorder.start();

  return {
    startedAt,
    readLevel: () => {
      if (!analyser || !levelBuffer) return 0;
      analyser.getByteTimeDomainData(levelBuffer);
      let peak = 0;
      for (const sample of levelBuffer) {
        peak = Math.max(peak, Math.abs(sample - 128) / 128);
      }
      return Math.min(1, peak);
    },
    stop: () =>
      new Promise<DictationCapture>((resolve, reject) => {
        if (settled) {
          reject(new DictationRecorderError("empty", "Запись уже завершена."));
          return;
        }
        settled = true;
        const durationMs = Date.now() - startedAt;
        recorder.addEventListener(
          "stop",
          () => {
            teardown();
            const blob = new Blob(chunks, { type: mimeType.recorder });
            if (blob.size === 0) {
              reject(new DictationRecorderError("empty", "Ничего не записалось."));
              return;
            }
            resolve({ blob, mimeType: mimeType.upload, durationMs });
          },
          { once: true },
        );
        if (recorder.state === "inactive") {
          teardown();
          reject(new DictationRecorderError("empty", "Запись прервалась."));
          return;
        }
        recorder.stop();
      }),
    cancel: () => {
      if (settled) return;
      settled = true;
      if (recorder.state !== "inactive") recorder.stop();
      teardown();
    },
  };
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}
