/**
 * Pult 4 mock: the chats behind Misha's tasks become real chats of the mock
 * world (on MacBook, uno-work and uno-product), so a click on a task opens the
 * real chat in the middle of Uno Work. Demo only: imported by demoBoot.
 */
import { PULT_DEMO_DATA } from "./pultFixtures";
import { CHATS, MACHINES, PROJECTS, type ChatSpec, type DemoState, type MachineKey } from "./heavyFixtures";
import type { PultChat, PultChatState, PultData } from "../pult/pult.types";

const MACHINE_OF: Record<string, MachineKey> = { mac: "mac", "uno-work": "work", "uno-product": "product" };

// Folders the Pult chats live in that the mock world does not have yet.
const EXTRA_PROJECTS: Record<MachineKey, ReadonlyArray<{ id: string; title: string; root: string }>> = {
  work: [
    { id: "p-work-spark", title: "spark-engine", root: "/home/uno/projects/spark-engine" },
    { id: "p-work-vmm", title: "uno-vmm", root: "/home/uno/projects/uno-vmm" },
    { id: "p-work-content", title: "content-site", root: "/home/uno/projects/content-site" },
    { id: "p-work-dax", title: "dax", root: "/home/uno/projects/dax" },
  ],
  product: [
    { id: "p-product-fishcode", title: "fishcode", root: "/home/uno/projects/fishcode" },
    { id: "p-product-qa", title: "qa-runner", root: "/home/uno/qa-runner" },
    { id: "p-product-model-lab", title: "model-lab", root: "/home/uno/projects/model-lab" },
  ],
  mac: [{ id: "p-mac-console", title: "uno-console", root: "/Users/misha/projects/uno-console" }],
};
for (const [key, list] of Object.entries(EXTRA_PROJECTS) as Array<[MachineKey, (typeof EXTRA_PROJECTS)[MachineKey]]>) {
  for (const project of list) {
    if (!PROJECTS[key].some((p) => p.id === project.id)) PROJECTS[key].push(project);
  }
}

function projectFor(machine: MachineKey, name: string | undefined): string {
  const found = PROJECTS[machine].find((p) => p.title === name);
  return found?.id ?? PROJECTS[machine].find((p) => p.title === "uno-project")?.id ?? `p-${machine}-home`;
}

const STATE_OF: Record<PultChatState, DemoState> = {
  working: "running",
  needs_you: "needs-you",
  idle: "read",
  quiet: "read",
  paused_limit: "failed",
  dead: "failed",
  sleeping: "read",
};

const NOW = Date.parse(PULT_DEMO_DATA.NOW);
const minutesAgo = (iso: string) => Math.max(1, Math.round((NOW - Date.parse(iso)) / 60000));

export const pultThreadId = (chatId: string) => `pult-${chatId}`;

function chatSpec(chat: PultChat): ChatSpec {
  const machine = MACHINE_OF[chat.machine] ?? "product";
  const last = chat.messages.at(-1);
  const asking = [...chat.messages].reverse().find((m) => m.options?.length);
  const state = STATE_OF[chat.state];
  return {
    id: pultThreadId(chat.id),
    machine,
    project: projectFor(machine, chat.project),
    title: chat.title,
    minutesAgo: minutesAgo(chat.lastAt),
    state,
    role: "solo",
    ...(state === "running" ? { runningFor: 12, now: (last?.text.split("\n")[0] ?? "").slice(0, 80) } : {}),
    ...(state === "needs-you" && asking
      ? { ask: { kind: "question" as const, text: asking.text.split("\n")[0] ?? "", options: asking.options ?? [] } }
      : {}),
    ...(chat.state === "paused_limit"
      ? { error: "Встал на лимите подписки Claude · shubaduba. Продолжит после сброса.", errorClass: "billing_error" as const }
      : {}),
    messages: chat.messages.map((m) => [m.who === "misha" ? "user" : "assistant", m.text] as const),
  };
}

CHATS.push(...PULT_DEMO_DATA.chats.map(chatSpec));

/** Pult data with every chat tied to its chat in the mock world. */
export const PULT_DEMO: PultData = {
  ...PULT_DEMO_DATA,
  chats: PULT_DEMO_DATA.chats.map((chat) => ({
    ...chat,
    thread: {
      environmentId: MACHINES[MACHINE_OF[chat.machine] ?? "product"].environmentId,
      threadId: pultThreadId(chat.id),
    },
  })),
};
