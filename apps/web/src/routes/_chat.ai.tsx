import { createFileRoute } from "@tanstack/react-router";

import { UnoAiRoute } from "../unoai/UnoAiRoute";
import type { UnoAiSearch } from "../unoai/UnoAiView";

export const Route = createFileRoute("/_chat/ai")({
  validateSearch: (search: Record<string, unknown>): UnoAiSearch => {
    const out: { chat?: string; q?: string } = {};
    const chat = search["chat"];
    if (typeof chat === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(chat)) out.chat = chat;
    const q = search["q"];
    if (typeof q === "string" && q.trim()) out.q = q.trim().slice(0, 2000);
    return out;
  },
  component: UnoAiRouteView,
});

function UnoAiRouteView() {
  const search = Route.useSearch();
  return <UnoAiRoute search={search} />;
}
