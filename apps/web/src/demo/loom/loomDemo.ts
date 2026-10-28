/**
 * Loom Work demo (VITE_DEMO=loom): the real composer, Record button, bar and
 * cards; the browser really records (screen, camera, voice). What a computer
 * and the gateway would do is answered here: staging, Uno Drive, the share
 * link, "watching" (a scripted transcript — no model in a static demo) and the
 * agent's reply. Scenarios for the edge cases: `?loom=` or the panel.
 */
import { demoHooks } from "../demoFlag";
import { overrideRecordingDeps } from "../../screenRecording/recordingRuntime";
import type { PipelineDeps } from "../../screenRecording/pipeline";
import { extractRecordingBlock } from "../../screenRecording/recordingLogic";

export type LoomScenario = "normal" | "drive-full" | "upload-breaks" | "watch-fails" | "silent";

export const LOOM_SCENARIOS: ReadonlyArray<{ id: LoomScenario; name: string; hint: string }> = [
  { id: "normal", name: "Всё хорошо", hint: "Drive, ссылка, агент посмотрел, слова в поле" },
  { id: "upload-breaks", name: "Загрузка оборвалась", hint: "Первая попытка падает → Retry" },
  { id: "watch-fails", name: "Агент не смог посмотреть", hint: "Шлюз упал один раз → Retry" },
  {
    id: "drive-full",
    name: "Drive забит",
    hint: "Нет места: видео не сохранить, агент всё равно смотрит",
  },
  { id: "silent", name: "Без голоса", hint: "Речи нет — в поле нейтральная просьба" },
];

const KEY = "demo:loom-scenario";

export function loomScenario(): LoomScenario {
  const fromUrl = new URLSearchParams(location.search).get("loom");
  if (fromUrl && LOOM_SCENARIOS.some((s) => s.id === fromUrl)) return fromUrl as LoomScenario;
  const stored = localStorage.getItem(KEY);
  return LOOM_SCENARIOS.some((s) => s.id === stored) ? (stored as LoomScenario) : "normal";
}

export function setLoomScenario(id: LoomScenario) {
  localStorage.setItem(KEY, id);
  const url = new URL(location.href);
  if (url.searchParams.has("loom")) {
    url.searchParams.delete("loom");
    history.replaceState(null, "", url);
  }
  failedOnce.clear();
}

const failedOnce = new Set<string>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Faster in the automated walk (`?speed=4`). */
const speed = () =>
  Math.max(1, Number(new URLSearchParams(location.search).get("speed") ?? 1) || 1);
const wait = (ms: number) => sleep(ms / speed());

export const SCRIPTED_SPEECH =
  "On the pricing page, put the Pro card first and highlight it. And make the Start free button green, like on the home page.";
export const SCRIPTED_VISUAL =
  "The Uno pricing page at localhost:5173/pricing: three plan cards — Small, Plus, Pro — each with a grey “Start free” button. The cursor circles the Pro card, then switches to the home page and points at its green “Get started” button.";

export const demoLog: string[] = [];

function demoDeps(): PipelineDeps {
  return {
    homePath: async () => "/home/uno",
    writeFile: async (input) => {
      demoLog.push(`write ${input.relativePath} ${input.mode ?? "replace"}`);
      await wait(350);
      if (
        loomScenario() === "upload-breaks" &&
        !input.relativePath.includes("agent-copy") &&
        !failedOnce.has("upload")
      ) {
        failedOnce.add("upload");
        throw new Error("The connection to uno-product dropped while uploading.");
      }
      return {};
    },
    driveState: async () => {
      await wait(150);
      const quota = 10 * 1024 ** 3;
      return {
        available: true,
        message: null,
        bucketId: 5,
        usedBytes: loomScenario() === "drive-full" ? quota - 64 * 1024 : 2.1 * 1024 ** 3,
        quotaBytes: quota,
      };
    },
    copyToCloud: async (input) => {
      demoLog.push(`drive ${input.prefix} ${input.paths.join(",")}`);
      await wait(700);
      return { files: 1, skipped: [] };
    },
    shareCreate: async (input) => {
      demoLog.push(`share ${input.key}`);
      await wait(200);
      return { url: `https://api.getuno.xyz/d/demo${Math.random().toString(36).slice(2, 10)}` };
    },
    describe: async (input) => {
      demoLog.push(`describe ${input.path} ${input.durationSec}s`);
      await wait(2600);
      if (loomScenario() === "watch-fails" && !failedOnce.has("watch")) {
        failedOnce.add("watch");
        throw new Error("Watching the recording failed: the gateway took too long. Try again.");
      }
      if (loomScenario() === "silent") return { speech: "", visual: SCRIPTED_VISUAL };
      return { speech: SCRIPTED_SPEECH, visual: SCRIPTED_VISUAL };
    },
    removePaths: async (paths) => {
      demoLog.push(`remove ${paths.join(",")}`);
      return {};
    },
  };
}

/** The agent's answer to a message with a recording (made up, plausible). */
export function loomReply(text: string): string | null {
  const { text: own, recording } = extractRecordingBlock(text);
  if (!recording) return null;
  const asked = own.trim() || recording.speech;
  return [
    `Watched your recording (${recording.duration}).`,
    "",
    asked ? `You asked: “${asked}”` : "You didn't say anything, so I went by what you showed.",
    "",
    "Done:",
    "- `src/pages/Pricing.tsx` — the Pro card goes first, with the accent border and a “Most popular” label",
    "- `src/components/PlanCard.tsx` — “Start free” uses the same green as “Get started” on the home page",
    "- Checked it in the browser at 1440 px and on a phone width",
    "",
    "Preview: http://localhost:5173/pricing",
    recording.driveKey
      ? `The video stays in Uno Drive → ${recording.driveKey.split("/")[0]}.`
      : "The video isn't in Uno Drive (it couldn't be saved) — I went by the summary.",
  ].join("\n");
}

export function startLoomDemo() {
  overrideRecordingDeps(() => demoDeps());
  demoHooks.replyTo = loomReply;
  (window as unknown as { __loomDemo: unknown }).__loomDemo = { log: demoLog, setLoomScenario };
}
