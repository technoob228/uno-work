// The base's own flows — examples for the variants (copy, rename, change).
// Every flow starts from a world in the address (fresh browser storage).
import { flow, openDemo, openMainChat, scene, seeText, send } from "../harness.mjs";

/** Main: a new account — Uno talks first, the apps card, the Telegram card. */
export default flow("base-new-account", async ({ page, url, step, shot }) => {
  await step("open a new account", () => openDemo(page, url, { world: "new" }));
  await shot("home");
  await step("open Uno from the sidebar", async () => {
    await page.getByTestId("sidebar-assistant").getByText("Uno", { exact: true }).first().click();
    await seeText(page, "Hi, I'm Uno");
  });
  await step("the apps card: Connect Gmail inside the chat", async () => {
    await seeText(page, "Connect Gmail & Calendar");
    await shot("greeting-apps-card");
    const popup = page
      .context()
      .waitForEvent("page")
      .catch(() => null);
    await page.getByRole("button", { name: /Connect Gmail & Calendar/ }).click();
    (await popup)?.close().catch(() => undefined);
    await seeText(page, "Gmail & Calendar is connected", 20_000);
  });
  await step("the Telegram card: one tap", async () => {
    await seeText(page, "Talk to me in Telegram");
    await shot("telegram-card");
    await page
      .getByRole("button", { name: /Connect Telegram/ })
      .first()
      .click();
    await seeText(page, "Linked: @uno_team_bot", 20_000);
    await seeText(page, "what's burning");
  });
  await shot("done");
});

export const flows = [
  /** Main: "Asks first" — an Allow card in the chat and the Inbox; Allow sends. */
  flow("base-asks-first-allow", async ({ page, url, step, shot }) => {
    await step("open live, Asks first", () => openDemo(page, url, { mode: "asks-first" }));
    await step("a Telegram message asks to send the reminder", async () => {
      await scene(page, "telegram-message");
      await seeText(page, "Telegram: send the Acme reminder");
      await seeText(page, "Send an email to billing@acme.example", 20_000);
    });
    await shot("allow-card");
    await step("Allow", async () => {
      await page
        .getByRole("button", { name: /^(Approve|Allow)/ })
        .first()
        .click();
      await seeText(page, "Sent to billing@acme.example", 20_000);
    });
    await shot("sent");
  }),

  /** Main: "Does it itself" — the same ask goes out without a card. */
  flow("base-itself-no-card", async ({ page, url, step, shot }) => {
    await step("open live, Does it itself", () => openDemo(page, url, { mode: "itself" }));
    await step("the reminder goes out at once", async () => {
      await openMainChat(page);
      await send(page, "send the Acme reminder");
      await seeText(page, "Sent to billing@acme.example", 20_000);
    });
    await shot("sent-without-asking");
  }),

  /** Main: a task on the MacBook — steps there, the result back in Uno's chat. */
  flow("base-other-computer", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url));
    await step("Uno starts it on the MacBook", async () => {
      await scene(page, "elsewhere");
      await seeText(page, "on MacBook. I'll tell you when it's done");
    });
    await shot("started");
    await step("the result comes back", () => seeText(page, "Done on MacBook", 30_000));
    await shot("done");
  }),

  /** Main: the morning summary, Uno writes first. */
  flow("base-morning-summary", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url));
    await step("08:00 — the summary arrives", async () => {
      await scene(page, "morning");
      await seeText(page, "Here's today", 20_000);
    });
    await shot("summary");
  }),

  /** Edge: the MacBook is asleep — Uno asks where to run it instead of failing. */
  flow("edge-mac-asleep", async ({ page, url, step, shot }) => {
    await step("open live, MacBook asleep", () => openDemo(page, url, { mac: "asleep" }));
    await shot("home-mac-asleep");
    await step("ask for the deck", async () => {
      await scene(page, "elsewhere");
      await seeText(page, "Your MacBook is asleep", 20_000);
    });
    await shot("asks-where");
    await step("run it on uno-work", async () => {
      await page.getByText("Run on uno-work", { exact: true }).first().click();
      await seeText(page, "Done on uno-work", 30_000);
    });
    await shot("done-on-uno-work");
  }),

  /** Edge: Gmail's sign-in expired — Uno says so and offers to sign in again. */
  flow("edge-gmail-expired", async ({ page, url, step, shot }) => {
    await step("open live, Gmail expired", () => openDemo(page, url, { gmail: "expired" }));
    await step("ask to send", async () => {
      await openMainChat(page);
      await send(page, "send the Acme reminder");
      await seeText(page, "Gmail ended its sign-in", 20_000);
      await seeText(page, "Sign in to Gmail & Calendar again");
    });
    await shot("reconnect-card");
  }),

  /** Edge: Asks first, Work closed — the Allow waits in the Inbox, no refusal. */
  flow("edge-ask-while-closed", async ({ page, url, step, shot }) => {
    await step("open live, Asks first", () => openDemo(page, url, { mode: "asks-first" }));
    await step("the 16:00 reminder fires with no chat open", async () => {
      await scene(page, "reminder-closed");
      await page.evaluate(() => {
        location.hash = "#/";
      });
      await page.waitForTimeout(4_000);
    });
    await step("it waits in the Inbox (and Telegram), not refused", async () => {
      await page.getByText("Needs you", { exact: true }).first().click();
      await seeText(page, "Also sent to your Telegram", 20_000);
    });
    await shot("waits-in-inbox");
    await step("Allow from the Inbox → it goes out", async () => {
      await page.getByRole("button", { name: "Allow", exact: true }).first().click();
      await openMainChat(page);
      await seeText(page, "Sent to billing@acme.example", 20_000);
    });
    await shot("sent-after-inbox-allow");
  }),

  /** Edge: the assistant's turn fails — a clear error, nothing half-done. */
  flow("edge-error", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url));
    await step("the turn fails", async () => {
      await scene(page, "error");
      await seeText(page, "didn't answer in 60 s", 25_000);
    });
    await shot("error");
  }),
];

flows.push(
  /** Main: Uno's page (the real AssistantProfileSimple) and "+" — a new assistant. */
  flow("base-profile-and-create", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url));
    await step("Uno's page (from the sidebar)", async () => {
      await page.getByTestId("sidebar-assistant-face").first().click();
      await seeText(page, "Uno");
      await page.waitForTimeout(1500);
    });
    await shot("assistants-page");
    await step("“+” makes a new assistant on this computer", async () => {
      await page.getByTestId("sidebar-new-assistant").click();
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="sidebar-assistant"]').length >= 2,
        null,
        { timeout: 15_000 },
      );
      await page.waitForTimeout(1500);
    });
    await shot("after-create");
  }),
);
