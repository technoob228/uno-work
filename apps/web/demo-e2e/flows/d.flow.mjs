// Variant D (28.10): Uno + persona channels — main and edge flows on the real
// Work web client with the demo daemons. `node demo-e2e/run.mjs d-` runs them.
import { flow, openDemo, openMainChat, scene, seeText, send } from "../harness.mjs";

const MIA = "assistant-mia";
const BOLT = "assistant-bolt";

/** Clicks a quiz option / card button by its label. */
async function pick(page, label) {
  const button = page.getByRole("button", { name: label }).last();
  if (await button.isVisible().catch(() => false)) {
    await button.click();
    return;
  }
  await page.getByText(label, { exact: true }).last().click();
}

async function openInbox(page) {
  // An icon in the row on top since 28.10 (its name on hover).
  await page.getByTestId("sidebar-needs-you").first().click();
  await page.waitForTimeout(800);
}

/** The tooltip on screen (Base UI's popup has no tooltip role). */
function tooltip(page) {
  return page.locator('[data-slot="tooltip-popup"]');
}

/** A persona's row in the sidebar. */
function sidebarRow(page, projectId) {
  return page.locator(`[data-testid="sidebar-assistant"][data-assistant="${projectId}"]`);
}

async function openGallery(page) {
  // "+" in the Assistants header (the "New assistant" line is gone, 28.10).
  await page.getByTestId("sidebar-new-assistant").click();
  await page.getByTestId("persona-gallery").waitFor({ timeout: 10_000 });
}

/** Through the setup steps to "Create", then "Open its chat" (no channel). */
export async function createPersona(page) {
  for (let i = 0; i < 3; i += 1) {
    const at = await page.getByTestId("persona-builder").getAttribute("data-step");
    if (at === "job") break;
    await page.getByTestId("persona-next").click();
  }
  await page.getByTestId("persona-create").click();
  await page.getByTestId("persona-channel").waitFor({ timeout: 15_000 });
  await page.getByTestId("persona-open").click();
}

async function approve(page) {
  await page
    .getByRole("button", { name: /^(Approve|Allow)/ })
    .first()
    .click();
}

export default flow("d-first-run", async ({ page, url, step, shot }) => {
  await step("a new account opens on Uno's chat — it talks first", async () => {
    await openDemo(page, url, { world: "new" });
    await seeText(page, "Hi, I'm Uno", 20_000);
    await seeText(page, "what do you mostly do", 20_000);
  });
  await shot("hello");
  await step("about you: one tap", async () => {
    await pick(page, "I run a small business");
    await seeText(page, "a small business");
  });
  await step("the apps card: Connect Gmail inside the chat", async () => {
    await seeText(page, "Connect Gmail & Calendar", 20_000);
    await shot("apps-card");
    const popup = page
      .context()
      .waitForEvent("page")
      .catch(() => null);
    await page.getByRole("button", { name: /Connect Gmail & Calendar/ }).click();
    (await popup)?.close().catch(() => undefined);
    await seeText(page, "Gmail & Calendar is connected", 20_000);
  });
  await step("the Telegram card: one tap", async () => {
    await seeText(page, "Talk to me in Telegram", 20_000);
    await shot("telegram-card");
    await page
      .getByRole("button", { name: /Connect Telegram/ })
      .first()
      .click();
    await seeText(page, "Linked: @uno_team_bot", 20_000);
  });
  await step("the mode: two plain choices", async () => {
    await seeText(page, "should I ask you first", 20_000);
    await shot("mode-card");
    await pick(page, "Ask me first");
    await seeText(page, "Done — I'll ask first", 20_000);
    await page.getByTestId("assistant-mode-chip").filter({ hasText: "Asks first" }).waitFor();
  });
  await step("Free said honestly, helpers offered, then work", async () => {
    await seeText(page, "on Free your cloud computer sleeps", 20_000);
    await seeText(page, "Want to see them?", 20_000);
    await pick(page, "Later");
    await seeText(page, "what's burning today", 20_000);
  });
  await shot("done");
});

