/**
 * Uno Work Companion — service worker.
 *
 * Executes browser-bridge commands in the user's own tabs, so the agent works
 * inside sessions the user is already signed into. No credentials ever leave
 * the browser.
 *
 * Trust model: the agent may only touch tabs it opened itself, plus tabs the
 * user explicitly shared from the popup. Everything else is invisible to it.
 * There is deliberately no `evaluate` — arbitrary script execution would make
 * this a remote-code-execution vector (and fail extension review).
 */

const MANAGED_TABS_KEY = "managedTabIds";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

const SUPPORTED_COMMANDS = new Set([
  "state",
  "openUrl",
  "navigate",
  "reload",
  "back",
  "forward",
  "click",
  "clickText",
  "type",
  "press",
  "screenshot",
  // Автозаполнение сохранённого логина: значения приходят от демона Uno Work по
  // явному действию пользователя (кнопка с ключом в панели), а не от агента.
  "fillCredential",
]);

async function readManagedTabIds() {
  const stored = await chrome.storage.session.get(MANAGED_TABS_KEY);
  const ids = stored[MANAGED_TABS_KEY];
  return Array.isArray(ids) ? ids : [];
}

async function writeManagedTabIds(ids) {
  await chrome.storage.session.set({ [MANAGED_TABS_KEY]: [...new Set(ids)] });
}

async function shareTab(tabId) {
  const ids = await readManagedTabIds();
  ids.push(tabId);
  await writeManagedTabIds(ids);
}

async function unshareTab(tabId) {
  const ids = await readManagedTabIds();
  await writeManagedTabIds(ids.filter((id) => id !== tabId));
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void unshareTab(tabId);
});

/** The tab commands act on: the most recently shared one that still exists. */
async function resolveTargetTab() {
  const ids = await readManagedTabIds();
  for (const tabId of [...ids].reverse()) {
    try {
      return await chrome.tabs.get(tabId);
    } catch {
      await unshareTab(tabId);
    }
  }
  return null;
}

function isAllowedUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function clampTimeout(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(value, MAX_TIMEOUT_MS);
}

