// Variant A (28.10): one Uno for the account, like Claude Duet. Main flows.
// Every flow starts from a world in the address (fresh browser storage).
import { composer, flow, openDemo, openMainChat, scene, seeText, send } from "../harness.mjs";

/** Click a quiz-card option / any button by its visible text. */
export async function choose(page, label) {
  await page.getByRole("button", { name: label }).first().click();
}

/** Opens Uno's page from its face in the sidebar. */
export async function openUnoPage(page) {
  await page.getByTestId("sidebar-assistant-face").first().click();
  await page.getByTestId("assistant-page-a").waitFor({ timeout: 15_000 });
}

/** Opens the Inbox ("Needs you") drawer and waits for it to settle. */
export async function openInbox(page) {
  await page.getByText("Needs you", { exact: true }).first().click();
  await page.waitForTimeout(900);
}

/** Uno's page → Advanced → gallery. */
export async function openGallery(page) {
  await openUnoPage(page);
  const toggle = page.getByTestId("assistant-page-advanced-toggle");
  if (
    !(await page
      .getByTestId("assistant-page-gallery")
      .isVisible()
      .catch(() => false))
  ) {
    await toggle.click();
  }
  await page.getByTestId("assistant-page-gallery").click();
  await page.getByTestId("assistant-gallery").waitFor({ timeout: 10_000 });
}

/** Gallery → a character (or "own") → its builder. */
export async function createFromGallery(page, character, { name } = {}) {
  await openGallery(page);
  if (character === "own") await page.getByTestId("gallery-build-own").click();
  else
    await page.locator(`[data-testid="gallery-character"][data-character="${character}"]`).click();
  await page.getByTestId("gallery-builder").waitFor();
  if (name !== undefined) await page.getByTestId("gallery-name").fill(name);
}

export default flow("a-first-run", async ({ page, url, step, shot }) => {
  await step("a new account opens on Uno, it talks first", async () => {
    await openDemo(page, url, { world: "new", tier: "plus" });
    await seeText(page, "Hi Misha, I'm Uno", 20_000);
  });
  await step("the apps card: Connect Gmail inside the chat", async () => {
    await seeText(page, "Connect Gmail & Calendar");
    await shot("intro-apps-card");
    const popup = page
      .context()
      .waitForEvent("page", { timeout: 4_000 })
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
  });
  await step("the mode card: two choices", async () => {
    await seeText(page, "How should I work?");
    await shot("mode-card");
    await page
      .getByRole("button", { name: /Asks first/ })
      .last()
      .click();
    await seeText(page, "I'll show it with an Allow button", 20_000);
    await page.getByTestId("assistant-mode-chip").filter({ hasText: "Asks first" }).waitFor();
  });
  await step("what's on fire → Uno starts", async () => {
    await seeText(page, "what's on fire");
    await send(page, "Launching the shop site on Friday. And I hate chasing invoices.");
    await seeText(page, "Two are unpaid", 25_000);
  });
  await shot("done");
});

