// Assistants D, edit 1 (28.10, sub-stream E): "A computer of its own" right in
// the wizard — Plus has room: Create its computer → steps → the assistant is
// on it; Free: "Needs an upgrade" + the checkout of the plan that has room.
// Needs OwnComputerSetup under "persona-works-on-own" (PersonaParts/Creator).
// `node demo-e2e/run.mjs d-own` runs them.
import { flow, openDemo } from "../harness.mjs";

async function toWhereItWorks(page, name) {
  await page.evaluate(() => window.__assistDemo.go("/assistants", { view: "new" }));
  await page.getByTestId("persona-gallery").waitFor({ timeout: 10_000 });
  await page.getByTestId("persona-card-helper").click();
  await page.getByTestId("persona-name").fill(name);
  await page.getByTestId("persona-next").click();
  await page.getByTestId("persona-works-on").waitFor();
  await page.getByTestId("persona-works-on-own").click();
  await page.getByTestId("own-computer").waitFor({ timeout: 10_000 });
}

export default flow("d-own-create", async ({ page, url, step, shot }) => {
  await step("Plus: where it works → a computer of its own → the offer", async () => {
    await openDemo(page, url, { world: "live", tier: "plus" });
    await toWhereItWorks(page, "Mia");
    await page.getByTestId("own-computer-offer").waitFor({ timeout: 10_000 });
    await page.getByText("mia-computer").first().waitFor();
  });
  await shot("offer");
  await step("Create its computer → Creating / Starting / Connecting", async () => {
    await page.getByTestId("own-computer-create").click();
    await page.getByTestId("own-computer-progress").waitFor({ timeout: 5_000 });
  });
  await shot("progress");
  await step("ready: the assistant lives on mia-computer", async () => {
    await page.getByTestId("own-computer-ready").waitFor({ timeout: 40_000 });
    await page.getByTestId("own-computer-ready").getByText("mia-computer").waitFor();
  });
  await shot("ready");
});

export const flows = [
  flow("d-own-upgrade", async ({ page, url, step, shot }) => {
    await step("Free: a computer of its own → Needs an upgrade before any click", async () => {
      await openDemo(page, url, { world: "new", tier: "free" });
      await toWhereItWorks(page, "Leo");
      await page.getByTestId("own-computer-upgrade").waitFor({ timeout: 10_000 });
      if ((await page.getByTestId("own-computer-create").count()) > 0)
        throw new Error("Create is offered on a plan without room");
    });
    await shot("upgrade");
    await step("the button goes to the console's checkout of Plus", async () => {
      const go = page.getByTestId("own-computer-upgrade-go");
      const href = await go.getAttribute("data-href");
      if (!href?.includes("/billing?tab=plan&plan=plus&checkout=1"))
        throw new Error(`upgrade goes to ${href}`);
      const text = await go.innerText();
      if (!text.includes("Get Plus")) throw new Error(`button says ${text}`);
    });
  }),
];
