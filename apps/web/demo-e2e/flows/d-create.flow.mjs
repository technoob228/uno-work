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
  await step("mode: Cautious", async () => {
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
  await step("Start → its one chat, mode Cautious", async () => {
    await page.getByTestId("uno-setup-start").click();
    await seeText(page, "what's burning today", 25_000);
    await page.getByTestId("assistant-mode-chip").filter({ hasText: "Cautious" }).waitFor();
  });
  await shot("chat");
});

export const flows = [
  flow("dc-development", async ({ page, url, step, shot }) => {
    await step("open live → gallery → Developer (Bolt)", async () => {
      await openDemo(page, url);
      await openGallery(page);
      await page.getByTestId("persona-card-developer").click();
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
      "What should it do? → (Developer) a project + a repo, Start now with a task",
      async () => {
        await page.getByTestId("persona-next").click();
        await page.getByTestId("persona-job-development-form").waitFor();
        // Its own part is on; the other two are there to turn on, off by default.
        await page
          .getByTestId("persona-part-development-toggle")
          .and(page.locator('[aria-checked="true"]'))
          .waitFor();
        for (const kind of ["accounts", "tasks"]) {
          if (
            (await page.getByTestId(`persona-part-${kind}-toggle`).getAttribute("aria-checked")) !==
            "false"
          )
            throw new Error(`${kind} is on for a Developer`);
        }
        await page.getByTestId("persona-dev-project-p-work-landing").click();
        await page.getByTestId("persona-dev-repos").fill("misha-demo/checkout");
        await page.getByTestId("persona-start-now").click();
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
    await step("open live → gallery → Accounts manager (Leo)", async () => {
      await openDemo(page, url, { mode: "asks-first" });
      await openGallery(page);
      await page.getByTestId("persona-card-accounts-manager").click();
      await toJob(page);
    });
    await step("accounts → the form in a window", async () => {
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
    await step("Start now with a task (no schedules here)", async () => {
      if ((await page.getByTestId("persona-repeat").count()) > 0)
        throw new Error("schedules are still in the setup");
      await page.getByTestId("persona-start-now").click();
      await page.getByTestId("persona-job-task").fill("Post the weekly update");
    });
    await shot("job");
    await step("Create → first message says how to sign in, no password", async () => {
      await createAndOpen(page);
      await seeText(page, 'browser_command {"login": "instagram.com"}');
      await passwordNowhere(page);
    });
    await shot("channel");
    await step("its chat: a chat signs in and does it", async () => {
      await page.getByTestId("persona-open").click();
      await seeText(page, "Signed in to instagram.com", 30_000);
      await seeText(page, "Done on instagram.com", 30_000);
      await passwordNowhere(page);
    });
    await shot("done");
  }),

  flow("dc-tasks", async ({ page, url, step, shot }) => {
    await step("open live → gallery → Helper (Mia)", async () => {
      await openDemo(page, url, { notion: "off" });
      await openGallery(page);
      await page.getByTestId("persona-card-helper").click();
      await page.getByTestId("persona-name").fill("Mia Tasks");
      await toJob(page);
    });
    await step("connect Notion on its computer + own MCP server", async () => {
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
      await page.getByTestId("persona-start-now").click();
      await page.getByTestId("persona-job-task").fill("Sum up today's new mail");
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

  flow("dc-all-parts", async ({ page, url, step, shot }) => {
    await step("open live → Developer, then turn Accounts and Tasks on too", async () => {
      await openDemo(page, url);
      await openGallery(page);
      await page.getByTestId("persona-card-developer").click();
      await page.getByTestId("persona-name").fill("Max All");
      await toJob(page);
      await page.getByTestId("persona-part-accounts-toggle").click();
      await page.getByTestId("persona-part-tasks-toggle").click();
      await page.getByTestId("persona-job-development-form").waitFor();
      await page.getByTestId("persona-job-accounts-form").waitFor();
      await page.getByTestId("persona-job-tasks-form").waitFor();
    });
    await step("a project + an account (password in the window only)", async () => {
      await page.getByTestId("persona-dev-project-p-work-landing").click();
      await page.getByTestId("persona-accounts-add").click();
      await page.getByTestId("persona-account-service").fill("Instagram");
      await page.getByTestId("persona-account-site").fill("instagram.com");
      await page.getByTestId("persona-account-username").fill("max@shop.example");
      await page.getByTestId("persona-account-password").fill(PASSWORD);
      await page.getByTestId("persona-accounts-save").click();
      await page.getByTestId("persona-accounts-dialog").waitFor({ state: "detached" });
    });
    await step(
      "edge: Start now with Accounts on but its account removed → asks for one",
      async () => {
        await page.getByTestId("persona-start-now").click();
        await page.getByRole("button", { name: "Remove Instagram" }).click();
        await page.getByTestId("persona-create").click();
        await seeText(page, "Add at least one account, or turn Accounts off.");
        if ((await page.getByTestId("persona-channel").count()) > 0)
          throw new Error("made without the account it needs");
        await page.getByTestId("persona-accounts-add").click();
        await page.getByTestId("persona-account-service").fill("Instagram");
        await page.getByTestId("persona-account-site").fill("instagram.com");
        await page.getByTestId("persona-account-username").fill("max@shop.example");
        await page.getByTestId("persona-account-password").fill(PASSWORD);
        await page.getByTestId("persona-accounts-save").click();
        await page.getByTestId("persona-accounts-dialog").waitFor({ state: "detached" });
        await page.getByTestId("persona-job-task").fill("Ship the landing and post about it");
      },
    );
    await shot("all-parts");
    await step("Create → one first message with all three parts", async () => {
      await createAndOpen(page);
      await seeText(page, "- Lead development of landing.");
      await seeText(page, "- Work in my accounts — Instagram (instagram.com).");
      await seeText(page, "- Help me with");
      await seeText(page, 'browser_command {"login": "instagram.com"}');
      await passwordNowhere(page);
    });
    await shot("channel");
    await step("Open → it starts on it", async () => {
      await page.getByTestId("persona-open").click();
      await seeText(page, "Done on instagram.com", 30_000);
      await passwordNowhere(page);
    });
  }),

  flow("dc-only-when-asked", async ({ page, url, step, shot }) => {
    await step("open live → gallery: three roles only", async () => {
      await openDemo(page, url);
      await openGallery(page);
      const cards = await page.locator('[data-testid^="persona-card-"]').count();
      if (cards !== 3) throw new Error(`${cards} cards in the gallery`);
    });
    await shot("gallery");
    await step("Accounts manager, defaults: Only when I ask — no accounts needed yet", async () => {
      await page.getByTestId("persona-card-accounts-manager").click();
      await page.getByTestId("persona-name").fill("Leo Waits");
      await toJob(page);
      await page
        .getByTestId("persona-start-ask")
        .and(page.locator('[aria-pressed="true"]'))
        .waitFor();
      if ((await page.getByTestId("persona-job-task").count()) > 0)
        throw new Error("a task field while it waits to be asked");
    });
    await shot("waits");
    await step("Create → Open: it greets, nothing was sent for you", async () => {
      await createAndOpen(page);
      if ((await page.getByTestId("persona-first-message").count()) > 0)
        throw new Error("a first message without Start now");
      await page.getByTestId("persona-open").click();
      await seeText(page, "Leo Waits here ✨", 25_000);
      if ((await page.getByText("Your job:", { exact: false }).count()) > 0)
        throw new Error("a job message was sent");
    });
    await shot("greets");
  }),

  flow("dc-edge-long-name-channel", async ({ page, url, step, shot }) => {
    await step("open live → Developer, a very long name", async () => {
      await openDemo(page, url);
      await openGallery(page);
      await page.getByTestId("persona-card-developer").click();
      await page
        .getByTestId("persona-name")
        .fill("Maximiliana-Alexandra the Extremely Thorough Research Assistant of Everything");
      const value = await page.getByTestId("persona-name").inputValue();
      if (value.length > 40) throw new Error(`name is ${value.length} long`);
    });
    await step("Only when I ask → Create; no first message; its own bot offered", async () => {
      await toJob(page);
      await createAndOpen(page);
      if ((await page.getByTestId("persona-first-message").count()) > 0)
        throw new Error("a first message without Start now");
      await page.getByTestId("persona-channel-telegram").click();
      await seeText(page, "BotFather", 15_000);
    });
    await shot("own-bot");
  }),

  flow("dc-edge-mac-asleep", async ({ page, url, step, shot }) => {
    await step("open live, MacBook asleep", async () => {
      await openDemo(page, url, { mac: "asleep" });
      await openGallery(page);
      await page.getByTestId("persona-card-helper").click();
      await page.getByTestId("persona-name").fill("Night Owl");
      await page.getByTestId("persona-next").click();
      await page.getByTestId("persona-works-on").waitFor();
    });
    await step("a computer of its own: Create waits for it, honestly", async () => {
      await page.getByTestId("persona-works-on-own").click();
      await seeText(page, "Create its computer above");
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
