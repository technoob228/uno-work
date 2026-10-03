import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

/**
 * The Assistants screen and the console's ASSISTANTS_MVP flag (0.0.106): the
 * new assistants (New assistant, several per computer, their own computers)
 * show only where the account has them; everywhere else the screen is the
 * 0.0.105 one — this computer's one assistant.
 */

let availability: "loading" | "on" | "not-yet" | "no-account" = "not-yet";
const navigate = vi.fn();

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => navigate,
  useSearch: () => ({}),
}));
vi.mock("../../hooks/useActiveMachine", () => ({
  useActiveMachine: () => ({ environmentId: "env-1" }),
}));
vi.mock("./useAssistants", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAssistantsAvailability: () => availability,
  useAssistantList: () => [],
  useDeletedAssistants: () => [],
  useAssistantComputers: () => ({ data: [], isLoading: false }),
  useBoxIdOfEnvironment: () => null,
  useLocalAssistants: () => ({ data: [], isLoading: false }),
  useDeletedLocalAssistants: () => ({ data: [] }),
}));
// The computer's own assistant: not created yet.
vi.mock("../../lib/managerApi", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAssistant: () => Promise.reject(new Error("no assistant yet")),
}));
const { SidebarProvider } = await import("../ui/sidebar");
const { AssistantsView } = await import("./AssistantsView");

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SidebarProvider>
        <AssistantsView />
      </SidebarProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  availability = "not-yet";
  navigate.mockReset();
});

describe("Assistants and the account's assistants flag", () => {
  it("flag off: the 0.0.105 screen, nothing new", async () => {
    availability = "not-yet";
    const screen = await mount();
    await expect.element(screen.getByTestId("assistants-classic")).toBeInTheDocument();
    await expect
      .element(screen.getByTestId("assistants-empty"))
      .toHaveTextContent("Create an assistant that answers in Telegram 24/7");
    await expect
      .element(screen.getByTestId("assistants-empty-create"))
      .toHaveTextContent("Create an assistant");
    expect(screen.getByTestId("assistants-new").query()).toBeNull();
    expect(screen.getByText("New assistant").query()).toBeNull();
    expect(screen.getByText("its own computer").query()).toBeNull();
  });

  it("no Uno session here (the computer's direct address): the 0.0.105 screen too", async () => {
    availability = "no-account";
    const screen = await mount();
    await expect.element(screen.getByTestId("assistants-classic")).toBeInTheDocument();
    expect(screen.getByText("New assistant").query()).toBeNull();
  });

  it("while the flag is being read nothing new flashes", async () => {
    availability = "loading";
    const screen = await mount();
    await expect.element(screen.getByTestId("assistants-classic")).toBeInTheDocument();
    expect(screen.getByTestId("assistants-empty").query()).toBeNull();
    expect(screen.getByText("New assistant").query()).toBeNull();
  });

  it("flag on: the new assistants", async () => {
    availability = "on";
    const screen = await mount();
    await expect
      .element(screen.getByTestId("assistants-empty"))
      .toHaveTextContent("An assistant that works while you don't");
    await expect
      .element(screen.getByTestId("assistants-empty-create"))
      .toHaveTextContent("New assistant");
    expect(screen.getByTestId("assistants-classic").query()).toBeNull();
  });
});