export const flows = [
  /** Main: 08:00, Plus — Uno writes first: three things, then "what first". */
  flow("a-morning-summary", async ({ page, url, step, shot }) => {
    await step("open live, Plus, Telegram linked", () => openDemo(page, url, { tier: "plus" }));
    await step("08:00 — the summary arrives", async () => {
      await scene(page, "morning");
      await seeText(page, "things today", 20_000);
      await seeText(page, "What first?", 20_000);
    });
    await shot("summary");
    await step("Send the Acme reminder from the card (Does it itself)", async () => {
      await choose(page, /Send the Acme reminder/);
      await seeText(page, "Sent to billing@acme.example", 20_000);
    });
    await shot("sent");
  }),

  /** Main: "Asks first" — the decision, then the Allow card; Allow sends. */
  flow("a-asks-first-allow", async ({ page, url, step, shot }) => {
    await step("open live, Asks first", () => openDemo(page, url, { mode: "asks-first" }));
    await step("Acme asks for 5% off — needs your decision", async () => {
      await scene(page, "decision");
      await seeText(page, "Needs your decision", 20_000);
    });
    await shot("decision-card");
    await step("Agree → the Allow card in plain words", async () => {
      await choose(page, /Agree to 5%/);
      await page.getByTestId("assistant-allow-card").waitFor({ timeout: 20_000 });
    });
    await shot("allow-card");
    await step("it waits in Needs you too, with the computer named", async () => {
      await openInbox(page);
      await page
        .getByTestId("inbox-item-machine")
        .filter({ hasText: "uno-work" })
        .first()
        .waitFor();
      await shot("inbox");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    });
    await step("Allow once → sent", async () => {
      await page.getByTestId("assistant-allow-once").click();
      await seeText(page, "I'll tell you when the money lands", 20_000);
    });
    await shot("sent");
  }),

  /** Main: "Does it itself" — the same decision goes out without an Allow card. */
  flow("a-itself-no-card", async ({ page, url, step, shot }) => {
    await step("open live, Does it itself", () => openDemo(page, url, { mode: "itself" }));
    await step("decision → sent at once", async () => {
      await scene(page, "decision");
      await choose(page, /Agree to 5%/);
      await seeText(page, "I'll tell you when the money lands", 20_000);
    });
    await step("no Allow card was shown", async () => {
      if (
        await page
          .getByTestId("assistant-allow-card")
          .isVisible()
          .catch(() => false)
      ) {
        throw new Error("an Allow card showed in Does it itself");
      }
    });
    await shot("sent-without-asking");
  }),

  /** Main: a task on the MacBook — Uno hands it out, steps there, result back + Inbox. */
  flow("a-task-on-mac", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url));
    await step("Uno starts it on the MacBook", async () => {
      await scene(page, "elsewhere");
      await seeText(page, "on MacBook. I'll tell you when it's done");
    });
    await shot("started");
    await step("the result comes back to Everything", () =>
      seeText(page, "Done on MacBook", 30_000),
    );
    await shot("done");
    await step("its chat on the MacBook (started by Uno)", async () => {
      await page.getByText("Export the pitch deck to PDF").first().click();
      await seeText(page, "pitch-deck.pdf (2.1 MB)", 15_000);
    });
    await shot("mac-chat");
  }),

  /** Main: channels — make one, it greets; switch back to Everything. */
  flow("a-channels", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url));
    await shot("sidebar-channels");
    await step("New channel → #taxes", async () => {
      await page.getByTestId("sidebar-uno-new-channel").click();
      await page.getByTestId("sidebar-uno-new-channel-input").fill("Taxes 2026");
      await page.keyboard.press("Enter");
      await seeText(page, "This is #taxes-2026", 20_000);
    });
    await shot("new-channel");
    await step("switch to Everything", async () => {
      await page.getByText("Everything", { exact: true }).first().click();
      await page
        .getByText(/Uno · Everything/)
        .first()
        .waitFor({ timeout: 10_000 });
    });
    await shot("everything");
    await step("switch to #landing", async () => {
      await page.getByText("# landing", { exact: true }).first().click();
      await seeText(page, "Checklist: 4 of 6 done");
    });
    await shot("landing");
  }),

  /** Main: your own assistant from the gallery (Grok-style) — it speaks first, in role. */
  flow("a-own-from-gallery", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url));
    await step("Uno's page → Advanced → Pick a character", () => openGallery(page));
    await shot("gallery");
    await step("Mia, the secretary → builder", async () => {
      await page.locator('[data-testid="gallery-character"][data-character="mia"]').click();
      await page.getByTestId("gallery-builder").waitFor();
    });
    await shot("builder-mia");
    await step("Create Mia → she writes first, in role", async () => {
      await page.getByTestId("gallery-create").click();
      await seeText(page, "Mia here", 20_000);
    });
    await shot("mia-first-words");
    await step("Mia is in the sidebar with her role", async () => {
      await page
        .locator('[data-testid="sidebar-assistant"][data-assistant="assistant-mia"]')
        .getByText("Secretary")
        .waitFor();
    });
  }),

  /** Main: build your own — name, role, sliders, tags, a drawn face, mode. */
  flow("a-own-build", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url));
    await step("gallery → Build your own", () => createFromGallery(page, "own", { name: "Rex" }));
    await step("role, character, face", async () => {
      await page.getByTestId("gallery-role-Marketer").click();
      await page.getByRole("button", { name: "Bold", exact: true }).click();
      await page.getByRole("button", { name: "Funny", exact: true }).click();
      await page.getByTestId("gallery-face-tab-persona").click();
      await page.getByTestId("gallery-persona-robot").click();
      await page.getByTestId("gallery-face-image").waitFor({ timeout: 10_000 });
      await page.getByTestId("gallery-mode-itself").click();
    });
    await shot("builder-filled");
    await step("Create Rex → greets in character", async () => {
      await page.getByTestId("gallery-create").click();
      await seeText(page, "Rex here", 20_000);
    });
    await shot("rex-first-words");
  }),

  /** Main: manage Uno — rename, switch mode, take a computer away; remove an own assistant. */
  flow("a-manage", async ({ page, url, step, shot }) => {
    await step("open live → Uno's page", async () => {
      await openDemo(page, url);
      await openUnoPage(page);
    });
    await shot("uno-page");
    await step("rename to Max", async () => {
      await page.getByTestId("assistant-page-rename").click();
      await page.getByTestId("assistant-page-name-input").fill("Max");
      await page.getByTestId("assistant-page-name-save").click();
      await page
        .getByTestId("sidebar-assistant")
        .getByText("Max", { exact: true })
        .waitFor({ timeout: 20_000 });
    });
    await step("mode → Asks first", async () => {
      await page.getByTestId("assistant-page-mode-asks-first").click();
      await page
        .locator('[data-testid="assistant-page-mode-asks-first"][aria-pressed="true"]')
        .waitFor({ timeout: 20_000 });
    });
    await step("take the MacBook away", async () => {
      await page.getByTestId("assistant-page-hand-toggle-mac").click();
      await page.waitForTimeout(600);
    });
    await shot("renamed-mode-hands");
    await step("ask for the deck on the Mac → it says it has no access", async () => {
      await page.getByTestId("assistant-page-open-chat").click();
      await composer(page).waitFor();
      await page
        .getByText(/Max · Everything/)
        .first()
        .waitFor();
      await page.getByTestId("assistant-mode-chip").filter({ hasText: "Asks first" }).waitFor();
      await send(page, "Export the deck on my Mac");
      await seeText(page, "I don't have access to your MacBook", 20_000);
    });
    await shot("no-access");
    await step("an own assistant: create Juno, then remove her", async () => {
      await createFromGallery(page, "juno");
      await page.getByTestId("gallery-create").click();
      await seeText(page, "Juno here", 20_000);
      await page.getByTestId("teammate-headline").click();
      await page.getByTestId("assistant-page-remove").click();
      await shot("remove-confirm");
      await page.getByTestId("assistant-page-remove-confirm").click();
      await page.getByTestId("assistant-page-bring-back").waitFor({ timeout: 20_000 });
      await page.waitForFunction(
        () =>
          !document.querySelector(
            '[data-testid="sidebar-assistant"][data-assistant="assistant-juno"]',
          ),
        null,
        { timeout: 20_000 },
      );
    });
    await shot("removed");
  }),

  /** Main: three computers — the sidebar, the switcher, Needs you labelled by computer. */
  flow("a-three-computers", async ({ page, url, step, shot }) => {
    await step("open live with 3 computers", () => openDemo(page, url, { third: "online" }));
    await shot("sidebar");
    await step("Uno says what it sees", async () => {
      await scene(page, "computers");
      await seeText(page, "Here's what I see", 20_000);
    });
    await shot("uno-sees");
    await step("a task on the third computer", async () => {
      await send(page, "Outline the next newsletter");
      await seeText(page, "Done on free-cloud", 30_000);
    });
    await step("Needs you: the newsletter on free-cloud waits, labelled", async () => {
      await openInbox(page);
      await page
        .getByTestId("inbox-item-machine")
        .filter({ hasText: "free-cloud" })
        .first()
        .waitFor();
    });
    await shot("inbox");
    await step("the computer switcher shows all three", async () => {
      await page.keyboard.press("Escape");
      await page.getByTestId("chat-computer-chip").first().click();
      await page.waitForTimeout(900);
    });
    await shot("switcher");
  }),
];
