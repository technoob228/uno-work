// Assistants D (28.10), sub-stream C: Uno's first-run screen and making an
// assistant with a job — on the real Work web client with the demo daemons.
// `node demo-e2e/run.mjs dc-` runs them.
import { flow, openDemo, seeText } from "../harness.mjs";

const PASSWORD = "Sup3r-Secret-Pa55!";

/** Opens a page of the app inside the demo, the way its own links do. */
async function go(page, path) {
  const [to, query] = path.split("?");
  const search = Object.fromEntries(new URLSearchParams(query ?? ""));
  await page.evaluate(([where, params]) => window.__assistDemo.go(where, params), [to, search]);
}

async function envOf(page, machine = "work") {
  return page.evaluate((key) => window.__assistDemo.environmentOf(key), machine);
}

async function openGallery(page) {
  await go(page, "/assistants?view=new");
  await page.getByTestId("persona-gallery").waitFor({ timeout: 10_000 });
}

/** Opens the connector's consent "window" and closes it (the demo grants at once). */
async function connect(page, provider) {
  const popup = page
    .context()
    .waitForEvent("page", { timeout: 5_000 })
    .catch(() => null);
  await page.getByTestId(`setup-connect-${provider}`).first().click();
  (await popup)?.close().catch(() => undefined);
}

/** No trace of the password anywhere the page keeps or shows things. */
async function passwordNowhere(page) {
  const leaks = await page.evaluate((secret) => {
    const found = [];
    if (document.documentElement.innerHTML.includes(secret)) found.push("page");
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key && (store.getItem(key) ?? "").includes(secret)) found.push(`storage:${key}`);
      }
    }
    return found;
  }, PASSWORD);
  if (leaks.length > 0) throw new Error(`the password is in: ${leaks.join(", ")}`);
}

/** Who → setup (defaults) → the job step. */
async function toJob(page) {
  await page.getByTestId("persona-next").click();
  await page.getByTestId("persona-works-on").waitFor();
  await page.getByTestId("persona-next").click();
  await page.getByTestId("persona-job").waitFor();
}

async function createAndOpen(page) {
  await page.getByTestId("persona-create").click();
  await page.getByTestId("persona-channel").waitFor({ timeout: 15_000 });
}

export default flow("dc-uno-setup", async ({ page, url, step, shot }) => {
  await step("a new account: Uno's first click opens its setup screen", async () => {
    // Opened on a page (not fresh): the demo doesn't jump into Uno's chat by itself.
    await openDemo(page, url, { world: "new" }, { hash: "/assistants" });
    await go(page, `/assistants?view=uno-setup&env=${await envOf(page)}`);
    await page.getByTestId("uno-setup").waitFor({ timeout: 10_000 });
    await page.getByTestId("assistant-power-uno").waitFor();
  });
  await shot("screen");
  await step("one AI picker: Uno AI selected, the same line as everywhere", async () => {
    await seeText(page, "One choice for every assistant on");
  });
  await step("mode: Asks first", async () => {
    await page.getByTestId("uno-setup-mode-asks").click();
  });
  await step("apps: Connect Gmail on its computer", async () => {
    await connect(page, "gmail");
    await page
      .getByTestId("setup-connector-gmail")
      .getByText("Connected", { exact: false })
      .waitFor({ timeout: 15_000 });
  });
  await shot("filled");
  await step("Start → its one chat, mode Asks first", async () => {
    await page.getByTestId("uno-setup-start").click();
    await seeText(page, "what's burning today", 25_000);
    await page.getByTestId("assistant-mode-chip").filter({ hasText: "Asks first" }).waitFor();
  });
  await shot("chat");
});

