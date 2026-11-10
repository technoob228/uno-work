// Telegram groups (10.11): who Uno listens to in each group — Settings →
// Assistant → Groups on the real Work web client with the demo daemon.
// `node demo-e2e/run.mjs tg-groups`.
import { join } from "node:path";

import { SHOTS, flow, openDemo, seeText } from "../harness.mjs";

const FAMILY = "-1002200300401";
const ACME = "-1002200300402";
const RENOVATION = "-1002200300403";
const BOOK_CLUB = "-1002200300404";

const group = (page, chatId) => page.getByTestId(`telegram-group-${chatId}`);
const option = (page, chatId, value) => page.getByTestId(`telegram-group-${chatId}-${value}`);
const person = (page, chatId, id) => page.getByTestId(`telegram-group-${chatId}-person-${id}`);
const pressed = async (locator) =>
  (await locator.getAttribute("aria-pressed")) === "true" ||
  (await locator.getAttribute("data-pressed")) !== null;

async function expectPressed(locator, want, what) {
  for (let i = 0; i < 40; i += 1) {
    if ((await pressed(locator)) === want) return;
    await locator.page().waitForTimeout(100);
  }
  throw new Error(`${what}: expected ${want ? "on" : "off"}`);
}

async function openGroups(page, url, world = {}) {
  await openDemo(page, url, { world: "live", tg: "on", ...world });
  await page.evaluate(() => {
    location.hash = `#/settings/environment/${window.__assistDemo.environmentOf("work")}/assistants`;
  });
}

export default flow("tg-groups", async ({ page, url, step, shot }) => {
  await step("Settings → Assistant lists the groups with who is heard", async () => {
    await openGroups(page, url);
    await group(page, FAMILY).waitFor({ timeout: 30_000 });
    await group(page, FAMILY).scrollIntoViewIfNeeded();
    await expectPressed(option(page, FAMILY, "selected"), true, "Family: People I pick");
    await expectPressed(option(page, ACME, "anyone"), true, "Acme: Everyone");
    await expectPressed(option(page, RENOVATION, "owners"), true, "Renovation: Only me");
    // The owner is never offered as a choice.
    if ((await person(page, FAMILY, "100200300").count()) !== 0) {
      throw new Error("the owner is listed among the people to pick");
    }
    await expectPressed(person(page, FAMILY, "100200301"), true, "Anna picked");
    await expectPressed(person(page, FAMILY, "100200304"), false, "Kirill not picked");
    await seeText(page, "Book club");
    await page.evaluate(() => window.scrollTo(0, 0));
    await group(page, FAMILY).evaluate((node) =>
      node.closest("section")?.scrollIntoView({ block: "center" }),
    );
    await page.waitForTimeout(400);
    await shot("groups");
    // The section alone, for the report.
    await group(page, FAMILY)
      .locator("xpath=ancestor::section[1]")
      .screenshot({ path: join(SHOTS, "tg-groups-section.png") });
  });

  await step("a press picks a person; a second press lets them go", async () => {
    await person(page, FAMILY, "100200304").click();
    await expectPressed(person(page, FAMILY, "100200304"), true, "Kirill picked");
    await person(page, FAMILY, "100200301").click();
    await expectPressed(person(page, FAMILY, "100200301"), false, "Anna let go");
    await shot("picked");
  });

  await step("only me hides the list; the picked people are kept for later", async () => {
    await option(page, FAMILY, "owners").click();
    await expectPressed(option(page, FAMILY, "owners"), true, "Family: Only me");
    if ((await person(page, FAMILY, "100200304").count()) !== 0) {
      throw new Error("people are still listed under Only me");
    }
    await option(page, FAMILY, "selected").click();
    await expectPressed(person(page, FAMILY, "100200304"), true, "Kirill still picked");
  });

  await step("everyone, and a group with nobody else seen yet", async () => {
    await option(page, RENOVATION, "anyone").click();
    await expectPressed(option(page, RENOVATION, "anyone"), true, "Renovation: Everyone");
    await option(page, ACME, "selected").click();
    await expectPressed(option(page, ACME, "selected"), true, "Acme: People I pick");
    await person(page, ACME, "100200311").click();
    await expectPressed(person(page, ACME, "100200311"), true, "Olga picked");
  });

  await step("a waiting group is added with one button", async () => {
    await page.getByTestId(`telegram-group-add-${BOOK_CLUB}`).click();
    await group(page, BOOK_CLUB).waitFor({ timeout: 10_000 });
    await expectPressed(option(page, BOOK_CLUB, "owners"), true, "Book club: Only me");
    await option(page, BOOK_CLUB, "selected").click();
    await seeText(page, "Nobody else has called @uno_team_bot here yet");
    await group(page, BOOK_CLUB).scrollIntoViewIfNeeded();
    await shot("added");
  });
});

export const flows = [
  flow("tg-groups-no-telegram", async ({ page, url, step }) => {
    await step("without Telegram there is no Groups section", async () => {
      await openGroups(page, url, { tg: "off" });
      await seeText(page, "Connect Telegram");
      await page.waitForTimeout(1500);
      if ((await page.getByText("People I pick").count()) !== 0) {
        throw new Error("Groups shown without a bot");
      }
    });
  }),
];
