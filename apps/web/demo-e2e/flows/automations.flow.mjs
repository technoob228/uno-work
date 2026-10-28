// Automations (28.10): main and edge flows on the real Work web client with
// the demo daemons. `node demo-e2e/run.mjs auto-` runs them.
import { flow, openDemo, openMainChat, scene, seeText, send } from "../harness.mjs";

const BOLT = "assistant-bolt";

/** The tooltip on screen (Base UI's popup has no tooltip role). */
function tooltip(page) {
  return page.locator('[data-slot="tooltip-popup"]');
}

async function openAutomations(page) {
  await page.getByTestId("sidebar-nav-automations").click();
  await page.getByTestId("automations-view").waitFor({ timeout: 15_000 });
}

/** Opens the app's own page by its route (the way its links do). */
async function go(page, to, search) {
  await page.evaluate(
    ([path, params]) => window.__assistDemo.go(path, params ?? undefined),
    [to, search ?? null],
  );
}

function card(page, name) {
  return page.getByTestId("automation-card").filter({ hasText: name }).first();
}

async function openProfile(page, projectId, machine = "work") {
  const env = await page.evaluate((key) => window.__assistDemo.environmentOf(key), machine);
  await go(page, "/assistants", { view: "profile", env, project: projectId });
  await page.getByTestId("assistant-profile").waitFor({ timeout: 15_000 });
}

/** Picks the assistant in the dialog by the start of its line ("Uno · uno-work"). */
async function pickAssistant(page, prefix) {
  const select = page.getByTestId("automation-assistant");
  const value = await select.evaluate(
    (element, start) =>
      [...element.options].find((option) => option.text.startsWith(start))?.value ?? "",
    prefix,
  );
  if (!value) throw new Error(`no assistant ${prefix}`);
  await select.selectOption(value);
}

async function approve(page) {
  await page
    .getByRole("button", { name: /^(Approve|Allow)/ })
    .first()
    .click();
}

export default flow("auto-create-schedule", async ({ page, url, step, shot }) => {
  await step("open live (+ an assistant on the MacBook)", () =>
    openDemo(page, url, { macassistant: "on" }),
  );
  await step("Automations is an icon in the top row, named on hover", async () => {
    const tops = await Promise.all(
      ["sidebar-nav-home", "sidebar-nav-apps", "sidebar-nav-automations"].map(async (id) => {
        const box = await page.getByTestId(id).boundingBox();
        return Math.round(box?.y ?? -1);
      }),
    );
    if (new Set(tops).size !== 1) throw new Error(`not in one row: ${tops}`);
    await page.getByTestId("sidebar-nav-automations").hover();
    await tooltip(page).filter({ hasText: "Automations" }).waitFor({ timeout: 5_000 });
  });
  await shot("icon-hover");
  await step("the screen lists them by assistant, every computer", async () => {
    await openAutomations(page);
    await page
      .locator('[data-testid="automations-group"][data-assistant="assistant-home"]')
      .waitFor();
    await page.locator(`[data-testid="automations-group"][data-assistant="${BOLT}"]`).waitFor();
    await seeText(page, "When a pull request opens or updates in getuno/web");
    await seeText(page, "MacBook: Automations run on a cloud computer");
  });
  await shot("list");
  await step("New automation → Uno, every Friday at 17:00", async () => {
    await page.getByTestId("automations-new").click();
    await page.getByTestId("automation-dialog").waitFor();
    await pickAssistant(page, "Uno · uno-work");
    await page.getByTestId("automation-cadence-weekly").click();
    await page.getByTestId("automation-weekday").selectOption("5");
    await page.getByTestId("automation-time").fill("17:00");
    await page
      .getByTestId("automation-instruction")
      .fill("Send me the week's numbers: sales, signups, churn");
    await seeText(page, "Your time ·");
    await page.getByTestId("automation-mode-line").filter({ hasText: "Does it itself" }).waitFor();
  });
  await shot("dialog-schedule");
  await step("Create → the card says when, in words", async () => {
    await page.getByTestId("automation-save").click();
    await page.getByTestId("automation-dialog").waitFor({ state: "detached", timeout: 10_000 });
    await card(page, "Send me the week's numbers").getByText("Every Friday at 17:00").waitFor();
  });
  await shot("created");
});