export const flows = [
  flow("dc-development", async ({ page, url, step, shot }) => {
    await step("open live → gallery → Bolt", async () => {
      await openDemo(page, url);
      await openGallery(page);
      await page.getByTestId("persona-card-bolt").click();
      await page.getByTestId("persona-name").fill("Dev Lead");
    });
    await step("where it works + AI + projects + mode", async () => {
      await page.getByTestId("persona-next").click();
      await page.getByTestId("persona-works-on").waitFor();
      await page.getByTestId("assistant-ai-choice").waitFor();
      await seeText(page, "What Dev Lead thinks with");
    });
    await shot("setup");
    await step(
      "What should it do? → Development: a project + a repo + the first task",
      async () => {
        await page.getByTestId("persona-next").click();
        await page.getByTestId("persona-job-development").click();
        await page.getByTestId("persona-dev-project-p-work-landing").click();
        await page.getByTestId("persona-dev-repos").fill("misha-demo/checkout");
        await page.getByTestId("persona-job-task").fill("Get the checkout tests green");
      },
    );
    await shot("job");
    await step("Create → channel step shows the first message", async () => {
      await createAndOpen(page);
      await seeText(page, "Your job: lead development of landing and misha-demo/checkout");
      await seeText(page, "Don't do the work yourself: start a chat on");
    });
    await shot("channel");
    await step("Open its chat → it starts a chat on its computer and reports", async () => {
      await page.getByTestId("persona-open").click();
      await seeText(page, "Starting a chat on", 25_000);
      await seeText(page, "main is green, 2 PRs wait for your review", 30_000);
    });
    await shot("reported");
  }),

  flow("dc-accounts", async ({ page, url, step, shot }) => {
    await step("open live → gallery → Leo · Marketer", async () => {
      await openDemo(page, url, { mode: "asks-first" });
      await openGallery(page);
      await page.getByTestId("persona-card-leo").click();
      await toJob(page);
    });
    await step("Accounts → the form in a window", async () => {
      await page.getByTestId("persona-job-accounts").click();
      await page.getByTestId("persona-accounts-add").click();
      await page.getByTestId("persona-accounts-dialog").waitFor();
    });
    await step("edge: empty password is not saved", async () => {
      await page.getByTestId("persona-account-service").fill("Instagram");
      await page
        .getByTestId("persona-account-site")
        .fill("https://www.instagram.com/accounts/login");
      await page.getByTestId("persona-account-username").fill("leo@shop.example");
      await page.getByTestId("persona-accounts-save").click();
      await seeText(page, "Type the password.");
    });
    await shot("empty-password");
    await step("password → saved on its computer, not in a chat", async () => {
      await page.getByTestId("persona-account-password").fill(PASSWORD);
      await page.getByTestId("persona-accounts-save").click();
      await page.getByTestId("persona-accounts-dialog").waitFor({ state: "detached" });
      await page.getByTestId("persona-account-saved").getByText("instagram.com").waitFor();
      const vault = await page.evaluate(() => window.__assistDemo.vault("work"));
      const entry = vault.find((item) => item.url === "https://instagram.com");
      if (!entry || !entry.passwordSaved || entry.username !== "leo@shop.example")
        throw new Error(`vault: ${JSON.stringify(vault)}`);
      await passwordNowhere(page);
    });
    await step("the task, every Monday at 09:00", async () => {
      await page.getByTestId("persona-job-task").fill("Post the weekly update");
      await page.getByTestId("persona-repeat-weekly").click();
      await page.getByTestId("persona-repeat-weekday").selectOption("1");
      await page.getByTestId("persona-repeat-time").fill("09:00");
    });
    await shot("job");
    await step("Create → first message says how to sign in, no password", async () => {
      await createAndOpen(page);
      await seeText(page, 'browser_command {"login": "instagram.com"}');
      await seeText(page, 'cron "0 9 * * 1"');
      await passwordNowhere(page);
    });
    await shot("channel");
    await step("its chat: a chat signs in, then the schedule waits for Allow", async () => {
      await page.getByTestId("persona-open").click();
      await seeText(page, "Signed in to instagram.com", 30_000);
      await seeText(page, "schedule_create", 30_000);
      await page
        .getByRole("button", { name: /^(Approve|Allow)/ })
        .first()
        .click();
      await seeText(page, "Scheduled: every Monday at 09:00", 20_000);
      await passwordNowhere(page);
    });
    await shot("scheduled");
  }),

  flow("dc-tasks", async ({ page, url, step, shot }) => {
    await step("open live → gallery → Mia", async () => {
      await openDemo(page, url, { notion: "off" });
      await openGallery(page);
      await page.getByTestId("persona-card-mia").click();
      await page.getByTestId("persona-name").fill("Mia Tasks");
      await toJob(page);
    });
    await step("Tasks → connect Notion on its computer + own MCP server", async () => {
      await page.getByTestId("persona-job-tasks").click();
      await connect(page, "notion");
      await page
        .getByTestId("setup-connector-notion")
        .getByText("Connected", { exact: false })
        .waitFor({ timeout: 15_000 });
      await page.getByTestId("setup-mcp-url").fill("https://mcp.crm.example/mcp");
      await page.getByTestId("setup-mcp-add").click();
      const anyway = page.getByRole("button", { name: "Add anyway" });
      if (await anyway.isVisible({ timeout: 3_000 }).catch(() => false)) await anyway.click();
      await page.getByTestId("setup-mcp-server").first().waitFor({ timeout: 10_000 });
    });
    await shot("tools");
    await step("Create → the message names the apps and the own tool", async () => {
      await page.getByTestId("persona-job-task").fill("Sum up new mail every morning");
      await createAndOpen(page);
      await seeText(page, "Notion");
      await seeText(page, "(my own tool)");
    });
    await step("Open → it answers with its tools", async () => {
      await page.getByTestId("persona-open").click();
      await seeText(page, "Got it — I'll use", 25_000);
    });
    await shot("chat");
  }),

  flow("dc-edge-long-name-channel", async ({ page, url, step, shot }) => {
    await step("open live → Build your own, a very long name", async () => {
      await openDemo(page, url);
      await openGallery(page);
      await page.getByTestId("persona-card-own").click();
      await page
        .getByTestId("persona-name")
        .fill("Maximiliana-Alexandra the Extremely Thorough Research Assistant of Everything");
      const value = await page.getByTestId("persona-name").inputValue();
      if (value.length > 40) throw new Error(`name is ${value.length} long`);
    });
    await step("no job → Create; the channel step offers its own bot", async () => {
      await toJob(page);
      await createAndOpen(page);
      await page.getByTestId("persona-channel-telegram").click();
      await seeText(page, "BotFather", 15_000);
    });
    await shot("own-bot");
  }),

  flow("dc-edge-mac-asleep", async ({ page, url, step, shot }) => {
    await step("open live, MacBook asleep", async () => {
      await openDemo(page, url, { mac: "asleep" });
      await openGallery(page);
      await page.getByTestId("persona-card-own").click();
      await page.getByTestId("persona-name").fill("Night Owl");
      await page.getByTestId("persona-next").click();
      await page.getByTestId("persona-works-on").waitFor();
    });
    await step("a computer of its own: Create waits for it, honestly", async () => {
      await page.getByTestId("persona-works-on-own").click();
      await seeText(page, "Make its computer in My Uno first");
      if (await page.getByTestId("persona-next").isEnabled())
        throw new Error("Next is enabled without a computer");
    });
    await shot("own-computer");
    await step("a computer that can't take it now is greyed out, with why", async () => {
      const blocked = page.locator('[data-testid^="persona-works-on-"][disabled]');
      if ((await blocked.count()) === 0) throw new Error("no greyed-out computer");
      await seeText(page, "Open it in Uno Work once");
    });
  }),

  flow("dc-edge-unoset-asleep", async ({ page, url, step, shot }) => {
    await step("Uno's setup screen on the asleep MacBook says so", async () => {
      await openDemo(page, url, { mac: "asleep" });
      await go(page, `/assistants?view=uno-setup&env=${await envOf(page, "mac")}`);
      await page.getByTestId("uno-setup").waitFor({ timeout: 10_000 });
      await page.getByTestId("uno-setup-asleep").waitFor({ timeout: 10_000 });
      if (await page.getByTestId("uno-setup-start").isEnabled())
        throw new Error("Start is enabled on an asleep computer");
    });
    await shot("asleep");
  }),
];
