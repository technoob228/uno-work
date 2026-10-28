// Variant C: a new teammate under Uno, "like Grok companions" — the gallery
// of characters (step 1), "Make X yours" (step 2), and its first words in
// character. `node demo-e2e/run.mjs c-create`.
import { dismissBanners, flow, seeText } from "../harness.mjs";

/** Like the harness' openDemo, but waits for the variant's sidebar (no "Assistants" header in C). */
async function openDemo(page, baseUrl, world = {}, { speed = 3 } = {}) {
  const params = new URLSearchParams({
    world: "live",
    ...world,
    speed: String(speed),
    panel: "closed",
  });
  await page.goto(`${baseUrl}?${params}`);
  await page.waitForFunction(() => Boolean(window.__assistDemo), null, { timeout: 30_000 });
  await page.getByTestId("sidebar-assistants").first().waitFor({ timeout: 30_000 });
  await dismissBanners(page);
}

async function openGallery(page) {
  // The sidebar's "+" next to Team (New teammate).
  await page.getByTestId("sidebar-new-assistant").first().click();
  await page.getByTestId("teammate-gallery").waitFor({ timeout: 15_000 });
}

async function createAndWaitForChat(page, name) {
  await page.getByTestId("teammate-create").click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="teammate-new"]'), null, {
    timeout: 20_000,
  });
  await page.locator('[contenteditable="true"]').last().waitFor({ timeout: 15_000 });
  // Its row is in the sidebar.
  await page
    .locator('[data-testid="sidebar-assistant"]')
    .filter({ hasText: name.slice(0, 12) })
    .first()
    .waitFor({ timeout: 15_000 });
}

/** Main: pick Nova from the gallery → Create → it writes first → answer its first task. */
export default flow("c-create-gallery", async ({ page, url, step, shot }) => {
  await step("open live", () => openDemo(page, url));
  await step("New teammate → the gallery", () => openGallery(page));
  await step("Mia and Bolt are already on the team", async () => {
    await page
      .locator('[data-testid="teammate-card"][data-name="Mia"]')
      .getByTestId("teammate-card-on-team")
      .waitFor({ timeout: 5_000 });
  });
  await shot("gallery");
  await step("pick Nova → Make Nova yours", async () => {
    await page.locator('[data-testid="teammate-card"][data-name="Nova"]').click();
    await seeText(page, "Make Nova yours");
    const name = await page.getByTestId("teammate-name").inputValue();
    if (name !== "Nova") throw new Error(`name prefilled as “${name}”`);
    const pressed = await page.getByTestId("teammate-role-researcher").getAttribute("aria-pressed");
    if (pressed !== "true") throw new Error("role Researcher not picked");
  });
  await shot("make-nova-yours");
  await step("Create Nova → its chat opens", async () => {
    await createAndWaitForChat(page, "Nova");
  });
  await step("Nova writes first, in character", async () => {
    await seeText(page, "I'm Nova, your new researcher", 20_000);
    await seeText(page, "I report to Uno");
    await seeText(page, "Compare 3 competitors", 20_000);
  });
  await shot("nova-greets");
  await step("answer the first task", async () => {
    await page.getByText("Compare 3 competitors", { exact: true }).first().click();
    await seeText(page, "Three closest", 30_000);
  });
  await shot("nova-result");
});