export const flows = [
  flow("auto-create-pr", async ({ page, url, step, shot }) => {
    await step("open live, Bolt's page", async () => {
      await openDemo(page, url);
      await openProfile(page, BOLT);
      await page.getByTestId("assistant-automations").waitFor();
      await card(page, "Review PRs in getuno/web").waitFor();
    });
    await shot("bolt-page");
    await step("New automation → When something happens → GitHub → pick a repo", async () => {
      await page.getByTestId("assistant-automations-new").click();
      await page.getByTestId("automation-when-event").click();
      await page.getByTestId("automation-source-github").click();
      await page.getByTestId("automation-repo").click();
      await page.getByTestId("automation-repo").fill("getuno");
      await page.getByTestId("automation-repo-option-getuno/api").click();
      await page.getByTestId("automation-suggestion").filter({ hasText: "Review the PR" }).click();
      await page
        .getByTestId("automation-mode-line")
        .filter({ hasText: "Bolt comments on its own" })
        .waitFor();
      if (await page.getByTestId("automation-repo-unseen").count()) {
        throw new Error("a visible repo was flagged as unseen");
      }
    });
    await shot("dialog-pr");
    await step("Gmail is there, marked Soon; After a call asks for Join my calls", async () => {
      if (!(await page.getByTestId("automation-source-gmail").isDisabled())) {
        throw new Error("Gmail is not disabled");
      }
      await page.getByTestId("automation-source-call").click();
      await page.getByTestId("automation-calls-off").waitFor();
      await shot("calls-hint");
      await page.getByTestId("automation-source-github").click();
      await page.getByTestId("automation-repo").fill("getuno/api");
    });
    await step("Create → the card on Bolt's page", async () => {
      await page.getByTestId("automation-save").click();
      await page.getByTestId("automation-dialog").waitFor({ state: "detached", timeout: 10_000 });
      await card(page, "Review PRs in getuno/api")
        .getByText("When a pull request opens or updates in getuno/api")
        .waitFor();
    });
    await shot("created");
  }),

  flow("auto-chat-phrase", async ({ page, url, step, shot }) => {
    await step("open live, Bolt's chat", async () => {
      await openDemo(page, url);
      await openMainChat(page, "work", BOLT);
    });
    await step(
      "“every time a PR comes to getuno/api, review it” → a card in the chat",
      async () => {
        await send(page, "every time a PR comes to getuno/api, review it and leave a comment");
        await page.getByTestId("automation-created-card").waitFor({ timeout: 20_000 });
        await seeText(
          page,
          "Done — every time a pull request opens or updates in getuno/api",
          20_000,
        );
      },
    );
    await shot("card-in-chat");
    await step("Open → the Automations screen, that one lit", async () => {
      await page.getByTestId("automation-created-open").click();
      await page.getByTestId("automations-view").waitFor();
      await card(page, "Review PRs in getuno/api").waitFor();
      const id = await page.getByTestId("automation-created-card").count();
      if (id !== 0) throw new Error("still in the chat");
    });
    await shot("opened");
    await step("in Russian too", async () => {
      await openMainChat(page, "work", BOLT);
      await send(page, "Каждый раз, когда приходит PR в misha-demo/landing, делай ревью");
      await page
        .getByRole("link", { name: "misha-demo/landing" })
        .first()
        .waitFor({ timeout: 20_000 });
    });
  }),

  flow("auto-toggle-run-delete", async ({ page, url, step, shot }) => {
    await step("open live → Automations", async () => {
      await openDemo(page, url);
      await openAutomations(page);
    });
    const uno = () => card(page, "Sum up my day");
    await step("turn it off", async () => {
      await uno().getByTestId("automation-switch").click();
      await page
        .locator('[data-testid="automation-card"][data-enabled="false"]')
        .filter({ hasText: "Sum up my day" })
        .waitFor({ timeout: 10_000 });
      await uno().getByText("· off").waitFor();
    });
    await shot("off");
    await step("on again → Run now → Done", async () => {
      await uno().getByTestId("automation-switch").click();
      await page
        .locator('[data-testid="automation-card"][data-enabled="true"]')
        .filter({ hasText: "Sum up my day" })
        .waitFor({ timeout: 10_000 });
      await uno().getByTestId("automation-run-now").click();
      await uno()
        .locator('[data-testid="automation-run"][data-state="done"]')
        .filter({ hasText: "Run now" })
        .waitFor({ timeout: 25_000 });
    });
    await shot("ran");
    await step("Edit: weekdays → every day at 19:00", async () => {
      await uno().getByTestId("automation-menu").click();
      await page.getByTestId("automation-edit").click();
      await page.getByTestId("automation-dialog").waitFor();
      await page.getByTestId("automation-cadence-daily").click();
      await page.getByTestId("automation-time").fill("19:00");
      await page.getByTestId("automation-save").click();
      await uno().getByText("Every day at 19:00").waitFor({ timeout: 10_000 });
    });
    await step("⋯ → Delete → it's gone", async () => {
      await uno().getByTestId("automation-menu").click();
      await page.getByTestId("automation-delete").click();
      await page.getByTestId("automation-delete-confirm").waitFor();
      await shot("delete-confirm");
      await page.getByTestId("automation-delete-yes").click();
      await uno().waitFor({ state: "detached", timeout: 10_000 });
    });
    await shot("deleted");
  }),

  flow("auto-asks-first-allow", async ({ page, url, step, shot }) => {
    await step("open live, Asks first", () => openDemo(page, url, { mode: "asks-first" }));
    await step("PR #12 opens → Bolt starts the review on uno-work", async () => {
      await scene(page, "auto-pr-opened");
      await seeText(page, "Started “Review PR #12” on uno-work", 20_000);
    });
    await shot("started");
    await step("the comment waits for Allow (chat + Needs you)", async () => {
      await seeText(page, "Comment on PR #12 in getuno/web", 40_000);
      await page.getByTestId("sidebar-needs-you").first().waitFor({ timeout: 10_000 });
    });
    await shot("allow-card");
    await step("Allow → commented, with the link; the card says Done", async () => {
      await approve(page);
      await seeText(page, "Commented on PR #12", 20_000);
      await openAutomations(page);
      await card(page, "Review PRs in getuno/web")
        .locator('[data-testid="automation-run"][data-state="done"]')
        .filter({ hasText: "PR #12" })
        .waitFor({ timeout: 15_000 });
    });
    await shot("done");
  }),

  flow("auto-itself-no-allow", async ({ page, url, step, shot }) => {
    await step("open live, Does it itself", () => openDemo(page, url, { mode: "itself" }));
    await step("PR #12 opens → reviewed and commented, no Allow", async () => {
      await scene(page, "auto-pr-opened");
      await seeText(page, "Commented on PR #12", 45_000);
      if (await page.getByRole("button", { name: /^Approve/ }).count()) {
        throw new Error("an Allow card showed in Does it itself");
      }
    });
    await shot("commented");
    await step("the review chat is on the computer", async () => {
      await seeText(page, "Done on uno-work: Review ready");
    });
  }),

  flow("auto-pr-twice", async ({ page, url, step, shot }) => {
    await step("open live", () => openDemo(page, url, { mode: "itself" }));
    await step("two pushes to PR #12 → one run", async () => {
      await scene(page, "auto-pr-twice");
      await seeText(page, "Commented on PR #12", 45_000);
    });
    await step("History: the first push skipped, the second done", async () => {
      await openAutomations(page);
      const bolt = card(page, "Review PRs in getuno/web");
      await bolt.getByTestId("automation-history-toggle").click();
      await bolt.getByTestId("automation-history").waitFor();
      const history = bolt.getByTestId("automation-history");
      const superseded = await history.locator('[data-state="superseded"]').count();
      const done12 = await history
        .locator('[data-state="done"]')
        .filter({ hasText: "PR #12" })
        .count();
      if (superseded !== 1 || done12 !== 1) {
        throw new Error(`superseded ${superseded}, done #12 ${done12}`);
      }
      await history.getByText("a newer push came").waitFor();
    });
    await shot("history");
  }),

  flow("auto-edge-asleep", async ({ page, url, step, shot }) => {
    await step("open live (Free): Uno catches up first", async () => {
      await openDemo(page, url, { mode: "itself", tier: "free" });
      await seeText(page, "your Telegram message waited", 25_000);
    });
    await step("a PR comes while the computer sleeps → Waiting", async () => {
      await scene(page, "auto-asleep");
      await openAutomations(page);
      await card(page, "Review PRs in getuno/web")
        .getByText("Waiting — uno-work is asleep, it runs when the computer wakes")
        .waitFor({ timeout: 10_000 });
    });
    await shot("waiting");
    await step("it wakes → the run goes → Done", async () => {
      await card(page, "Review PRs in getuno/web")
        .locator('[data-testid="automation-run"][data-state="done"]')
        .filter({ hasText: "PR #12" })
        .waitFor({ timeout: 60_000 });
    });
    await shot("done");
  }),

  flow("auto-edge-norepo", async ({ page, url, step, shot }) => {
    await step("open live, the GitHub app doesn't see getuno/web", async () => {
      await openDemo(page, url, { gh: "norepo" });
      await openAutomations(page);
    });
    await step("the card says so, with the button to fix it on GitHub", async () => {
      const bolt = card(page, "Review PRs in getuno/web");
      await bolt.getByTestId("automation-problem").waitFor();
      await bolt.getByText("Uno's GitHub app can't see getuno/web").waitFor();
      await bolt.getByRole("button", { name: /Add it on GitHub/ }).waitFor();
    });
    await shot("card-problem");
    await step("a new one for getuno/web: warned in the dialog, refused on Create", async () => {
      await page.getByTestId("automations-new").click();
      await pickAssistant(page, "Bolt");
      await page.getByTestId("automation-when-event").click();
      await page.getByTestId("automation-repo").fill("getuno/web");
      await page.getByTestId("automation-repo-unseen").waitFor();
      await page.getByTestId("automation-suggestion").first().click();
      await page.getByTestId("automation-save").click();
      await page
        .locator('[data-testid="automation-dialog-error"][data-code="GITHUB_REPO_NOT_ALLOWED"]')
        .waitFor({ timeout: 10_000 });
      await page
        .getByTestId("automation-dialog-error-fix")
        .filter({ hasText: "Add it on GitHub" })
        .waitFor();
    });
    await shot("dialog-refused");
    await step("the chat phrase says it plainly too", async () => {
      await page.keyboard.press("Escape");
      await openMainChat(page, "work", BOLT);
      await send(page, "every time a PR comes to getuno/web, review it");
      await seeText(page, "Uno's GitHub app can't see it", 20_000);
    });
    await shot("chat-refused");
  }),

  flow("auto-edge-noperm", async ({ page, url, step, shot }) => {
    await step("open live, the app lacks Pull requests: write", async () => {
      await openDemo(page, url, { gh: "noperm" });
      await openAutomations(page);
    });
    await step("the card asks to accept the permission", async () => {
      const bolt = card(page, "Review PRs in getuno/web");
      await bolt.getByText("GitHub needs one more permission").waitFor();
      await bolt.getByRole("button", { name: /Review on GitHub/ }).waitFor();
    });
    await shot("card-permission");
    await step("a PR comes: the review is done, the comment fails with the reason", async () => {
      await scene(page, "auto-pr-opened");
      await seeText(page, "Pull requests: write", 45_000);
      await openAutomations(page);
      await card(page, "Review PRs in getuno/web")
        .locator('[data-testid="automation-run"][data-state="failed"]')
        .waitFor({ timeout: 15_000 });
    });
    await shot("run-failed");
  }),

  flow("auto-edge-github-off", async ({ page, url, step, shot }) => {
    await step("open live, GitHub not connected", async () => {
      await openDemo(page, url, { gh: "off" });
      await openAutomations(page);
    });
    await step("the dialog offers Connect GitHub instead of a repo field", async () => {
      await page.getByTestId("automations-new").click();
      await page.getByTestId("automation-when-event").click();
      await page.getByTestId("automation-github-off").waitFor();
      await page.getByTestId("automation-github-connect").waitFor();
    });
    await shot("connect-github");
  }),

  flow("auto-edge-mac-assistant", async ({ page, url, step, shot }) => {
    await step("open live, Kit lives on the MacBook", async () => {
      await openDemo(page, url, { macassistant: "on" });
      await openProfile(page, "assistant-kit", "mac");
    });
    await step("Automations run on a cloud computer", async () => {
      await page
        .locator(
          '[data-testid="assistant-automations-unavailable"][data-reason="not_cloud_computer"]',
        )
        .waitFor({ timeout: 15_000 });
      if (await page.getByTestId("assistant-automations-new").count()) {
        throw new Error("New automation offered on a laptop");
      }
    });
    await page.getByTestId("assistant-automations").scrollIntoViewIfNeeded();
    await shot("laptop");
  }),

  flow("auto-phone-empty-create", async ({ page, url, step, shot }) => {
    await step("open live, no automations yet, on a phone", async () => {
      await openDemo(page, url, { automations: "none" });
      await page.setViewportSize({ width: 390, height: 844 });
      await go(page, "/automations");
      await page.getByTestId("automations-empty").waitFor({ timeout: 15_000 });
      await seeText(page, "every time a PR comes to owner/repo, review it");
    });
    await shot("empty");
    await step("New → a schedule for Uno fits the screen", async () => {
      await page.getByTestId("automations-new").click();
      await page.getByTestId("automation-dialog").waitFor();
      await page.getByTestId("automation-cadence-daily").click();
      await page.getByTestId("automation-suggestion").filter({ hasText: "Sum up my day" }).click();
      const box = await page.getByTestId("automation-dialog").boundingBox();
      if (!box || box.width > 390) throw new Error(`dialog ${box?.width}px wide`);
    });
    await shot("dialog");
    await step("Create → the card", async () => {
      await page.getByTestId("automation-save").click();
      await card(page, "Sum up my day").waitFor({ timeout: 10_000 });
    });
    await shot("created");
  }),
];
