/**
 * Pictures of a finished recording at given moments, in the browser that has
 * it (Loom Work 28.10: the moments the person says "вот тут" / "this", found
 * in the timeline after the agent watched). Free and local: a hidden <video>
 * seeks its own copy and a canvas makes a JPEG — no upload, no ffmpeg.
 */
const SEEK_TIMEOUT_MS = 4000;

function once(target: EventTarget, events: string[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      for (const name of events) target.removeEventListener(name, onEvent);
      target.removeEventListener("error", onError);
      resolve(ok);
    };
    const onEvent = () => done(true);
    const onError = () => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    for (const name of events) target.addEventListener(name, onEvent, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

async function seek(video: HTMLVideoElement, seconds: number): Promise<boolean> {
  const wait = once(video, ["seeked"], SEEK_TIMEOUT_MS);
  video.currentTime = seconds;
  return wait;
}

export async function grabFramesFromBlob(
  blob: Blob,
  timesMs: number[],
  maxWidth: number,
): Promise<Array<{ t: number; blob: Blob; width: number; height: number }>> {
  if (timesMs.length === 0 || typeof document === "undefined") return [];
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  const out: Array<{ t: number; blob: Blob; width: number; height: number }> = [];
  try {
    if (video.readyState < 1 && !(await once(video, ["loadedmetadata"], SEEK_TIMEOUT_MS))) {
      return [];
    }
    // MediaRecorder's WebM has no duration until the end is seen.
    if (!Number.isFinite(video.duration)) {
      await seek(video, 1e101);
      await seek(video, 0);
    }
    const width = Math.min(maxWidth, video.videoWidth || maxWidth);
    const height = Math.max(2, Math.round(((video.videoHeight || 720) * width) / (video.videoWidth || 1280)));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return [];
    const end = Number.isFinite(video.duration) ? video.duration : Infinity;
    for (const t of [...timesMs].sort((a, b) => a - b)) {
      const seconds = Math.max(0, Math.min(t / 1000, end - 0.05));
      if (!(await seek(video, seconds))) continue;
      if (video.readyState < 2) await once(video, ["loadeddata", "canplay"], 1500);
      context.drawImage(video, 0, 0, width, height);
      const jpeg = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((value) => resolve(value), "image/jpeg", 0.82),
      );
      if (jpeg && jpeg.size > 0) out.push({ t, blob: jpeg, width, height });
    }
    return out;
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
