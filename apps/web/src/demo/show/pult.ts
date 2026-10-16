// Pult 4: the "Показать" buttons of the "what to look at" panel (q1–q6).
// Each puts Work into the state to look at: a chat of a task in the middle,
// the Pult on the right (switch 1) or the Pult screen in the middle (switch 2).
import type { getRouter } from "../../router";
import { makePultFile, type PreviewFile } from "../../components/preview/PreviewPaneContext";
import { usePultStore } from "../../pult/pultStore";
import { demoHooks, demoShow, demoSwitch } from "../demoFlag";
import { PULT_DEMO } from "../pultThreads";
import { waitFor } from "./p4";

interface PaneHandle {
  readonly currentChatThreadId: string | null;
  readonly currentProjectKey: string;
  readonly setOpen: (open: boolean) => void;
  readonly setPreviewLayoutMode: (mode: "sidebar" | "focus") => void;
  readonly setWidth: (width: number) => void;
  readonly setActiveFile: (id: string) => void;
  readonly openFileForTarget: (
    target: { projectKey: string; threadId: string | null },
    scope: "chat" | "project" | "global",
    file: PreviewFile,
  ) => void;
}

const pane = () => demoHooks.previewPane as PaneHandle | undefined;
const router = () => demoHooks.router as ReturnType<typeof getRouter> | undefined;
const phone = () => window.innerWidth < 768;
const store = () => usePultStore.getState();

/** The chat of a task in the middle, the Pult tab in front on the right. */
async function chatWithPult(chatId: string) {
  const chat = PULT_DEMO.chats.find((c) => c.id === chatId);
  if (!chat?.thread) return;
  await router()?.navigate({ to: "/$environmentId/$threadId", params: chat.thread as never });
  await waitFor(() => pane()?.currentChatThreadId === chat.thread!.threadId);
  const p = pane();
  if (!p) return;
  p.openFileForTarget({ projectKey: p.currentProjectKey, threadId: p.currentChatThreadId }, "global", makePultFile());
  await waitFor(() => pane() !== p);
  pane()?.setActiveFile(makePultFile().id);
  pane()?.setPreviewLayoutMode(phone() ? "focus" : "sidebar");
  pane()?.setOpen(true);
  if (!phone()) pane()?.setWidth(440);
}

/** Start where the Pult lives in this variant: a chat + the panel, or the Pult screen. */
async function start(chatId = "ch-kv") {
  if (demoSwitch("pult") === "center" || phone()) {
    await router()?.navigate({ to: "/pult" });
    await waitFor(() => location.hash.includes("/pult"));
    return;
  }
  await chatWithPult(chatId);
}

function clickByText(selector: string, text: string) {
  const el = [...document.querySelectorAll<HTMLElement>(selector)].find((n) => n.textContent?.trim().startsWith(text));
  el?.click();
  return !!el;
}

demoShow.q1 = async () => {
  store().setView("board");
  store().openTask(null);
  await start();
};

demoShow.q2 = async () => {
  store().setView("board");
  store().openTask(null);
  store().undoAnswer("T07");
  await (demoSwitch("pult") === "center" || phone() ? start() : chatWithPult("ch-kv"));
  await waitFor(() => !!document.querySelector('[data-testid="pult-need-T07"]'));
  await new Promise((r) => setTimeout(r, 700));
  clickByText('[data-testid="pult-need-T07"] button', "Всем по промокоду");
};

demoShow.q3 = async () => {
  const task = PULT_DEMO.tasks.find((t) => t.id === "T06")!;
  if (phone()) await start();
  store().openTask(task.id);
  if (!phone()) await chatWithPult(task.owner ?? "ch-onb");
};

demoShow.q4 = async () => {
  await start();
  store().askDispatcher("нужна ли помощь спаркам?");
};

demoShow.q5 = async () => {
  await start();
  store().askDispatcher("посмотрел новый экран пробника, тут кнопку «Add a card» переделать — мелкая на телефоне", [
    `${import.meta.env.BASE_URL}demo-files/hero-variants.png`,
  ]);
};

demoShow.q6 = async () => {
  await start();
  store().setView("wishes");
};
