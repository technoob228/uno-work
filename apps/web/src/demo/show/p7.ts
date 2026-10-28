// Point 7 of the w0138 mock: "Показать" puts the interface into the state to look at.
//
// Misha 16.10: "+ New assistant" asks only its name and the AI it runs on;
// then a real chat with it opens and it sets itself up by asking — quiz
// cards, your own words, a field, a Connect button, Skip. The show plays it
// up to two answered questions, so "✓ Saved" is in view and the third waits.
// Each assistant's page opens from its face in the sidebar (Uno, Builder,
// Scout) or from the Inbox card "Uno set up assistant Scout".
import { useAssistantOnboarding } from "../../components/assistants/AssistantOnboarding";
import { demoShow } from "../demoFlag";
import { waitFor } from "./p4";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The option button of the question waiting in the composer. */
function optionButton(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("[data-chat-composer-form] button")].find(
    (button) => button.textContent?.trim().replace(/^\d/, "").trim().startsWith(label),
  );
}

async function answer(label: string) {
  if (!(await waitFor(() => optionButton(label) !== undefined, 10_000))) return false;
  await pause(900);
  optionButton(label)?.click();
  return true;
}

const start = () =>
  document.querySelector<HTMLButtonElement>("[data-testid=assistant-setup-start]");

demoShow.p7 = async () => {
  useAssistantOnboarding.getState().openNew();
  if (!(await waitFor(() => start() !== null))) return;
  // The form for a moment: a name and an AI, nothing else.
  await pause(1800);
  start()?.click();
  if (!(await answer("Sales"))) return;
  await answer("Friendly");
};