async function waitForTabLoad(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return tab;
    if (Date.now() > deadline) return tab;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

// --- Injected page functions. These run in the page, not here. -------------

function pageClickSelector(selector) {
  const element = document.querySelector(selector);
  if (!element) return { clicked: false, reason: "not-found" };
  element.scrollIntoView({ block: "center" });
  element.click();
  return { clicked: true, tagName: element.tagName };
}

function pageClickText(text) {
  const needle = text.trim().toLowerCase();
  const candidates = Array.from(
    document.querySelectorAll("button, a, [role=button], input[type=submit], summary, label"),
  );
  const match =
    candidates.find(
      (element) => (element.innerText || element.value || "").trim().toLowerCase() === needle,
    ) ??
    candidates.find((element) =>
      (element.innerText || element.value || "").trim().toLowerCase().includes(needle),
    );
  if (!match) return { clicked: false, reason: "not-found" };
  match.scrollIntoView({ block: "center" });
  match.click();
  return {
    clicked: true,
    tagName: match.tagName,
    text: (match.innerText || match.value || "").slice(0, 120),
  };
}

function pageType(selector, text) {
  const element = selector ? document.querySelector(selector) : (document.activeElement ?? null);
  if (!element) return { typed: false, reason: "not-found" };
  element.focus();
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) {
    setter.call(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { typed: true };
  }
  if (element.isContentEditable) {
    element.textContent = text;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return { typed: true };
  }
  return { typed: false, reason: "not-editable" };
}

/**
 * Автозаполнение формы логина. Значения передаются как аргументы инъекции — это
 * фиксированная функция, а не произвольный скрипт (`evaluate` расширение не
 * поддерживает намеренно).
 */
function pageFillLogin(username, password) {
  function setValue(element, value) {
    if (!element) return;
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const passwordInput = document.querySelector('input[type="password"]');
  let usernameInput =
    document.querySelector('input[autocomplete="username"]') ||
    document.querySelector('input[type="email"]') ||
    document.querySelector('input[name*="user" i], input[name*="login" i], input[name*="email" i]');
  if (!usernameInput && passwordInput) {
    const inputs = Array.prototype.slice.call(document.querySelectorAll("input"));
    const passwordIndex = inputs.indexOf(passwordInput);
    for (let i = passwordIndex - 1; i >= 0; i--) {
      const candidate = inputs[i];
      if (candidate.type === "text" || candidate.type === "email" || candidate.type === "tel") {
        usernameInput = candidate;
        break;
      }
    }
  }
  if (usernameInput) setValue(usernameInput, username);
  if (passwordInput) setValue(passwordInput, password);
  return { filled: Boolean(usernameInput || passwordInput) };
}

function pagePress(key) {
  const target = document.activeElement ?? document.body;
  for (const type of ["keydown", "keypress", "keyup"]) {
    target.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
  }
  if (key === "Enter" && target instanceof HTMLElement) {
    const form = target.closest("form");
    if (form) form.requestSubmit?.();
  }
  return { pressed: key };
}

// --- Command execution ------------------------------------------------------

async function executeInTab(tabId, func, args) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  return injection?.result ?? null;
}

async function runCommand(input) {
  const command = input?.command;
  if (!SUPPORTED_COMMANDS.has(command)) {
    return {
      ok: false,
      error:
        command === "evaluate"
          ? "The companion extension does not run arbitrary scripts. Use click/type/press, or switch the executor to the box browser."
          : `Unsupported command: ${String(command)}`,
    };
  }

  const timeoutMs = clampTimeout(input.timeoutMs);

  if (command === "openUrl") {
    if (!isAllowedUrl(input.url)) return { ok: false, error: "Only http(s) URLs can be opened." };
    const tab = await chrome.tabs.create({ url: input.url, active: true });
    await shareTab(tab.id);
    const loaded = await waitForTabLoad(tab.id, timeoutMs);
    return { ok: true, data: { url: loaded.url ?? input.url, tabId: tab.id } };
  }

  const tab = await resolveTargetTab();
  if (!tab) {
    return {
      ok: false,
      error:
        "No shared tab. Open one from the agent, or share the current tab from the extension popup.",
    };
  }

  switch (command) {
    case "state":
      return {
        ok: true,
        data: {
          url: tab.url ?? "",
          title: tab.title ?? "",
          loading: tab.status !== "complete",
          tabId: tab.id,
        },
      };

    case "navigate": {
      if (!isAllowedUrl(input.url)) return { ok: false, error: "Only http(s) URLs can be opened." };
      await chrome.tabs.update(tab.id, { url: input.url });
      const loaded = await waitForTabLoad(tab.id, timeoutMs);
      return { ok: true, data: { url: loaded.url ?? input.url } };
    }

    case "reload":
      await chrome.tabs.reload(tab.id);
      await waitForTabLoad(tab.id, timeoutMs);
      return { ok: true, data: { reloaded: true } };

    case "back":
      await chrome.tabs.goBack(tab.id);
      await waitForTabLoad(tab.id, timeoutMs);
      return { ok: true, data: { navigated: "back" } };

    case "forward":
      await chrome.tabs.goForward(tab.id);
      await waitForTabLoad(tab.id, timeoutMs);
      return { ok: true, data: { navigated: "forward" } };

    case "click": {
      if (!input.selector) return { ok: false, error: "Missing selector." };
      const result = await executeInTab(tab.id, pageClickSelector, [input.selector]);
      return result?.clicked
        ? { ok: true, data: result }
        : { ok: false, error: "Element not found." };
    }

    case "clickText": {
      if (!input.text) return { ok: false, error: "Missing text." };
      const result = await executeInTab(tab.id, pageClickText, [input.text]);
      return result?.clicked
        ? { ok: true, data: result }
        : { ok: false, error: "Element not found." };
    }

    case "type": {
      if (typeof input.text !== "string") return { ok: false, error: "Missing text." };
      const result = await executeInTab(tab.id, pageType, [input.selector ?? null, input.text]);
      return result?.typed
        ? { ok: true, data: result }
        : { ok: false, error: "No editable target." };
    }

    case "press": {
      if (!input.key) return { ok: false, error: "Missing key." };
      const result = await executeInTab(tab.id, pagePress, [input.key]);
      return { ok: true, data: result };
    }

    case "screenshot": {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return { ok: true, data: { dataUrl } };
    }

    case "fillCredential": {
      if (typeof input.username !== "string" || typeof input.password !== "string") {
        return { ok: false, error: "fillCredential requires credentials." };
      }
      const result = await executeInTab(tab.id, pageFillLogin, [input.username, input.password]);
      return result?.filled
        ? { ok: true, data: result }
        : { ok: false, error: "Поля логина на странице не найдены." };
    }

    default:
      return { ok: false, error: `Unsupported command: ${String(command)}` };
  }
}

async function handleMessage(message) {
  switch (message?.type) {
    case "ping":
      return { ok: true, data: { version: chrome.runtime.getManifest().version } };
    case "status": {
      const ids = await readManagedTabIds();
      return { ok: true, data: { sharedTabs: ids.length } };
    }
    case "command":
      return await runCommand(message.input ?? {});
    default:
      return { ok: false, error: "Unknown message type." };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
  return true;
});

// Popup actions.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "share-active-tab") return false;
  void (async () => {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!active?.id) {
      sendResponse({ ok: false, error: "No active tab." });
      return;
    }
    await shareTab(active.id);
    sendResponse({ ok: true, data: { tabId: active.id, url: active.url } });
  })();
  return true;
});
