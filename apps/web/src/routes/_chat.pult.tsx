import { createFileRoute } from "@tanstack/react-router";

import { PultScreen } from "../components/pult/PultScreen";

/** `/pult` — the board of agent work in the middle of Uno Work. */
export const Route = createFileRoute("/_chat/pult")({
  component: PultScreen,
});
