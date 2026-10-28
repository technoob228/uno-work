// Variant A (28.10): edge flows — sleep, expired sign-ins, failures, removal and
// mode changes mid-task, a heavy account, long names, a face that can't be drawn.
import { flow, openDemo, openMainChat, scene, seeText, send } from "../harness.mjs";
import { choose, createFromGallery, openInbox, openUnoPage } from "./a.flow.mjs";

export const flows = [
  /** Free: uno-work slept overnight — Uno catches up when Work opens; honest line + Plus. */
  flow("e-free-sleeps", async ({ page, url, step, shot }) => {
    await step("open live on Free", () => openDemo(page, url, { tier: "free" }));
    await step("the sidebar says it naps", () =>
      page.getByTestId("sidebar-uno-home").filter({ hasText: "sleeps on Free" }).waitFor(),
    );
    await step("open Uno: the catch-up summary is there", async () => {
      await page.getByTestId("sidebar-assistant-open").first().click();
      await seeText(page, "was asleep from 19:10 to 09:12", 25_000);
      await seeText(page, "waited for you overnight");
    });
    await step("the honest line and the way to Plus", async () => {
      await page.getByTestId("uno-sleep-notice").waitFor();
      await page.getByTestId("uno-sleep-notice-plus").waitFor();
      await page
        .getByText(/wakes when you open Work/)
        .first()
        .waitFor();
    });
    await shot("catch-up-and-plus");
  }),

  /** The MacBook is asleep when a task needs it: Uno asks where, runs it on uno-work. */
  flow("e-mac-asleep", async ({ page, url, step, shot }) => {
    await step("open live, MacBook asleep", () => openDemo(page, url, { mac: "asleep" }));
    await step("ask for the deck", async () => {
      await openMainChat(page);
      await send(page, "Export the deck on my Mac");
      await seeText(page, "Your MacBook is asleep", 20_000);
    });
    await shot("asks-where");
    await step("run it on uno-work", async () => {
      await choose(page, /Run on uno-work/);
      await seeText(page, "Done on uno-work", 30_000);
    });
    await shot("done-on-uno-work");
  }),

  /** Gmail's sign-in expired: the real connectors list says so; the chat offers to sign in again. */
  flow("e-gmail-expired", async ({ page, url, step, shot }) => {
    await step("open live, Gmail expired", () => openDemo(page, url, { gmail: "expired" }));
    await step("Settings → Connectors: Sign-in expired", async () => {
      await page.evaluate(() => {
        location.hash = "#/settings/connectors";
      });
      await page.getByTestId("connector-expired-gmail").waitFor({ timeout: 20_000 });
    });
    await shot("connectors-expired");
    await step("Uno says so when it needs Gmail", async () => {
      await openMainChat(page);
      await send(page, "send the Acme reminder");
      await seeText(page, "Gmail ended its sign-in", 20_000);
      await seeText(page, "Sign in to Gmail & Calendar again");
    });
    await shot("chat-reconnect-card");
    await step("sign in again from the card → connected", async () => {
      const popup = page
        .context()
        .waitForEvent("page", { timeout: 4_000 })
        .catch(() => null);
      await page.getByRole("button", { name: /Connect Gmail & Calendar/ }).click();
      (await popup)?.close().catch(() => undefined);
      await seeText(page, "Gmail & Calendar is connected", 20_000);
    });
    await shot("reconnected");
  }),

  /** "Asks first" with Work closed: the 16:00 reminder waits in Needs you (and Telegram). */
  flow("e-ask-while-closed", async ({ page, url, step, shot }) => {
    await step("open live, Asks first", () => openDemo(page, url, { mode: "asks-first" }));
    await step("16:00 fires while no chat is open", async () => {
      await scene(page, "reminder-closed");
      await page.evaluate(() => {
        location.hash = "#/";
      });
      await page.waitForTimeout(4_000);
    });
    await step("it waits in Needs you, not refused", async () => {
      await openInbox(page);
      await seeText(page, "Also sent to your Telegram", 20_000);
    });
    await shot("waits-in-inbox");
    await step("Allow from Needs you → it goes out", async () => {
      await page.getByRole("button", { name: "Allow", exact: true }).first().click();
      await openMainChat(page);
      await seeText(page, "Sent to billing@acme.example", 20_000);
    });
    await shot("sent");
  }),

  /** A task on the MacBook fails there: red line in its chat, Needs-you-free retry on uno-work. */
  flow("e-task-failed-elsewhere", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url));
    await step("the build fails on the MacBook", async () => {
      await scene(page, "build-fails");
      await seeText(page, "It failed on MacBook", 30_000);
      await seeText(page, "Try the build on uno-work instead?");
    });
    await shot("failed-offer");
    await step("try on uno-work → green", async () => {
      await choose(page, /Try on uno-work/);
      await seeText(page, "Done on uno-work", 30_000);
    });
    await shot("green-on-uno-work");
    await step("the failed chat on the MacBook says why", async () => {
      await page
        .getByTestId("sidebar-d-chats")
        .getByText("Build the landing for launch")
        .first()
        .click();
      await seeText(page, "Inter.woff2 is missing", 15_000);
    });
    await shot("mac-chat-error");
  }),

  /** No Telegram yet: the morning summary offers it once; one tap links it. */
  flow("e-telegram-off", async ({ page, url, step, shot }) => {
    await step("open live, Telegram not linked", () => openDemo(page, url, { tg: "off" }));
    await step("the summary, then the Telegram card", async () => {
      await scene(page, "morning");
      await seeText(page, "things today", 20_000);
      await seeText(page, "Talk to me in Telegram", 20_000);
    });
    await shot("summary-telegram-card");
    await step("one tap → linked", async () => {
      await page
        .getByRole("button", { name: /Connect Telegram/ })
        .first()
        .click();
      await seeText(page, "Linked: @uno_team_bot", 20_000);
    });
    await step("Uno's page shows it linked", async () => {
      await openUnoPage(page);
      await page
        .getByTestId("assistant-page-telegram")
        .getByText("Linked")
        .waitFor({ timeout: 20_000 });
    });
    await shot("page-linked");
  }),

  /** A heavy account: 12 channels and 10 own assistants — the sidebar folds them. */
  flow("e-many", async ({ page, url, step, shot }) => {
    await step("open live, many", () => openDemo(page, url, { many: "on" }));
    await step("5 channels + Show more, 5 assistants + more", async () => {
      await page.getByTestId("sidebar-uno-channels-more").waitFor();
      await page.getByTestId("sidebar-own-assistants-more").waitFor();
    });
    await shot("folded");
    await step("unfold both", async () => {
      await page.getByTestId("sidebar-uno-channels-more").click();
      await page.getByTestId("sidebar-own-assistants-more").click();
      await page.getByText("# family", { exact: true }).waitFor();
      await page.locator('[data-assistant="assistant-pixel"]').waitFor();
    });
    await shot("unfolded");
    await step("Uno's page → Advanced lists them", async () => {
      await openUnoPage(page);
      await page.getByTestId("assistant-page-own").waitFor();
    });
    await shot("advanced-list");
  }),

  /** Remove an own assistant in the middle of its task: it stops, says so, nothing goes out. */
  flow("e-remove-mid-task", async ({ page, url, step, shot }) => {
    await step("open live, make Nova (researcher)", async () => {
      await openDemo(page, url);
      await createFromGallery(page, "nova");
      await page.getByTestId("gallery-create").click();
      await seeText(page, "Nova here", 20_000);
    });
    await step("give her a long job", async () => {
      await send(page, "Compare three suppliers for the shop");
      await seeText(page, "reading 12 supplier sites", 20_000);
    });
    await shot("working");
    await step("remove her from her page while she works", async () => {
      await page.getByTestId("teammate-headline").click();
      await page.getByTestId("assistant-page-remove").click();
      await page.getByTestId("assistant-page-remove-confirm").click();
      await page.getByTestId("assistant-page-bring-back").waitFor({ timeout: 20_000 });
    });
    await step("her chat stopped with one honest line", async () => {
      await page
        .getByText("Nova", { exact: true })
        .first()
        .waitFor()
        .catch(() => undefined);
      await page.goBack();
      await seeText(page, "Stopped — Nova was removed", 20_000);
      await page.waitForTimeout(7_000);
      for (const later of ["Checking reviews", "Sent: 3 suppliers compared"]) {
        if (
          await page
            .getByText(later)
            .isVisible()
            .catch(() => false)
        ) {
          throw new Error(`it kept working after removal: “${later}”`);
        }
      }
    });
    await shot("stopped");
  }),

  /** Change the mode in the middle of a task: the outward step waits for Allow. */
  flow("e-mode-mid-task", async ({ page, url, step, shot }) => {
    await step("open live, Does it itself", () => openDemo(page, url, { mode: "itself" }));
    await step("start the launch checklist", async () => {
      await openMainChat(page);
      await send(page, "Go through the launch checklist and publish");
      await seeText(page, "Going through the launch checklist", 20_000);
    });
    await step("switch to Asks first at the top while it runs", async () => {
      await page.getByTestId("assistant-mode-chip").click();
      await page.getByTestId("assistant-mode-asks-first").click();
      await page
        .getByTestId("assistant-mode-chip")
        .filter({ hasText: "Asks first" })
        .waitFor({ timeout: 20_000 });
    });
    await shot("switched");
    await step("publishing now waits for Allow", async () => {
      await page.getByTestId("assistant-allow-card").waitFor({ timeout: 30_000 });
      await seeText(page, "Publish shop-site");
    });
    await shot("allow-card");
    await step("Decline → not published", async () => {
      await page.getByTestId("assistant-allow-decline").click();
      await seeText(page, "Not published", 20_000);
    });
  }),

  /** A very long name: capped at 40 with a counter; the sidebar and header cut it neatly. */
  flow("e-long-name", async ({ page, url, step, shot }) => {
    await step("open live → Uno's page", async () => {
      await openDemo(page, url);
      await openUnoPage(page);
    });
    await step("rename to a 60-character name → 40 kept", async () => {
      await page.getByTestId("assistant-page-rename").click();
      await page
        .getByTestId("assistant-page-name-input")
        .fill("Maximilian Alexander von Uno-Assistentenberg der Dritte III");
      await shot("typing");
      await page.getByTestId("assistant-page-name-save").click();
      await page.getByTestId("assistant-page-name").waitFor({ timeout: 20_000 });
    });
    await shot("page");
    await step("the chat header and the sidebar cut it", async () => {
      await page.getByTestId("assistant-page-open-chat").click();
      await page
        .getByText(/· Everything/)
        .first()
        .waitFor({ timeout: 15_000 });
    });
    await shot("chat");
    await step("the builder caps a long name too", async () => {
      await createFromGallery(page, "own", {
        name: "A really very long assistant name that goes on and on and on",
      });
      await page.getByTestId("gallery-name-count").filter({ hasText: "40/40" }).waitFor();
    });
    await shot("builder-40");
  }),

  /** Drawing a face fails: one clear line, the emoji stays, creation still works. */
  flow("e-face-fails", async ({ page, url, step, shot }) => {
    await step("open live, faces fail", () => openDemo(page, url, { face: "fail" }));
    await step("Build your own → Persona → Human", async () => {
      await createFromGallery(page, "own", { name: "Ivy" });
      await page.getByTestId("gallery-face-tab-persona").click();
      await page.getByTestId("gallery-persona-human").click();
      await page.getByTestId("gallery-face-problem").waitFor({ timeout: 15_000 });
    });
    await shot("face-failed");
    await step("create anyway with the emoji", async () => {
      await page.getByTestId("gallery-create").click();
      await seeText(page, "Ivy here", 20_000);
    });
    await shot("created");
  }),
];