export const flows = [
  flow("d-morning-summary", async ({ page, url, step, shot }) => {
    await step("open live (Plus, 3 computers, Mia and Bolt)", () => openDemo(page, url));
    await shot("sidebar-personas");
    await step("08:00 — one summary with a line from each persona", async () => {
      await scene(page, "d-morning");
      await seeText(page, "Your helpers:", 25_000);
      await seeText(page, "Mia · Secretary");
      await seeText(page, "Bolt · Developer");
    });
    await shot("summary");
  }),

  flow("d-asks-first-allow", async ({ page, url, step, shot }) => {
    await step("open live, Asks first", () => openDemo(page, url, { mode: "asks-first" }));
    await step("Mia needs a decision in her channel", async () => {
      await scene(page, "d-mia-decision");
      await seeText(page, "Needs your decision", 25_000);
      await page.getByTestId("teammate-headline").filter({ hasText: "Mia" }).waitFor();
    });
    await shot("decision");
    await step("Agree → the Allow card, from Mia", async () => {
      await pick(page, "Agree to 5%");
      await seeText(page, "billing@brightline.example", 20_000);
    });
    await shot("allow-card");
    await step("Allow → sent", async () => {
      await approve(page);
      await seeText(page, "Sent. I'll tell you when the money lands", 20_000);
    });
    await shot("sent");
    await step("Uno's Everything saw it too", async () => {
      await openMainChat(page);
      await seeText(page, "Mia needs your decision", 20_000);
    });
    await shot("in-everything");
  }),

  flow("d-asks-first-decline", async ({ page, url, step, shot }) => {
    await step("open live, Asks first", () => openDemo(page, url, { mode: "asks-first" }));
    await step("a Telegram message asks Uno to send the reminder", async () => {
      await scene(page, "telegram-message");
      await seeText(page, "Send an email to billing@acme.example", 25_000);
    });
    await shot("allow-card");
    await step("Decline → not sent, the draft stays", async () => {
      await page
        .getByRole("button", { name: /^Decline/ })
        .first()
        .click();
      await seeText(page, "not sending", 20_000);
    });
    await shot("declined");
  }),

  flow("d-itself-no-card", async ({ page, url, step, shot }) => {
    await step("open live, Does it itself", () => openDemo(page, url, { mode: "itself" }));
    await step("Mia's channel from the sidebar", async () => {
      await sidebarRow(page, MIA).getByTestId("sidebar-assistant-open").click();
      await page.getByTestId("teammate-headline").filter({ hasText: "Mia" }).waitFor();
    });
    await step("the decision, then it sends without a card", async () => {
      await send(page, "anything from Brightline?");
      await seeText(page, "Needs your decision", 25_000);
      await pick(page, "Agree to 5%");
      await seeText(page, "Sent. I'll tell you when the money lands", 20_000);
      if (await page.getByRole("button", { name: /^Approve/ }).count()) {
        throw new Error("an Allow card showed in Does it itself");
      }
    });
    await shot("sent-without-asking");
  }),

  flow("d-task-on-mac", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url));
    await step("Bolt starts the tests on the MacBook", async () => {
      await scene(page, "d-bolt-mac");
      await seeText(page, "on MacBook. I'll tell you when it's done", 20_000);
    });
    await shot("started");
    await step("the result comes back to Bolt", () => seeText(page, "Done on MacBook", 30_000));
    await shot("done");
    await step("Needs you says which computer and who", async () => {
      // Needs you shows when something waits: Mia's decision does.
      await scene(page, "d-mia-decision");
      await seeText(page, "Needs your decision", 25_000);
      await openInbox(page);
      await page
        .getByRole("tab", { name: /^All/ })
        .click()
        .catch(() => undefined);
      await seeText(page, "Bolt · Finished on MacBook");
      await page.getByTestId("inbox-item-who").filter({ hasText: "on MacBook" }).first().waitFor();
    });
    await shot("inbox-labels");
  }),

  flow("d-gallery-create", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url));
    await step("+ → the gallery", () => openGallery(page));
    await shot("gallery");
    await step("pick Accounts manager (Leo)", async () => {
      await page.getByTestId("persona-card-accounts-manager").click();
      await page.getByTestId("persona-builder").waitFor();
      await seeText(page, "Make Leo yours");
    });
    await shot("make-it-yours");
    await step("Create → Leo writes first, in his voice", async () => {
      await createPersona(page);
      await seeText(page, "Leo here ✨", 25_000);
      await sidebarRow(page, "assistant-leo").waitFor();
      await sidebarRow(page, "assistant-leo").getByText("Accounts manager").waitFor();
    });
    await shot("leo-writes-first");
  }),

  flow("d-build-own", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url));
    await step("gallery → Helper", async () => {
      await openGallery(page);
      await page.getByTestId("persona-card-helper").click();
      await seeText(page, "Make Mia yours");
    });
    await step("name, character, face, mode — no prompt", async () => {
      await page.getByTestId("persona-name").fill("Ms. Pepper");
      await page.getByRole("button", { name: "Warm", exact: true }).click();
      await page.getByRole("button", { name: "Formal", exact: true }).click();
      await page.getByRole("slider", { name: "Brief or Chatty" }).fill("15");
      await page.getByRole("button", { name: "Face 🦁" }).click();
      await page.getByTestId("persona-next").click();
      await page.getByTestId("persona-mode-itself").click();
    });
    await shot("built");
    await step("Create → she greets in character", async () => {
      await createPersona(page);
      await seeText(page, "Good day. I'm Ms. Pepper, your helper", 25_000);
      await sidebarRow(page, "assistant-ms-pepper").getByText("Helper").waitFor();
    });
    await shot("greets");
  }),

  flow("d-task-to-persona", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url));
    await step("Bolt's channel", async () => {
      await sidebarRow(page, BOLT).getByTestId("sidebar-assistant-open").click();
      await page.getByTestId("teammate-headline").filter({ hasText: "Bolt" }).waitFor();
    });
    await step("“check CI” → Bolt runs the tests on the MacBook", async () => {
      await send(page, "check CI on the landing");
      await seeText(page, "on MacBook. I'll tell you when it's done", 20_000);
      await seeText(page, "Done on MacBook", 30_000);
    });
    await shot("done");
  }),

  flow("d-manage", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url));
    await step("Mia's page from her face", async () => {
      await sidebarRow(page, MIA).getByTestId("sidebar-assistant-face").click();
      await page.getByTestId("assistant-profile").waitFor();
      await seeText(page, "works next to Uno");
    });
    await shot("page");
    await step("rename: Mia → Mila", async () => {
      await page.getByTestId("assistant-profile-who-edit").click();
      const field = page.getByTestId("assistant-profile-who-editor").locator("input").first();
      await field.fill("Mila");
      await page
        .getByTestId("assistant-profile-who-editor")
        .getByRole("button", { name: /Save/ })
        .click();
      await sidebarRow(page, MIA).getByText("Mila", { exact: true }).waitFor({ timeout: 20_000 });
    });
    await step("mode: Does it itself", async () => {
      await page.getByTestId("assistant-mode-switch-itself").click();
      await page
        .locator('[data-testid="assistant-mode-switch-itself"][aria-pressed="true"]')
        .waitFor({ timeout: 20_000 });
    });
    await shot("renamed-mode");
    await step("remove → gone from the sidebar", async () => {
      await page.getByTestId("assistant-profile-remove").click();
      await seeText(page, "Remove Mila?");
      await shot("remove-confirm");
      await page.getByTestId("assistant-profile-remove-confirm").click();
      await sidebarRow(page, MIA).waitFor({ state: "detached", timeout: 20_000 });
    });
    await shot("removed");
  }),

  // ── Edge ──────────────────────────────────────────────────────────────

  flow("d-edge-free-sleeps", async ({ page, url, step, shot }) => {
    await step("open live on Free", () => openDemo(page, url, { tier: "free" }));
    await step("Uno's chat: honest plaque, what waited, the summary", async () => {
      await page.getByTestId("cloud-sleeps-banner").waitFor({ timeout: 20_000 });
      await seeText(page, "your Telegram message waited", 25_000);
      await seeText(page, "Your helpers:", 25_000);
    });
    await shot("caught-up");
    await step("the way to Plus is right there", async () => {
      await page.getByTestId("cloud-sleeps-plus").waitFor();
      await seeText(page, "sleeps when you're away");
    });
  }),

  flow("d-edge-mac-asleep", async ({ page, url, step, shot }) => {
    await step("open live, MacBook asleep", () => openDemo(page, url, { mac: "asleep" }));
    await step("Bolt asks where to run instead of failing", async () => {
      await scene(page, "d-bolt-mac");
      await seeText(page, "Your MacBook is asleep", 20_000);
    });
    await shot("asks-where");
    await step("run on the cloud", async () => {
      await pick(page, "Run on the cloud");
      await seeText(page, "Done on uno-work", 30_000);
    });
    await shot("done-on-cloud");
  }),

  flow("d-edge-gmail-expired", async ({ page, url, step, shot }) => {
    await step("open live, Gmail's sign-in expired", () =>
      openDemo(page, url, { gmail: "expired" }),
    );
    await step("Settings → Connectors shows it in the real list", async () => {
      await page.evaluate(() => {
        location.hash = "#/settings/connectors";
      });
      await seeText(page, "It stopped working. Sign in again", 20_000);
    });
    await shot("connectors-expired");
    await step("Reconnect → connected again", async () => {
      const popup = page
        .context()
        .waitForEvent("page")
        .catch(() => null);
      await page.getByTestId("setup-connect-gmail").click();
      (await popup)?.close().catch(() => undefined);
      await page
        .getByTestId("setup-connector-gmail")
        .getByText("Connected", { exact: false })
        .waitFor({ timeout: 25_000 });
    });
    await shot("reconnected");
  }),

  flow("d-edge-gmail-expired-chat", async ({ page, url, step, shot }) => {
    await step("open live, Gmail expired", () => openDemo(page, url, { gmail: "expired" }));
    await step("Mia says so and offers to sign in again", async () => {
      await scene(page, "d-mia-decision");
      await seeText(page, "Gmail ended its sign-in", 20_000);
      await seeText(page, "Sign in to Gmail & Calendar again");
    });
    await shot("reconnect-card");
  }),

  flow("d-edge-ask-while-closed", async ({ page, url, step, shot }) => {
    await step("open live, Asks first", () => openDemo(page, url, { mode: "asks-first" }));
    await step("the 16:00 reminder fires with no chat open", async () => {
      await scene(page, "reminder-closed");
      await page.evaluate(() => {
        location.hash = "#/";
      });
      await page.waitForTimeout(4_000);
    });
    await step("it waits in Needs you (and Telegram), not refused", async () => {
      await openInbox(page);
      await seeText(page, "Also sent to your Telegram", 20_000);
    });
    await shot("waits-in-inbox");
    await step("Allow from Needs you → it goes out", async () => {
      await page.getByRole("button", { name: "Allow", exact: true }).first().click();
      await openMainChat(page);
      await seeText(page, "Sent to billing@acme.example", 20_000);
    });
    await shot("sent-after-inbox-allow");
  }),

  flow("d-edge-other-machine-failed", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url));
    await step("Bolt's tests fail on the MacBook", async () => {
      await scene(page, "d-bolt-fails");
      await seeText(page, "It failed on MacBook", 30_000);
    });
    await shot("failed");
    await step("Needs you: Failed on MacBook, with who", async () => {
      // Bolt's question about the fix makes Needs you show.
      await openInbox(page);
      await page
        .getByRole("tab", { name: /^All/ })
        .click()
        .catch(() => undefined);
      await seeText(page, "Bolt · Failed on MacBook");
    });
    await shot("inbox-failed");
    await step("fix it there → green", async () => {
      // Needs you opens under its icon now, over the sidebar: close it first.
      await page.keyboard.press("Escape");
      await sidebarRow(page, BOLT).getByTestId("sidebar-assistant-open").click();
      await pick(page, "Fix them on the MacBook");
      await seeText(page, "Done on MacBook: Fixed", 30_000);
    });
    await shot("fixed");
  }),

  flow("d-edge-telegram-off", async ({ page, url, step, shot }) => {
    await step("open live, Asks first, no Telegram", () =>
      openDemo(page, url, { mode: "asks-first", tg: "off" }),
    );
    await step("Mia's Allow waits here (no Telegram to send it to)", async () => {
      await scene(page, "d-mia-decision");
      await pick(page, "Agree to 5%");
      await seeText(page, "billing@brightline.example", 20_000);
      await openInbox(page);
      await seeText(page, "It waits for you here", 20_000);
    });
    await shot("waits-here");
    await step("Uno offers Telegram in one tap", async () => {
      await openMainChat(page);
      await send(page, "connect telegram");
      await seeText(page, "Talk to me in Telegram", 20_000);
    });
    await shot("telegram-card");
  }),

  flow("d-edge-many-personas", async ({ page, url, step, shot }) => {
    await step("open live with 12 personas", () => openDemo(page, url, { personas: "12" }));
    await step("the sidebar folds them", async () => {
      await page.getByTestId("sidebar-assistants-more").waitFor({ timeout: 15_000 });
    });
    await shot("folded");
    await step("Show more → all of them", async () => {
      await page.getByTestId("sidebar-assistants-more").click();
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="sidebar-assistant"]').length >= 13,
        null,
        { timeout: 15_000 },
      );
    });
    await shot("all");
    await step("the summary stays short", async () => {
      await scene(page, "d-morning");
      await seeText(page, "more: nothing that needs you", 25_000);
    });
    await shot("summary");
  }),

  flow("d-edge-remove-mid-task", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url, { mode: "itself" }));
    await step("Mia starts a long task", async () => {
      await scene(page, "d-mia-long");
      await seeText(page, "Reading 14 client threads", 20_000);
    });
    await step("remove Mia from her page while she works", async () => {
      await sidebarRow(page, MIA).getByTestId("sidebar-assistant-face").click();
      await page.getByTestId("assistant-profile-remove").click();
      await seeText(page, "is working on");
      await shot("confirm-while-working");
      await page.getByTestId("assistant-profile-remove-confirm").click();
      await sidebarRow(page, MIA).waitFor({ state: "detached", timeout: 20_000 });
    });
    await step("the task stopped, nothing was sent", async () => {
      await openMainChat(page, "work", MIA);
      await seeText(page, "Stopped: Mia was removed", 20_000);
      await page.waitForTimeout(6_000);
      if (await page.getByText("Sent all 3").count()) throw new Error("it sent after removal");
    });
    await shot("stopped");
  }),

  flow("d-edge-mode-mid-task", async ({ page, url, step, shot }) => {
    await step("open live, Does it itself", () => openDemo(page, url, { mode: "itself" }));
    await step("Mia starts a long task", async () => {
      await scene(page, "d-mia-long");
      await seeText(page, "Reading 14 client threads", 20_000);
    });
    await step("switch Mia to Asks first in the middle", async () => {
      await page.getByTestId("assistant-mode-chip").click();
      await page.getByTestId("assistant-mode-asks-first").click();
      await page.getByTestId("assistant-mode-chip").filter({ hasText: "Asks first" }).waitFor();
    });
    await shot("switched");
    await step("the send now waits for Allow", async () => {
      await seeText(page, "Send 3 replies", 30_000);
      await page
        .getByRole("button", { name: /^Approve/ })
        .first()
        .waitFor();
    });
    await shot("asks-now");
  }),

  flow("d-edge-long-name", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url));
    await step("a very long name stops at 40", async () => {
      await openGallery(page);
      await page.getByTestId("persona-card-developer").click();
      await page
        .getByTestId("persona-name")
        .fill("Maximiliana-Alexandra the Extremely Thorough Research Assistant of Everything");
      const value = await page.getByTestId("persona-name").inputValue();
      if (value.length > 40) throw new Error(`name is ${value.length} long`);
    });
    await shot("field");
    await step("create → the sidebar and header cut it neatly", async () => {
      await createPersona(page);
      await seeText(page, ". Developer.", 25_000);
    });
    await shot("sidebar-header");
  }),

  flow("d-edge-facegen-fail", async ({ page, url, step, shot }) => {
    await step("open live (drawing fails)", () => openDemo(page, url, { facegen: "fail" }));
    await step("Helper (Mia) → Portrait → Human fails, the emoji stays", async () => {
      await openGallery(page);
      await page.getByTestId("persona-card-helper").click();
      await page.getByTestId("persona-face-tab-portrait").click();
      await page.getByTestId("persona-draw-human").click();
      await page.getByTestId("persona-face-problem").waitFor({ timeout: 15_000 });
      await seeText(page, "Couldn't draw a portrait");
    });
    await shot("failed");
    await step("still creates with the emoji", async () => {
      await page.getByTestId("persona-name").fill("Mia Two");
      await createPersona(page);
      await seeText(page, "Mia Two", 25_000);
    });
  }),

  flow("d-edge-facegen-ok", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url));
    await step("Helper → Portrait → Alien draws one", async () => {
      await openGallery(page);
      await page.getByTestId("persona-card-helper").click();
      await page.getByTestId("persona-face-tab-portrait").click();
      await page.getByTestId("persona-draw-alien").click();
      await page
        .getByTestId("persona-face")
        .getByTestId("assistant-avatar-image")
        .waitFor({ timeout: 15_000 });
    });
    await shot("drawn");
  }),

  flow("d-edge-mac-project-note", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url));
    await step("Bolt limited to a MacBook project: a note, not a lock", async () => {
      await openGallery(page);
      await page.getByTestId("persona-card-developer").click();
      await page.getByTestId("persona-name").fill("Bolt Mac");
      await page.getByTestId("persona-next").click();
      await page.getByTestId("persona-where-some").click();
      await page.getByTestId("persona-project-p-mac-deck").click();
      await page.getByTestId("persona-lock-note").waitFor();
      await seeText(page, "this is a note, not a lock");
    });
    await shot("honest-note");
    await step("a cloud project is a real lock", async () => {
      await page.getByTestId("persona-project-p-mac-deck").click();
      await page.getByTestId("persona-project-p-work-landing").click();
      await seeText(page, "Locked by a sandbox");
    });
    await shot("real-lock");
  }),

  flow("d-three-computers", async ({ page, url, step, shot }) => {
    await step("open live (uno-work, MacBook, Free cloud asleep)", () => openDemo(page, url));
    await step("the computer switcher shows all three", async () => {
      const switcher = page.getByRole("button", { name: "Switch computer" }).first();
      if (await switcher.isVisible().catch(() => false)) await switcher.click();
      else await page.getByTestId("home-computer-pill").first().click();
      await page.getByTestId("computer-switcher-list").waitFor({ timeout: 10_000 });
      await seeText(page, "MacBook");
      await page.waitForTimeout(900);
    });
    await shot("switcher");
    await step("Needs you with the computer and the persona on each", async () => {
      await page.keyboard.press("Escape");
      await scene(page, "d-bolt-mac");
      await seeText(page, "Done on MacBook", 30_000);
      await scene(page, "d-mia-decision");
      await seeText(page, "Needs your decision", 25_000);
      await openInbox(page);
      await page
        .getByRole("tab", { name: /^All/ })
        .click()
        .catch(() => undefined);
      await page.getByTestId("inbox-item-who").first().waitFor();
    });
    await shot("inbox");
  }),

  // ── Sidebar (Misha 28.10) ─────────────────────────────────────────────

  flow("d-sidebar-places-and-header", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url));
    await step("Home, Files, Apps & sites are icons in one row, named on hover", async () => {
      const tops = await Promise.all(
        ["sidebar-nav-home", "sidebar-nav-files", "sidebar-nav-apps"].map(async (id) => {
          const box = await page.getByTestId(id).boundingBox();
          return Math.round(box?.y ?? -1);
        }),
      );
      if (new Set(tops).size !== 1) throw new Error(`places not in one row: ${tops}`);
      await page.getByTestId("sidebar-nav-files").hover();
      await tooltip(page).filter({ hasText: "Files" }).waitFor({ timeout: 5_000 });
    });
    await shot("places-hover");
    await step("no “New assistant” line, only “+” and the gear", async () => {
      if (await page.getByTestId("sidebar-new-assistant-row").count()) {
        throw new Error("the New assistant line is still there");
      }
      await page.getByTestId("sidebar-assistants-settings").hover();
      await tooltip(page).filter({ hasText: "Assistant settings" }).waitFor();
    });
    await shot("header-gear");
    await step("the gear opens the assistants' settings", async () => {
      await page.getByTestId("sidebar-assistants-settings").click();
      await page.waitForFunction(() => location.hash.includes("/settings/assistants-phone"));
      await seeText(page, "Assistants & phone");
    });
    await shot("settings");
    await step("hide the assistants → one small line", async () => {
      await page.evaluate(() => {
        location.hash = "#/";
      });
      await page.getByTestId("sidebar-assistants-header").hover();
      await page.getByTestId("sidebar-hide-assistants").click();
      await page.getByTestId("sidebar-show-assistants").waitFor();
      if (await page.getByTestId("sidebar-assistant").count()) {
        throw new Error("assistants still listed while hidden");
      }
    });
    await shot("hidden");
    await step("it stays hidden after a reload, and comes back", async () => {
      await page.reload();
      await page.getByTestId("sidebar-show-assistants").waitFor({ timeout: 30_000 });
      await page.getByTestId("sidebar-show-assistants").click();
      await sidebarRow(page, MIA).waitFor();
    });
    await shot("shown-again");
  }),

  flow("d-sidebar-started-by", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url));
    const startedBy = (name) =>
      page
        .getByTestId("sidebar-d-chats")
        .locator(`[data-testid="sidebar-row-started-by"][data-started-by="${name}"]`);
    await step("a chat Uno started is in the common list, marked", async () => {
      await startedBy("Uno").first().waitFor({ timeout: 15_000 });
      await startedBy("Uno").first().hover();
      await tooltip(page).filter({ hasText: "Started by Uno" }).waitFor();
    });
    await shot("started-by-uno");
    await step("Bolt starts tests on the MacBook → that chat shows here too", async () => {
      await scene(page, "d-bolt-mac");
      await seeText(page, "on MacBook. I'll tell you when it's done", 20_000);
      await startedBy("Bolt").first().waitFor({ timeout: 20_000 });
      await seeText(page, "Done on MacBook", 30_000);
      // Bolt lives on uno-work; the chat is on the MacBook — it says where from.
      const label = await startedBy("Bolt").first().getAttribute("aria-label");
      if (label !== "Started by Bolt · from uno-work") throw new Error(`label: ${label}`);
      await startedBy("Bolt").first().hover();
      await tooltip(page).filter({ hasText: "Started by Bolt" }).first().waitFor();
    });
    await shot("started-by-bolt-on-mac");
    await page.mouse.move(900, 650);
    await page.waitForTimeout(500);
    await shot("list-with-computer");
    await step("one switch in the chats' menu hides them", async () => {
      await page.getByTestId("sidebar-d-view-trigger").click();
      await page.getByTestId("sidebar-d-assistant-chats").click();
      await page.keyboard.press("Escape");
      await page.getByTestId("sidebar-d-view-trigger").filter({ hasText: "Your chats" }).waitFor();
      await page.waitForTimeout(400);
      const left = (await startedBy("Uno").count()) + (await startedBy("Bolt").count());
      // The open chat stays (Bolt's channel is not a started chat).
      if (left > 0) throw new Error(`${left} assistants' chats still listed`);
    });
    await shot("hidden-filter");
    await step("× shows them again", async () => {
      await page.getByTestId("sidebar-d-clear-filter").click();
      await startedBy("Uno").first().waitFor();
    });
  }),

  flow("d-sidebar-fold-group", async ({ page, url, step, shot }) => {
    await step("open live, Uno's main chat", async () => {
      await openDemo(page, url);
      await openMainChat(page);
    });
    const unoChats = page.locator(
      '[data-testid="sidebar-assistant-chats"][data-assistant="assistant-home"]',
    );
    await step("Uno's chats are unfolded around the open one", () =>
      unoChats.waitFor({ timeout: 15_000 }),
    );
    await shot("unfolded");
    await step("the chevron folds the group, even with its chat open", async () => {
      await sidebarRow(page, "assistant-home").getByTestId("sidebar-assistant-toggle").click();
      await unoChats.waitFor({ state: "detached", timeout: 5_000 });
    });
    await shot("folded");
    await step("and unfolds it again", async () => {
      await sidebarRow(page, "assistant-home").hover();
      await sidebarRow(page, "assistant-home").getByTestId("sidebar-assistant-toggle").click();
      await unoChats.waitFor({ timeout: 5_000 });
    });
  }),
];
