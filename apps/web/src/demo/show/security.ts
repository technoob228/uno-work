// The Security mock (16.10, Misha's walk point 8): "Показать" opens
// Settings → Security in the state to look at.
import { demoShow } from "../demoFlag";
import { waitFor } from "./p4";

async function openSecurity(): Promise<boolean> {
  if (!location.hash.startsWith("#/settings/security")) location.hash = "#/settings/security";
  return waitFor(
    () => document.querySelector("[aria-label='Internet access for all computers']") !== null,
  );
}

function click(selector: string) {
  document.querySelector<HTMLElement>(selector)?.click();
}

demoShow.s1 = async () => {
  await openSecurity();
  window.scrollTo({ top: 0 });
};

demoShow.s2 = async () => {
  if (!(await openSecurity())) return;
  const isolated = document.querySelector<HTMLElement>(
    "[aria-label='Internet access for all computers'] button:last-child",
  );
  if (isolated && isolated.getAttribute("aria-pressed") !== "true") isolated.click();
};

demoShow.s3 = async () => {
  if (!(await openSecurity())) return;
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    item.textContent?.includes("Stop everything"),
  );
  button?.scrollIntoView({ block: "center" });
  button?.click();
};

demoShow.s4 = async () => {
  if (!(await openSecurity())) return;
  click("[aria-label='Show advanced security']");
  await new Promise((resolve) => setTimeout(resolve, 300));
  document
    .querySelector("[aria-label='Hide advanced security']")
    ?.scrollIntoView({ block: "start" });
};
