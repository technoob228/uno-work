// Variant B (28.10): an assistant of its own on every computer. Main flows and
// edge flows, each with screenshots; B1 (group) and B2 (switcher) where the
// sidebar differs. Run: `node demo-e2e/run.mjs b-` (all B flows).
import { flow, openDemo, openMainChat, scene, seeText, send } from "../harness.mjs";

const WORK = "work";
const MAC = "mac";

async function answer(page, label) {
  await page.getByText(label, { exact: true }).first().click();
}

async function openInbox(page) {
  const row = page.getByTestId("sidebar-needs-you").first();
  if (await row.isVisible().catch(() => false)) await row.click();
  else await page.getByText("Needs you", { exact: true }).first().click();
  await page.getByTestId("inbox-popover").first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(700);
}

async function inboxAll(page) {
  await page.getByTestId("inbox-popover").getByText("All", { exact: true }).first().click();
  await page.waitForTimeout(400);
}

async function openSwitcher(page) {
  await page.evaluate(() => window.dispatchEvent(new Event("uno:open-computer-switcher")));
  await page.getByTestId("switcher-assistants").first().waitFor({ timeout: 10_000 });
}

async function goHome(page) {
  await page.evaluate(() => {
    location.hash = "#/";
  });
  await page.waitForTimeout(1200);
}

async function openPage(page, projectId, nth = 0) {
  await page
    .locator(`[data-testid=sidebar-assistant][data-assistant="${projectId}"]`)
    .nth(nth)
    .getByTestId("sidebar-assistant-face")
    .click();
  await page.getByTestId("assistant-profile").waitFor({ timeout: 15_000 });
  await page.waitForTimeout(800);
}

