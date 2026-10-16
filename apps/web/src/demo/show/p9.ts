// Point 9 of the w0138 mock: advanced teammate settings (Connectors, browser & logins, passwords, skills).
//
// Builder's page scrolled to "What it can use": four blocks, each one plain
// line and one control; Details of Connectors opened (scopes, MCP tools).
// "Connectors in Settings" there opens Settings → Connectors (the source of
// truth); Uno's page shows the same as one line, "Full access to this computer".
import type { getRouter } from "../../router";
import { demoHooks, demoShow } from "../demoFlag";
import { ENV_PRODUCT } from "../heavyFixtures";
import { waitFor } from "./p4";

demoShow.p9 = async () => {
  const router = demoHooks.router as ReturnType<typeof getRouter> | undefined;
  await router?.navigate({
    to: "/assistants",
    search: { view: "profile", env: ENV_PRODUCT, project: "assistant-builder" },
  });
  const block = () =>
    document.querySelector<HTMLElement>("[data-testid=teammate-access-connectors]");
  if (!(await waitFor(() => block() !== null))) return;
  document
    .querySelector("[data-testid=assistant-profile-can-use]")
    ?.scrollIntoView({ block: "start", behavior: "smooth" });
  const details = block()?.querySelector<HTMLButtonElement>("button[aria-expanded=false]");
  details?.click();
};
