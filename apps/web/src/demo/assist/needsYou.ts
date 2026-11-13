/**
 * The Needs-you screen's demo (Misha 13.11, the Pult redo): what the agents
 * filed outside the chats — two results to accept (before / after with real
 * screenshots of the 13.11 Work branches) and two tracker questions with
 * ready answers. The chats that wait come from fixtures.ts as usual.
 */
import { type ExternalAsk, useExternalAsksStore } from "../../needsYou/externalAsks";

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const shot = (file: string) => `/demo-files/needs-you/${file}`;

export function demoExternalAsks(): ReadonlyArray<ExternalAsk> {
  return [
    {
      kind: "review",
      id: "r-agent-tasks",
      from: "Work: agent tasks",
      createdAt: ago(95),
      version: 1,
      where: "Demo",
      title: "Chats an agent starts are now tasks inside its chat",
      summary:
        "The sidebar no longer fills with helper chats: they live in the coordinator's Tasks strip and show up only when they call you.",
      before: [
        "Every chat an agent started was its own row in the sidebar.",
        "Helpers' reports arrived in the coordinator as bubbles, nothing about the helpers themselves.",
      ],
      after: [
        "Helpers are gone from the sidebar, except the one that calls you (Checkout).",
        "The coordinator has a Tasks strip with statuses; reports fold into one line.",
      ],
      images: [
        { url: shot("tasks-before-1.jpg"), side: "before", caption: "Helpers as sidebar rows" },
        { url: shot("tasks-before-2.jpg"), side: "before", caption: "Reports as bubbles" },
        { url: shot("tasks-after-1.jpg"), side: "after", caption: "Only Checkout — it calls you" },
        { url: shot("tasks-after-2.jpg"), side: "after", caption: "The Tasks strip" },
      ],
      checks: [
        "Open “Pricing page” — the Tasks strip shows 4 tasks, one needs you",
        "Turn “Agents' tasks” on in the view menu — the helpers are back in the list",
      ],
      links: [{ label: "Open the demo", url: "https://misha-agent-tasks-1113.uno4.me/" }],
    },
    {
      kind: "review",
      id: "r-states",
      from: "Work: sidebar states",
      createdAt: ago(130),
      version: 1,
      where: "Demo",
      title: "Ready / Needs you only when you're really needed",
      summary:
        "A chat where agents talk among themselves no longer says Ready or notifies you; Needs you comes with the agent's reason.",
      before: [
        "“Pricing page” lit up Ready although the last word was a helper's.",
        "A chat where an agent called you in looked like any other Ready.",
      ],
      after: [
        "Agents talking among themselves: no Ready, a robot icon, hidden by Only mine.",
        "Called in: “Needs you” with the reason, in the Inbox too.",
      ],
      images: [
        { url: shot("states-before-1.png"), side: "before", caption: "Ready on agents' chatter" },
        { url: shot("states-after-1.png"), side: "after", caption: "Only mine: what's yours" },
        { url: shot("states-after-2.png"), side: "after", caption: "All chats: the robot icon" },
      ],
      checks: ["Card payments says Needs you; Pricing page doesn't say Ready"],
      links: [{ label: "Open the demo", url: "https://misha-sidebar-person-1113.uno4.me/" }],
    },
    {
      kind: "question",
      id: "q-plus-price",
      from: "Pricing page",
      createdAt: ago(48),
      title: "Raise Plus to $12 for new customers?",
      detail: "Current customers keep $10. 3 of 5 competitors are at $12–15.",
      options: ["Yes, from Monday", "Keep $10"],
    },
    {
      kind: "question",
      id: "q-outage-mail",
      from: "Support",
      createdAt: ago(21),
      title: "Write to the 3 customers hit by Tuesday's outage?",
      detail: "The draft apologises and adds a free week. It goes from your address.",
      options: ["Yes, send the draft", "I'll write myself"],
    },
  ];
}

export function installDemoExternalAsks() {
  useExternalAsksStore.getState().setAsks(demoExternalAsks());
}
