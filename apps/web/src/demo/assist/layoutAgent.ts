/**
 * T55 demo: "make me a sidebar with …" in an assistant's chat. The assistant
 * calls `sidebar_layout_propose` (uno-work MCP) with the blocks it picked; the
 * chat shows the proposal as a card (blocks/LayoutProposalCard.tsx) and the
 * sidebar changes only when the person presses Apply.
 */
import { widgetBlockId } from "../../blocks/layoutModel";
import { MACHINES } from "../heavyFixtures";
import { addTrigger } from "./engine";

/** «сделай мне сайдбар …», "make my sidebar …", "set up my sidebar …". */
export const LAYOUT_PHRASE =
  /(сайдбар|боковую панель|левую панель)|\b(sidebar)\b.*\b(make|set|build|change|for)\b|\b(make|set up|build|change)\b[^.?!]*\bsidebar\b/i;

let registered = false;

export function registerLayoutAgent() {
  if (registered) return;
  registered = true;
  addTrigger({
    id: "layout-phrase",
    match: LAYOUT_PHRASE,
    script: (ctx, text) => {
      const minimal = /минимал|minimal|только чаты|just (the )?chats/i.test(text);
      const pult = widgetBlockId(MACHINES.work.environmentId, "manifest:pult");
      const blocks = minimal
        ? [{ id: "places" }, { id: "chats" }]
        : [
            { id: "places" },
            { id: "needs-you" },
            { id: pult, size: "m" },
            { id: "pinned" },
            { id: "chats" },
          ];
      return [
        { work: "Looking at what you open most and which apps have widgets…", delay: 1_200 },
        {
          run: (inner) => {
            inner.ops.toolCall(inner.machine, inner.threadId, {
              server: "uno-work",
              tool: "sidebar_layout_propose",
              input: { blocks },
              output: {
                proposal: {
                  title: minimal ? "Minimal sidebar" : "Founder sidebar",
                  why: minimal
                    ? "Only the places and your chats. Assistants and Pinned move to the catalog — one click to bring back."
                    : "On top: what waits for your answer and Пульт (your agents and their questions). Assistants go to the catalog: you open them from Uno's chat anyway.",
                  blocks,
                },
              },
            });
          },
          delay: 900,
        },
        {
          say: minimal
            ? "Here's a minimal sidebar — press **Apply** to try it. Undo is one click, and everything else stays in the catalog."
            : "Here's a sidebar for how you work: **Needs you** and **Пульт** on top, then Pinned and the chats. Press **Apply** to try it — nothing changes until you do, and Undo brings the old one back.",
          delay: 1_000,
        },
      ];
    },
  });
}
