// Point 7 of the w0138 mock: "Показать" puts the interface into the state to look at.
//
// "+ New assistant" pressed: the setup opens on its first screen (meet it →
// 6 steps). Each assistant's page opens from its face in the sidebar (Uno,
// Builder, Scout) or from the Inbox card "Uno set up assistant Scout".
import { useAssistantOnboarding } from "../../components/assistants/AssistantOnboarding";
import type { getRouter } from "../../router";
import { demoHooks, demoShow } from "../demoFlag";
import { ENV_WORK } from "../heavyFixtures";

demoShow.p7 = async () => {
  const router = demoHooks.router as ReturnType<typeof getRouter> | undefined;
  // Scout's page behind the setup: closing it leaves the team in view.
  await router?.navigate({
    to: "/assistants",
    search: { view: "profile", env: ENV_WORK, project: "assistant-scout" },
  });
  useAssistantOnboarding.getState().openNew(0);
};
