// Variant C (28.10): one Uno on the account, Uno works on every computer,
// your own assistants under Uno. Main flows first, then the edges. The
// creation flows (gallery, build your own, long name, face fails) are in
// c-create.flow.mjs.
import { dismissBanners, flow, openDemo, openMainChat, scene, seeText, send } from "../harness.mjs";

const inbox = async (page) => {
  await page.getByTestId("sidebar-needs-you").first().click();
  await page.getByTestId("inbox-popover").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(600);
};

const openProfile = async (page, projectId, machine = "work") => {
  await page.evaluate(
    ([key, project]) => {
      const env = window.__assistDemo.environmentOf(key);
      location.hash = `#/assistants?view=profile&env=${env}&project=${project}`;
    },
    [machine, projectId],
  );
  await page.getByTestId("assistant-profile").waitFor({ timeout: 15_000 });
  await page.waitForTimeout(800);
};

const modeChip = (page) => page.getByTestId("assistant-mode-chip").first();

/** Main: a new person — Work opens straight in Uno's chat; apps, Telegram and the mode as cards. */
export default flow("c-first-run", async ({ page, url, step, shot }) => {
  await step("a new account opens Work — Uno's chat, not a setup", async () => {
    await openDemo(page, url, { world: "new" });
    await seeText(page, "Hi, I'm Uno", 20_000);
  });
  await shot("uno-talks-first");
  await step("connect Gmail from the card in the chat", async () => {
    await seeText(page, "Connect Gmail & Calendar");
    const popup = page
      .context()
      .waitForEvent("page", { timeout: 5_000 })
      .catch(() => null);
    await page.getByRole("button", { name: /Connect Gmail & Calendar/ }).click();
    (await popup)?.close().catch(() => undefined);
    await seeText(page, "Gmail & Calendar is connected", 20_000);
  });
  await step("link Telegram with one tap", async () => {
    await seeText(page, "Talk to me in Telegram");
    await shot("telegram-card");
    await page
      .getByRole("button", { name: /Connect Telegram/ })
      .first()
      .click();
    await seeText(page, "Linked: @uno_team_bot", 20_000);
  });
  await step("pick the mode: two choices", async () => {
    await seeText(page, "How should I work?", 20_000);
    await shot("mode-card");
    await page.getByText("Asks first", { exact: true }).last().click();
    const submit = page.getByRole("button", { name: /^(Submit|Send|Continue|Answer)/ }).last();
    if (await submit.isVisible().catch(() => false)) await submit.click();
    await seeText(page, "Done — I'll ask first", 20_000);
    await seeText(page, "what's on fire", 20_000);
  });
  await step("the header shows Uno's mode", async () => {
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="assistant-mode-chip"]')?.getAttribute("data-mode") ===
        "asks-first",
      null,
      { timeout: 20_000 },
    );
  });
  await shot("done");
});

