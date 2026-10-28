// Gating 28.10: an account without the assistants update (`assistants=off`)
// sees Work as 0.0.156 — places as rows, no Automations, no assistants block,
// no Connectors/Skills in Settings.
import { dismissBanners, flow } from "../harness.mjs";

export default flow("d-flag-off", async ({ page, url, step, shot }) => {
  await step("open without the assistants update", async () => {
    await page.goto(`${url}?world=live&assistants=off&speed=3&panel=closed`);
    await page.waitForFunction(() => Boolean(window.__assistDemo), null, { timeout: 30_000 });
    await page.getByTestId("sidebar-places").waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    await dismissBanners(page);
  });
  await step("places are rows, no Automations, no assistants block", async () => {
    const places = page.getByTestId("sidebar-places");
    if (!(await places.getByText("Files").isVisible())) throw new Error("Files is not a row");
    if ((await page.getByTestId("sidebar-nav-automations").count()) > 0)
      throw new Error("Automations shows without the flag");
    if ((await page.getByTestId("sidebar-assistants").getByText("Everything").count()) > 0)
      throw new Error("D notes beside Uno without the flag");
  });
  await shot("sidebar");
  await step("Settings: no Connectors, no Skills", async () => {
    await page.evaluate(() => window.__assistDemo.go("/settings"));
    await page.getByText("Account & plan").first().waitFor({ timeout: 10_000 });
    const nav = await page.locator("nav").allInnerTexts();
    const text = nav.join(" ");
    if (text.includes("Skills") || text.includes("Connectors"))
      throw new Error("Connectors/Skills in Settings without the flag");
  });
  await shot("settings");
});
