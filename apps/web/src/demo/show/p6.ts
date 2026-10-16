// Point 6 of the w0138 mock: "Показать" puts the interface into the state to look at.
//
// Uno's row on top of the sidebar unfolded: its chats, newest first — three,
// then "Show N more"; "+" on hover starts another chat with it. Opens the
// newest one so the row and the chat light up together.
import { ASSISTANT_PROJECT_ID } from "@t3tools/contracts";

import { unfoldAssistantInSidebar } from "../../components/sidebar/SidebarAssistants";
import type { getRouter } from "../../router";
import { demoHooks, demoShow } from "../demoFlag";
import { ENV_WORK } from "../heavyFixtures";

demoShow.p6 = async () => {
  unfoldAssistantInSidebar(`${ENV_WORK}:${ASSISTANT_PROJECT_ID}`);
  const router = demoHooks.router as ReturnType<typeof getRouter> | undefined;
  await router?.navigate({
    to: "/$environmentId/$threadId",
    params: { environmentId: ENV_WORK, threadId: "uno-main" },
  });
};