export const flows = [
  /** Main: the morning summary — one summary: computers + what the team did, through Uno. */
  flow("c-morning-summary", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url));
    await step("08:00 — Uno writes first", async () => {
      await scene(page, "c-morning");
      await seeText(page, "One summary for everything", 20_000);
      await seeText(page, "Mia: moved your 11:00");
    });
    await shot("summary");
    await step("the Inbox has it (and Telegram)", async () => {
      await inbox(page);
      await seeText(page, "Uno: your morning summary");
    });
    await shot("inbox");
  }),

  /** Main: "Asks first" — Allow from the chat. */
  flow("c-asks-first-allow", async ({ page, url, step, shot }) => {
    await step("open live, Uno asks first", () => openDemo(page, url, { mode: "asks-first" }));
    await step("a Telegram message asks to send the reminder", async () => {
      await scene(page, "telegram-message");
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

  /** Main: "Asks first" — Decline keeps the draft. */
  flow("c-asks-first-decline", async ({ page, url, step, shot }) => {
    await step("open live, Uno asks first", () => openDemo(page, url, { mode: "asks-first" }));
    await step("the card comes", async () => {
      await scene(page, "telegram-message");
      await seeText(page, "Send an email to billing@acme.example", 20_000);
    });
    await step("Decline", async () => {
      await page
        .getByRole("button", { name: /^(Decline|Deny|Don't allow)/ })
        .first()
        .click();
      await seeText(page, "The draft stays in Gmail", 20_000);
    });
    await shot("declined");
  }),

  /** Main: "Does it itself" — the same ask goes out without a card. */
  flow("c-itself-no-card", async ({ page, url, step, shot }) => {
    await step("open live, Uno does it itself", () => openDemo(page, url, { mode: "itself" }));
    await step("the reminder goes out at once", async () => {
      await openMainChat(page);
      await send(page, "send the Acme reminder");
      await seeText(page, "Sent to billing@acme.example", 20_000);
      if (
        await page
          .getByRole("button", { name: /^Allow/ })
          .first()
          .isVisible()
          .catch(() => false)
      )
        throw new Error("an Allow card showed in Does it itself");
    });
    await shot("sent-without-asking");
  }),

  /** Main: a task on the MacBook — Uno uses it, nothing to set up; seen in the sidebar and the Inbox. */
  flow("c-task-on-mac", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url));
    await step("Uno starts it on the MacBook", async () => {
      await scene(page, "elsewhere");
      await seeText(page, "on MacBook. I'll tell you when it's done");
    });
    await step("the sidebar shows Uno working on the MacBook", async () => {
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('[data-testid="sidebar-uno-hand"]')].some(
            (row) =>
              row.getAttribute("data-machine")?.includes("MacBook") &&
              /running/.test(row.textContent ?? ""),
          ),
        null,
        { timeout: 15_000 },
      );
    });
    await shot("running-on-mac");
    await step("the result comes back to Uno", () => seeText(page, "Done on MacBook", 30_000));
    await shot("done");
    await step("the Inbox says which computer", async () => {
      await inbox(page);
      await seeText(page, "Finished on MacBook");
      await page.getByTestId("inbox-item-machine").first().waitFor({ timeout: 5_000 });
    });
    await shot("inbox-with-machine");
  }),

  /** Main: a task for your own assistant, through Uno — Mia asks first, Uno doesn't. */
  flow("c-task-to-teammate", async ({ page, url, step, shot }) => {
    await step("open live (Uno does it itself, Mia asks first)", () =>
      openDemo(page, url, { mode: "itself" }),
    );
    await step("tell Uno: ask Mia", async () => {
      await scene(page, "c-delegate");
      await seeText(page, "Mia has it", 20_000);
    });
    await shot("uno-gave-it-to-mia");
    await step("Mia's ask comes through Uno — in the Inbox", async () => {
      await page.waitForTimeout(5_000);
      await inbox(page);
      await seeText(page, "Mia (via Uno) asks", 20_000);
    });
    await shot("mia-asks-via-uno");
    await step("Allow from the Inbox → Mia's report in Uno's chat", async () => {
      await page.getByRole("button", { name: "Allow", exact: true }).first().click();
      await openMainChat(page);
      await seeText(page, "Mia finished", 25_000);
    });
    await shot("report-in-uno-chat");
  }),

  /** Main: three computers — the sidebar, the switcher, the Inbox name the computer. */
  flow("c-three-computers", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url));
    await step("the sidebar: Uno, its computers, the team", async () => {
      await page.getByTestId("sidebar-uno-hand").nth(2).waitFor({ timeout: 15_000 });
    });
    await shot("sidebar");
    await step("the computer switcher shows what Uno does on each", async () => {
      await openMainChat(page);
      await page.getByTestId("chat-computer-chip").first().click();
      await page.getByTestId("computer-switcher-uno").first().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(700);
    });
    await shot("switcher");
    await page.keyboard.press("Escape");
    await step("Uno's page: where it works and the team", async () => {
      await openProfile(page, "assistant-home");
      await page.getByTestId("uno-works-on").waitFor();
      await page.getByTestId("uno-team").waitFor();
    });
    await shot("uno-page");
  }),

  /** Main: manage a teammate — rename, change the mode, remove. */
  flow("c-manage-teammate", async ({ page, url, step, shot }) => {
    await step("open Mia's page", async () => {
      await openDemo(page, url);
      await openProfile(page, "assistant-mia");
    });
    await shot("mia-page");
    await step("rename", async () => {
      await page.getByTestId("assistant-profile-who-edit").click();
      const name = page.getByTestId("assistant-profile-who-editor").locator("input").first();
      await name.fill("Mia Sato");
      await page
        .getByTestId("assistant-profile-who-editor")
        .getByRole("button", { name: "Save" })
        .click();
      await page
        .getByTestId("assistant-profile")
        .getByRole("heading", { name: "Mia Sato" })
        .waitFor({ timeout: 15_000 });
    });
    await step("switch the mode to Does it itself", async () => {
      await page.getByTestId("assistant-mode-card-itself").click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="assistant-mode-card-itself"]')
            ?.getAttribute("aria-pressed") === "true",
        null,
        { timeout: 20_000 },
      );
    });
    await shot("renamed-and-mode");
    await step("remove from the team", async () => {
      await page.getByTestId("teammate-remove-start").click();
      await shot("confirm");
      await page.getByTestId("teammate-remove-confirm").click();
      await page.waitForFunction(
        () =>
          !document.querySelector(
            '[data-testid="sidebar-assistant"][data-assistant="assistant-mia"]',
          ),
        null,
        { timeout: 20_000 },
      );
    });
    await shot("removed");
  }),

  // ── Edges ──────────────────────────────────────────────────────────────

  /** Edge: Free — the cloud computer slept; Uno catches up when Work opens, honest line + Plus. */
  flow("edge-c-free-asleep", async ({ page, url, step, shot }) => {
    await step("open live on Free", () => openDemo(page, url, { tier: "free" }));
    await step("Uno catches up on opening", async () => {
      await seeText(page, "slept from 23:10", 25_000);
      await page.getByTestId("uno-free-banner").waitFor({ timeout: 10_000 });
      await seeText(page, "Keep Uno awake");
    });
    await shot("catch-up-and-banner");
    await step("the sidebar says it sleeps", () => seeText(page, "sleeps on Free"));
  }),

  /** Edge: the MacBook is asleep — Uno asks where; "wait" goes to the Inbox. */
  flow("edge-c-mac-asleep", async ({ page, url, step, shot }) => {
    await step("open live, MacBook asleep", () => openDemo(page, url, { mac: "asleep" }));
    await step("the sidebar: MacBook asleep, tasks wait", () =>
      seeText(page, "asleep · tasks wait"),
    );
    await shot("sidebar-mac-asleep");
    await step("ask for the deck", async () => {
      await scene(page, "elsewhere");
      await seeText(page, "Your MacBook is asleep", 20_000);
    });
    await shot("asks-where");
    await step("wait for the Mac", async () => {
      await page.getByText("Wait for the MacBook", { exact: true }).first().click();
      const submit = page.getByRole("button", { name: /^(Submit|Send|Continue|Answer)/ }).last();
      if (await submit.isVisible().catch(() => false)) await submit.click();
      await seeText(page, "When the MacBook wakes", 20_000);
    });
    await shot("waits");
  }),

  /** Edge: Gmail's sign-in expired — the real Connectors list says so; Reconnect fixes it. */
  flow("edge-c-gmail-expired", async ({ page, url, step, shot }) => {
    await step("open live, Gmail expired", () => openDemo(page, url, { gmail: "expired" }));
    await step("Uno says it in the chat", async () => {
      await openMainChat(page);
      await send(page, "send the Acme reminder");
      await seeText(page, "Gmail ended its sign-in", 20_000);
    });
    await shot("chat");
    await step("Settings → Connectors: Sign-in expired", async () => {
      await page.evaluate(() => {
        location.hash = "#/settings/connectors";
      });
      await page.getByTestId("connector-expired-gmail").waitFor({ timeout: 15_000 });
    });
    await shot("connectors-expired");
    await step("Reconnect (Google's page closes by itself)", async () => {
      await page.getByTestId("setup-connect-gmail").click();
      await page
        .getByTestId("connector-expired-gmail")
        .waitFor({ state: "detached", timeout: 25_000 });
    });
    await shot("reconnected");
  }),

  /** Edge: Asks first, Work closed — the Allow waits in the Inbox and Telegram, no refusal. */
  flow("edge-c-ask-while-closed", async ({ page, url, step, shot }) => {
    await step("open live, Asks first", () => openDemo(page, url, { mode: "asks-first" }));
    await step("the 16:00 reminder fires with no chat open", async () => {
      await scene(page, "reminder-closed");
      await page.evaluate(() => {
        location.hash = "#/";
      });
      await page.waitForTimeout(4_000);
    });
    await step("it waits in the Inbox (and Telegram)", async () => {
      await inbox(page);
      await seeText(page, "Also sent to your Telegram", 20_000);
    });
    await shot("waits-in-inbox");
    await step("Allow from the Inbox → it goes out", async () => {
      await page.getByRole("button", { name: "Allow", exact: true }).first().click();
      await openMainChat(page);
      await seeText(page, "Sent to billing@acme.example", 20_000);
    });
  }),

  /** Edge: the task on another computer fails — said with the computer, Uno offers another. */
  flow("edge-c-mac-fails", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url));
    await step("the build on the MacBook fails", async () => {
      await scene(page, "c-mac-fails");
      await seeText(page, "It failed on MacBook", 25_000);
    });
    await shot("failed");
    await step("run it on uno-work", async () => {
      await page.getByText("Run on uno-work", { exact: true }).first().click();
      const submit = page.getByRole("button", { name: /^(Submit|Send|Continue|Answer)/ }).last();
      if (await submit.isVisible().catch(() => false)) await submit.click();
      await seeText(page, "Done on uno-work", 30_000);
    });
    await shot("done-on-uno-work");
    await step("the Inbox names the computer of the failure", async () => {
      await inbox(page);
      await seeText(page, "Failed on MacBook");
    });
    await shot("inbox");
  }),

  /** Edge: Telegram not linked — an Allow waits only in Work, and says how to get it on the phone. */
  flow("edge-c-telegram-off", async ({ page, url, step, shot }) => {
    await step("open live, Asks first, no Telegram", () =>
      openDemo(page, url, { mode: "asks-first", tg: "off" }),
    );
    await step("the reminder fires", async () => {
      await scene(page, "reminder-closed");
      await seeText(page, "Send an email to billing@acme.example", 20_000);
    });
    await step("the Inbox: waits here, link Telegram for the phone", async () => {
      await inbox(page);
      await seeText(page, "Link Telegram to answer from your phone", 20_000);
      if (
        await page
          .getByText("Also sent to your Telegram")
          .first()
          .isVisible()
          .catch(() => false)
      )
        throw new Error("said Telegram while it isn't linked");
    });
    await shot("inbox-no-telegram");
  }),

  /** Edge: 10+ own assistants — the sidebar keeps 4 and "Show N more". */
  flow("edge-c-many-teammates", async ({ page, url, step, shot }) => {
    await step("open live with 12 teammates", () => openDemo(page, url, { team: "many" }));
    await step("the sidebar folds them", async () => {
      await page.getByTestId("sidebar-team-more").waitFor({ timeout: 15_000 });
      await seeText(page, "Show 8 more");
    });
    await shot("folded");
    await step("unfold", async () => {
      await page.getByTestId("sidebar-team-more").click();
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="sidebar-assistant"]').length >= 13,
        null,
        { timeout: 10_000 },
      );
    });
    await shot("all");
    await step("Uno's page lists the team", async () => {
      await openProfile(page, "assistant-home");
      await page.getByTestId("uno-team").waitFor();
      await page.getByTestId("uno-team").scrollIntoViewIfNeeded();
    });
    await shot("uno-page-team");
  }),

  /** Edge: remove a teammate mid-task — Uno takes the task over and finishes it. */
  flow("edge-c-remove-mid-task", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url));
    await step("Uno gives Mia a long task", async () => {
      await scene(page, "c-mia-slow");
      await seeText(page, "Mia has it", 20_000);
    });
    await step("open Mia's page while she works", async () => {
      await openProfile(page, "assistant-mia");
      await page.getByTestId("teammate-remove-start").click();
      await seeText(page, "is in the middle of", 10_000);
    });
    await shot("confirm-mid-task");
    await step("remove → Uno takes over", async () => {
      await page.getByTestId("teammate-remove-confirm").click();
      await seeText(page, "I'm taking it over", 20_000);
      await seeText(page, "myself", 25_000);
    });
    await shot("uno-finished-it");
  }),

  /** Edge: change the mode mid-task — Uno and Mia keep different modes. */
  flow("edge-c-mode-mid-task", async ({ page, url, step, shot }) => {
    await step("open live, Uno does it itself", () => openDemo(page, url, { mode: "itself" }));
    await step("Uno starts a long task", async () => {
      await scene(page, "c-investor");
      await seeText(page, "Collecting October numbers", 20_000);
    });
    await step("switch Uno to Asks first mid-task", async () => {
      await modeChip(page).click();
      await page.getByTestId("assistant-mode-asks-first").click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="assistant-mode-chip"]')
            ?.getAttribute("data-mode") === "asks-first",
        null,
        { timeout: 20_000 },
      );
    });
    await shot("switched-mid-task");
    await step("the send now waits for Allow", async () => {
      await seeText(page, "Send “October update” to 4 investors", 30_000);
    });
    await shot("asks-now");
    await step("Mia keeps her own mode", async () => {
      await openProfile(page, "assistant-home");
      await page.getByTestId("uno-team").scrollIntoViewIfNeeded();
      await seeText(page, "Secretary · Asks first");
      await seeText(page, "Developer · Does it itself");
    });
    await shot("team-modes");
  }),
];

void dismissBanners;