export const flows = [
  // ── Main ────────────────────────────────────────────────────────────────

  /** First run: Uno talks first → apps card → Telegram (one bot) → the mode. */
  flow("b-first-run", async ({ page, url, step, shot }) => {
    await step("a new account opens on Uno's chat", async () => {
      await openDemo(page, url, { world: "new", tier: "plus" });
      await seeText(page, "the assistant of this computer, uno-work", 20_000);
    });
    await step("the apps card: Connect Gmail inside the chat", async () => {
      await seeText(page, "Connect Gmail & Calendar");
      await shot("hello-apps-card");
      const popup = page
        .context()
        .waitForEvent("page")
        .catch(() => null);
      await page.getByRole("button", { name: /Connect Gmail & Calendar/ }).click();
      (await popup)?.close().catch(() => undefined);
      await seeText(page, "Gmail & Calendar is connected", 20_000);
    });
    await step("the Telegram card: one bot for all assistants", async () => {
      await seeText(page, "One bot for all your assistants");
      await shot("telegram-card");
      await page
        .getByRole("button", { name: /Connect Telegram/ })
        .first()
        .click();
      await seeText(page, "Linked: @uno_team_bot", 20_000);
    });
    await step("the mode: two options, Asks first", async () => {
      await seeText(page, "How should I work?", 20_000);
      await shot("mode-card");
      await answer(page, "Asks first");
      await seeText(page, "with an Allow button", 20_000);
      await seeText(page, "what's burning", 20_000);
    });
    await shot("done");
  }),

  /** Morning: one summary from each assistant, each card signed with its computer. */
  flow("b-morning-summary", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url));
    await step("08:00 — Uno · uno-work writes", async () => {
      await scene(page, "b-morning");
      await seeText(page, "From uno-work:", 20_000);
    });
    await shot("uno-work-summary");
    await step("Uno · MacBook wrote its own", async () => {
      await page.waitForTimeout(3500);
      await openMainChat(page, MAC);
      await seeText(page, "From this MacBook:", 20_000);
    });
    await shot("macbook-summary");
    await step("Needs you: one card per assistant, with the computer", async () => {
      await openInbox(page);
      await inboxAll(page);
      await seeText(page, "Uno · MacBook: your morning summary", 10_000);
      await seeText(page, "Uno · free-cloud slept through 08:00");
    });
    await shot("inbox-by-computer");
  }),

  /** Asks first: the Allow card in the chat (+ Inbox + Telegram); Allow sends. Decline keeps it. */
  flow("b-asks-first-allow-decline", async ({ page, url, step, shot }) => {
    await step("open live, Asks first", () => openDemo(page, url, { mode: "asks-first" }));
    await step("a Telegram message asks to send the reminder", async () => {
      await scene(page, "telegram-message");
      await seeText(page, "Send an email to billing@acme.example", 20_000);
    });
    await shot("allow-card");
    await step("Allow → sent", async () => {
      await page
        .getByRole("button", { name: /^(Approve|Allow)/ })
        .first()
        .click();
      await seeText(page, "Sent to billing@acme.example", 20_000);
    });
    await shot("sent");
    await step("again, Decline → stays a draft", async () => {
      await send(page, "send the Acme reminder");
      await page.waitForTimeout(2500);
      await page
        .getByRole("button", { name: /^(Decline|Deny|Don't allow|Cancel)/ })
        .first()
        .click();
      await seeText(page, "The draft stays in Gmail", 20_000);
    });
    await shot("declined");
  }),

  /** Does it itself: the same request goes out with no card. */
  flow("b-itself-no-card", async ({ page, url, step, shot }) => {
    await step("open live, Does it itself", () => openDemo(page, url, { mode: "itself" }));
    await step("the reminder goes out at once", async () => {
      await openMainChat(page);
      await send(page, "send the Acme reminder");
      await seeText(page, "Sent to billing@acme.example", 20_000);
    });
    await shot("sent-without-asking");
  }),

  /** B1: a task for the MacBook — Uno · uno-work passes it to Uno · MacBook. */
  flow("b-handoff-mac-B1", async ({ page, url, step, shot }) => {
    await step("open live (B1)", () => openDemo(page, url, { sb: "group" }));
    await step("Uno · uno-work: only sees uno-work, offers the neighbour", async () => {
      await scene(page, "b-handoff");
      await seeText(page, "The MacBook has its own assistant", 20_000);
    });
    await shot("offer-pass");
    await step("Pass it → its chat on the MacBook, steps there", async () => {
      await answer(page, "Pass it to Uno · MacBook");
      await seeText(page, "Passed from Uno · uno-work", 20_000);
    });
    await shot("on-macbook-working");
    await step("done there, and a card in Needs you", async () => {
      await seeText(page, "Done: pitch-deck.pdf (2.1 MB)", 30_000);
    });
    await shot("on-macbook-done");
    await step("Needs you shows it with the MacBook tag", async () => {
      await openInbox(page);
      await inboxAll(page);
      await seeText(page, "Uno · MacBook: pitch-deck.pdf is ready", 10_000);
    });
    await shot("inbox");
  }),

  /** B2: the same hand-off, with assistants in the computer switcher. */
  flow("b-handoff-mac-B2", async ({ page, url, step, shot }) => {
    await step("open live (B2)", () => openDemo(page, url, { sb: "switcher" }));
    await shot("sidebar-this-computer");
    await step("the switcher: each computer with its assistants", async () => {
      await openSwitcher(page);
    });
    await shot("switcher");
    await step("pick Uno · MacBook in the switcher", async () => {
      await page
        .locator('[data-testid=switcher-assistant][data-assistant="assistant-home"]')
        .nth(1)
        .click();
      await seeText(page, "sees only MacBook", 15_000);
    });
    await shot("macbook-chat-from-switcher");
    await step("hand-off from uno-work", async () => {
      await openMainChat(page, WORK);
      await scene(page, "b-handoff");
      await answer(page, "Pass it to Uno · MacBook");
      await seeText(page, "Done: pitch-deck.pdf (2.1 MB)", 30_000);
    });
    await shot("handoff-done");
  }),

  /** Three computers: B1 and B2 sidebars, Inbox with the computer of each card. */
  flow("b-three-computers-B1", async ({ page, url, step, shot }) => {
    await step("open live, team (B1)", () => openDemo(page, url, { cast: "team", sb: "group" }));
    await shot("sidebar");
    await step("Needs you with computer tags", async () => {
      await openInbox(page);
      await inboxAll(page);
      await page.getByTestId("assistant-machine-tag").first().waitFor({ timeout: 10_000 });
    });
    await shot("inbox");
  }),
  flow("b-three-computers-B2", async ({ page, url, step, shot }) => {
    await step("open live, team (B2)", () => openDemo(page, url, { cast: "team", sb: "switcher" }));
    await shot("sidebar");
    await step("the switcher", () => openSwitcher(page));
    await shot("switcher");
  }),

  /** Your own assistant from the gallery: Mia, on the MacBook (picked explicitly). */
  flow("b-gallery-character-on-mac", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url));
    await step("“+” opens the gallery", async () => {
      await page.getByTestId("sidebar-new-assistant").click();
      await page.getByTestId("assistant-gallery").waitFor({ timeout: 10_000 });
    });
    await shot("gallery");
    await step("Mia → Make Mia yours, lives on MacBook", async () => {
      await page.getByTestId("gallery-card-mia").click();
      await page.getByTestId("gallery-machine-MacBook").click();
      await seeText(page, "Sees only MacBook");
    });
    await shot("make-mia-yours");
    await step("Create → she writes first, in character, on the MacBook", async () => {
      await page.getByTestId("gallery-create").click();
      await seeText(page, "your secretary on MacBook", 25_000);
    });
    await shot("mia-writes-first");
  }),

  /** Build your own: name, role, character, a drawn face, Does it itself, on uno-work. */
  flow("b-gallery-build-own", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url));
    await step("Build your own", async () => {
      await page.getByTestId("sidebar-new-assistant").click();
      await page.getByTestId("gallery-build-own").click();
      await page.getByTestId("gallery-name").fill("Pip");
      await page.getByTestId("gallery-role-support").click();
      await page.getByTestId("gallery-slider-playful").fill("90");
      await page.getByTestId("gallery-tag-funny").click();
      await page.getByTestId("gallery-mode-itself").click();
      await page.getByTestId("gallery-machine-uno-work").click();
    });
    await step("draw a face", async () => {
      await page.getByTestId("gallery-face-tab-draw").click();
      await page.getByTestId("gallery-face-draw").click();
      await page.getByTestId("gallery-face-another").waitFor({ timeout: 20_000 });
    });
    await shot("form-with-face");
    await step("Create → Pip writes first (playful)", async () => {
      await page.getByTestId("gallery-create").click();
      await seeText(page, "Pip here", 25_000);
    });
    await shot("pip-writes-first");
  }),

  /** Manage: rename, switch the mode, remove. */
  flow("b-manage-rename-mode-remove", async ({ page, url, step, shot }) => {
    await step("open live with Mia", () => openDemo(page, url, { cast: "team" }));
    await step("Mia's page", () => openPage(page, "assistant-mia"));
    await shot("page");
    await step("rename", async () => {
      await page.getByTestId("assistant-profile-who-edit").click();
      const editor = page.getByTestId("assistant-profile-who-editor");
      await editor.getByLabel("Name", { exact: true }).fill("Mia Ops");
      await editor.getByRole("button", { name: "Save" }).click();
      await page
        .getByTestId("assistant-profile-name")
        .filter({ hasText: "Mia Ops" })
        .waitFor({ timeout: 20_000 });
    });
    await step("mode → Asks first", async () => {
      await page.getByTestId("assistant-mode-asks-first").click();
      await seeText(page, "Mia Ops: Asks first", 15_000);
    });
    await shot("renamed-asks-first");
    await step("remove", async () => {
      await page.getByTestId("assistant-remove").click();
      await shot("remove-question");
      await page.getByTestId("assistant-remove-confirm").click();
      await seeText(page, "is removed", 15_000);
    });
    await shot("removed");
  }),

  /** Connectors: Gmail's sign-in expired — in the real list, and whose assistants use it. */
  flow("b-connectors-expired", async ({ page, url, step, shot }) => {
    await step("open live, Gmail expired", () => openDemo(page, url, { gmail: "expired" }));
    await step("Settings → Connectors", async () => {
      await page.evaluate(() => {
        location.hash = "#/settings/connectors";
      });
      await page.getByTestId("settings-connectors").waitFor({ timeout: 15_000 });
      await seeText(page, "It stopped working. Sign in again to keep it.", 15_000);
      await page.getByTestId("connectors-machine").first().waitFor({ timeout: 10_000 });
    });
    await shot("list-expired");
    await page.getByTestId("connectors-machine").last().scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await shot("who-uses-them");
  }),

  // ── Edge ────────────────────────────────────────────────────────────────

  /** Free: the cloud computer sleeps — so does its assistant; an honest banner and the way to Plus. */
  flow("b-edge-free-asleep", async ({ page, url, step, shot }) => {
    await step("open live on Free", () => openDemo(page, url, { tier: "free" }));
    await step("Uno · uno-work's chat says it sleeps with its computer", async () => {
      await openMainChat(page);
      await page.getByTestId("assistant-free-banner").waitFor({ timeout: 15_000 });
    });
    await shot("free-banner");
    await step("Uno · free-cloud is asleep: why, and what to do", async () => {
      await page.getByTestId("sidebar-assistant-asleep").first().click();
      await page.getByTestId("assistant-asleep-sheet").waitFor({ timeout: 10_000 });
      await page.getByTestId("assistant-asleep-plus").waitFor();
    });
    await shot("asleep-sheet");
  }),

  /** The MacBook is asleep when a task is for it: it waits for Uno · MacBook (or runs here). */
  flow("b-edge-mac-asleep", async ({ page, url, step, shot }) => {
    await step("open live, MacBook asleep", () => openDemo(page, url, { mac: "asleep" }));
    await shot("sidebar-mac-asleep");
    await step("the hand-off: Uno · MacBook is asleep", async () => {
      await scene(page, "b-handoff");
      await seeText(page, "is asleep — the laptop is closed", 20_000);
    });
    await shot("offer-wait");
    await step("Leave it for Uno · MacBook → waits in Needs you", async () => {
      await answer(page, "Leave it for Uno · MacBook");
      await seeText(page, "starts when the laptop opens", 20_000);
      await openInbox(page);
      await inboxAll(page);
      await seeText(page, "Waiting for MacBook: Export the pitch deck", 10_000);
    });
    await shot("waits-in-inbox");
  }),

  /** Gmail expired: asked to send, the assistant says so and offers to sign in again. */
  flow("b-edge-gmail-expired", async ({ page, url, step, shot }) => {
    await step("open live, Gmail expired", () => openDemo(page, url, { gmail: "expired" }));
    await step("ask to send", async () => {
      await openMainChat(page);
      await send(page, "send the Acme reminder");
      await seeText(page, "Gmail ended its sign-in", 20_000);
      await seeText(page, "Sign in to Gmail & Calendar again");
    });
    await shot("reconnect-card");
  }),

  /** Asks first, Work closed: the Allow waits in the Inbox (and Telegram), no refusal. */
  flow("b-edge-ask-while-closed", async ({ page, url, step, shot }) => {
    await step("open live, Asks first", () => openDemo(page, url, { mode: "asks-first" }));
    await step("the 16:00 reminder fires with no chat open", async () => {
      await scene(page, "reminder-closed");
      await goHome(page);
      await page.waitForTimeout(3000);
    });
    await step("it waits in Needs you (and Telegram)", async () => {
      await openInbox(page);
      await seeText(page, "Also sent to your Telegram", 20_000);
    });
    await shot("waits-in-inbox");
    await step("Allow from Needs you → sent", async () => {
      await page.getByRole("button", { name: "Allow", exact: true }).first().click();
      await openMainChat(page);
      await seeText(page, "Sent to billing@acme.example", 20_000);
    });
    await shot("sent-after-inbox-allow");
  }),

  /** The task passed to the MacBook fails: a clear error there and in Needs you. */
  flow("b-edge-mac-task-fails", async ({ page, url, step, shot }) => {
    await step("open live, the MacBook job fails", () => openDemo(page, url, { macjob: "fail" }));
    await step("pass it", async () => {
      await scene(page, "b-handoff");
      await answer(page, "Pass it to Uno · MacBook");
      await seeText(page, "Keynote isn't on this MacBook", 30_000);
    });
    await shot("error-on-macbook");
    await step("Needs you", async () => {
      await openInbox(page);
      await inboxAll(page);
      await seeText(page, "Uno · MacBook couldn't export the deck", 10_000);
    });
    await shot("error-in-inbox");
  }),

  /** Telegram not linked: an Allow waits only in Work; the page offers Telegram. */
  flow("b-edge-telegram-off", async ({ page, url, step, shot }) => {
    await step("open live, Asks first, no Telegram", () =>
      openDemo(page, url, { mode: "asks-first", tg: "off" }),
    );
    await step("the reminder: it waits here (no Telegram)", async () => {
      await scene(page, "reminder-closed");
      await seeText(page, "Send an email to billing@acme.example", 20_000);
      await openInbox(page);
      await seeText(page, "It waits for you here.", 15_000);
    });
    await shot("waits-here-only");
    await step("its page: Connect Telegram is the next step", async () => {
      await openPage(page, "assistant-home");
      await seeText(page, "Telegram", 10_000);
    });
    await shot("page-connect-telegram");
  }),

  /** 12 assistants on 3 computers: B1 by computer, B2 in the switcher. */
  flow("b-edge-many-B1", async ({ page, url, step, shot }) => {
    await step("open live, 12 on 3 (B1)", () => openDemo(page, url, { cast: "many", sb: "group" }));
    await shot("sidebar-grouped");
    await step("unfold the sleeping free-cloud", async () => {
      await page
        .getByTestId("sidebar-assistants-machine")
        .filter({ hasText: "free-cloud" })
        .click();
      await page.waitForTimeout(500);
    });
    await shot("sidebar-free-cloud-open");
  }),
  flow("b-edge-many-B2", async ({ page, url, step, shot }) => {
    await step("open live, 12 on 3 (B2)", () =>
      openDemo(page, url, { cast: "many", sb: "switcher" }),
    );
    await shot("sidebar");
    await step("the switcher", () => openSwitcher(page));
    await shot("switcher");
  }),

  /** Remove an assistant in the middle of a task: it says what stops; the chat shows it stopped. */
  flow("b-edge-remove-mid-task", async ({ page, url, step, shot }) => {
    await step("open live with Mia", () => openDemo(page, url, { cast: "team" }, { speed: 1 }));
    await step("Mia starts a long task", async () => {
      await openMainChat(page, WORK, "assistant-mia");
      await send(page, "compare suppliers for the shop");
      await seeText(page, "Reading 12 supplier sites", 15_000);
    });
    await step("her page: Remove asks about the task", async () => {
      await page.getByTestId("machine-assistant-headline").click();
      await page.getByTestId("assistant-remove").click();
      await seeText(page, "is working on", 10_000);
    });
    await shot("remove-while-working");
    await step("Stop and remove → the chat says it stopped", async () => {
      await page.getByTestId("assistant-remove-confirm").click();
      await openMainChat(page, WORK, "assistant-mia");
      await seeText(page, "was removed. Nothing more was done", 20_000);
    });
    await shot("stopped-in-chat");
  }),

  /** Change the mode mid-task: from its next step — the send now waits for Allow. */
  flow("b-edge-mode-mid-task", async ({ page, url, step, shot }) => {
    await step("open live, Does it itself", () =>
      openDemo(page, url, { mode: "itself" }, { speed: 1 }),
    );
    await step("Uno starts the invoices", async () => {
      await openMainChat(page);
      await send(page, "send the invoices");
      await seeText(page, "Collecting October's unpaid invoices", 15_000);
    });
    await step("switch to Asks first on its page while it works", async () => {
      await page.getByTestId("machine-assistant-headline").click();
      await page.getByTestId("assistant-mode-asks-first").click();
      await seeText(page, "applies from its next step", 10_000);
    });
    await shot("switch-while-working");
    await step("back in the chat: the send waits for Allow", async () => {
      await openMainChat(page);
      await seeText(page, "Send 3 reminders", 25_000);
    });
    await shot("allow-after-switch");
  }),

  /** A very long name: cut in the sidebar and header, whole on its page. */
  flow("b-edge-long-name", async ({ page, url, step, shot }) => {
    await step("open live, a long name", () => openDemo(page, url, { cast: "long" }));
    await shot("sidebar");
    await step("its chat header", async () => {
      await page.getByTestId("sidebar-assistant-open").filter({ hasText: "Professor" }).click();
      await page.getByTestId("machine-assistant-headline").waitFor({ timeout: 15_000 });
    });
    await shot("header");
    await step("its page", async () => {
      await page.getByTestId("machine-assistant-headline").click();
      await page.getByTestId("assistant-profile").waitFor();
    });
    await shot("page");
  }),

  /** Drawing a face fails: a clear line, the emoji stays, Create still works. */
  flow("b-edge-face-fails", async ({ page, url, step, shot }) => {
    await step("open live, drawing fails", () => openDemo(page, url, { face: "fail" }));
    await step("Build your own → Draw a face", async () => {
      await page.getByTestId("sidebar-new-assistant").click();
      await page.getByTestId("gallery-build-own").click();
      await page.getByTestId("gallery-name").fill("Rook");
      await page.getByTestId("gallery-face-tab-draw").click();
      await page.getByTestId("gallery-face-draw").click();
      await page.getByTestId("gallery-face-error").waitFor({ timeout: 20_000 });
    });
    await shot("face-error");
    await step("Create anyway", async () => {
      await page.getByTestId("gallery-machine-uno-work").click();
      await page.getByTestId("gallery-create").click();
      await seeText(page, "I'm Rook", 25_000);
    });
    await shot("created-with-emoji");
  }),

  /** Two assistants with the same name on different computers. */
  flow("b-edge-same-name", async ({ page, url, step, shot }) => {
    await step("open live, Mia on uno-work", () => openDemo(page, url, { cast: "team" }));
    await step("a second Mia: same computer is blocked", async () => {
      await page.getByTestId("sidebar-new-assistant").click();
      await page.getByTestId("gallery-card-mia").click();
      await page.getByTestId("gallery-machine-uno-work").click();
      await seeText(page, "uno-work already has a Mia");
    });
    await shot("same-computer-blocked");
    await step("on the MacBook: allowed, told how they'll show", async () => {
      await page.getByTestId("gallery-machine-MacBook").click();
      await seeText(page, "There's a Mia on uno-work too");
    });
    await shot("other-computer-note");
    await step("create → two Mias, told apart by computer", async () => {
      await page.getByTestId("gallery-create").click();
      await seeText(page, "your secretary on MacBook", 25_000);
    });
    await shot("two-mias");
  }),
];