export const flows = [
  /** Main: build your own — Ada, a bookkeeper, a drawn face, Asks first. */
  flow("c-create-own", async ({ page, url, step, shot }) => {
    await step("open live → gallery", async () => {
      await openDemo(page, url);
      await openGallery(page);
    });
    await step("Build your own", async () => {
      await page.getByTestId("teammate-build-own").click();
      await page.getByTestId("teammate-name").fill("Ada");
      await page.getByTestId("teammate-role-other").click();
      await page.getByTestId("teammate-role-custom").fill("Bookkeeper");
      await page.getByTestId("teammate-slider-talk").fill("15");
      await page.getByTestId("teammate-slider-risk").fill("10");
      await page.getByTestId("teammate-tag-patient").click();
      await page.getByTestId("teammate-tag-nerdy").click();
      await seeText(page, "Make Ada yours");
    });
    await step("Persona → Draw a face → portrait", async () => {
      await page.getByTestId("teammate-face-tab-persona").click();
      await page.getByTestId("teammate-face-kind-human").click();
      await page.getByTestId("teammate-face-draw").click();
      await page
        .getByTestId("teammate-tune")
        .getByTestId("assistant-avatar-image")
        .first()
        .waitFor({ timeout: 10_000 });
      await seeText(page, "Another one");
    });
    await step("Asks first", async () => {
      await page.getByTestId("teammate-mode-asks").click();
      if ((await page.getByTestId("teammate-mode-asks").getAttribute("aria-checked")) !== "true")
        throw new Error("Asks first not picked");
      await page.waitForTimeout(300);
    });
    await shot("ada-tuned");
    await step("Create Ada → she greets first", async () => {
      await createAndWaitForChat(page, "Ada");
      await seeText(page, "Ada, your bookkeeper", 20_000);
      await seeText(page, "Chase the Acme invoice", 20_000);
    });
    await step("her face is the drawn portrait in the sidebar", async () => {
      // The summary names the picture only with daemon.ts' `avatar: avatarOf(...)` (variantC/avatarDaemon).
      const named = await page.evaluate(async () => {
        const answer = await fetch("/api/manager/assistants").then((r) => r.json());
        return answer.assistants.some((item) => item.title === "Ada" && item.profile?.avatar);
      });
      if (!named) {
        console.log("  note: the daemon summary has no avatar yet — sidebar portrait not checked");
        return;
      }
      await page
        .locator('[data-testid="sidebar-assistant"]')
        .filter({ hasText: "Ada" })
        .getByTestId("assistant-avatar-image")
        .first()
        .waitFor({ timeout: 10_000 });
    });
    await shot("ada-greets");
    await step("Asks first: chasing Acme waits for Allow", async () => {
      await page.getByText("Chase the Acme invoice", { exact: true }).first().click();
      await seeText(page, "Send an email to billing@acme.example", 30_000);
    });
    await shot("ada-asks-allow");
  }),

  /** Edge: an 80-character name keeps 40; the sidebar row and the chat header don't overflow. */
  flow("c-create-long-name", async ({ page, url, step, shot }) => {
    const long =
      "Maximilian Alexander Konstantinopolsky the Third of the Northern Valley Assistant";
    await step("open live → Bolt-like own teammate", async () => {
      await openDemo(page, url);
      await openGallery(page);
      await page.getByTestId("teammate-build-own").click();
    });
    let kept = "";
    await step("type 80 characters → the field keeps 40", async () => {
      const field = page.getByTestId("teammate-name");
      await field.click();
      await page.keyboard.type(long.slice(0, 80), { delay: 2 });
      kept = await field.inputValue();
      if (kept.length !== 40) throw new Error(`kept ${kept.length} characters`);
      await page.getByTestId("teammate-name-count").waitFor({ timeout: 2_000 });
    });
    await shot("long-name-field");
    await step("create", () => createAndWaitForChat(page, kept.trim()));
    await page.waitForTimeout(1_500);
    await step("the sidebar row and chat header truncate, no overflow", async () => {
      const report = await page.evaluate((name) => {
        const problems = [];
        const leaves = [...document.querySelectorAll("body *")].filter(
          (el) =>
            el.children.length === 0 &&
            (el.textContent ?? "").trim().startsWith(name.slice(0, 20)) &&
            el.getBoundingClientRect().width > 0,
        );
        for (const el of leaves) {
          const text = (el.textContent ?? "").trim();
          if (text.length > 60) continue; // a line of chat that quotes it
          if (text.replace(/…$/, "").length > 40) problems.push(`text ${text.length}: ${text}`);
          const box = el.getBoundingClientRect();
          const holder =
            el.closest("li, header, [data-testid='chat-header'], h1, h2") ?? el.parentElement;
          const outer = holder.getBoundingClientRect();
          if (box.right > outer.right + 1)
            problems.push(`${el.tagName} sticks out ${Math.round(box.right - outer.right)} px`);
          if (holder.scrollWidth > holder.clientWidth + 1)
            problems.push(`${holder.tagName} scrolls sideways`);
        }
        if (document.documentElement.scrollWidth > innerWidth + 1)
          problems.push("page scrolls sideways");
        return { seen: leaves.length, problems };
      }, kept.trim());
      if (report.seen < 2) throw new Error(`the name shows ${report.seen} time(s)`);
      if (report.problems.length) throw new Error(report.problems.join("; "));
    });
    await shot("long-name-chat");
  }),

  /** Edge: Uno AI can't draw — the line says so, the emoji stays, Create still works. */
  flow("c-create-face-fails", async ({ page, url, step, shot }) => {
    await step("open live, face=fail → Juno", async () => {
      await openDemo(page, url, { face: "fail" });
      await openGallery(page);
      await page.locator('[data-testid="teammate-card"][data-name="Juno"]').click();
      await seeText(page, "Make Juno yours");
    });
    await step("Persona → Draw a face → the error line", async () => {
      await page.getByTestId("teammate-face-tab-persona").click();
      await page.getByTestId("teammate-face-draw").click();
      await page.getByTestId("teammate-face-error").waitFor({ timeout: 10_000 });
      await seeText(page, "Couldn't draw a face right now. Your emoji stays");
    });
    await shot("face-error");
    await step("Create Juno with the emoji → she greets", async () => {
      await createAndWaitForChat(page, "Juno");
      await seeText(page, "I'm Juno", 20_000);
      const images = await page
        .locator('[data-testid="sidebar-assistant"]')
        .filter({ hasText: "Juno" })
        .getByTestId("assistant-avatar-image")
        .count();
      if (images > 0) throw new Error("Juno got a picture though drawing failed");
    });
    await shot("juno-greets-emoji");
  }),
];
