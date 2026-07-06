/**
 * DOM-скрипты браузерной автоматизации, общие для обоих исполнителей
 * bridge-команд: Electron `<webview>` в клиенте (`executeJavaScript`) и
 * серверный headless Chromium (`page.evaluate`). Живут в одном месте, чтобы
 * семантика `click`/`clickText`/`type` была побайтово одинаковой.
 */

export function buildClickSelectorScript(selector: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error("Element not found");
    el.scrollIntoView({ block: "center", inline: "center" });
    if (typeof el.click === "function") el.click();
    return { clicked: true, tagName: el.tagName, text: (el.innerText || el.value || "").slice(0, 200) };
  })()`;
}

export function buildClickTextScript(text: string): string {
  return `(() => {
    const needle = ${JSON.stringify(text)}.trim().toLowerCase();
    if (!needle) throw new Error("Missing text");
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const candidates = Array.from(document.querySelectorAll("a,button,input,textarea,select,label,[role='button'],[onclick]"));
    const el = candidates.find((node) => {
      if (!visible(node)) return false;
      const text = (node.innerText || node.getAttribute("aria-label") || node.value || "").trim().toLowerCase();
      return text.includes(needle);
    });
    if (!el) throw new Error("Element text not found");
    el.scrollIntoView({ block: "center", inline: "center" });
    if (typeof el.click === "function") el.click();
    return { clicked: true, tagName: el.tagName, text: (el.innerText || el.value || "").slice(0, 200) };
  })()`;
}

export function buildTypeScript(selector: string, value: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error("Element not found");
    el.scrollIntoView({ block: "center", inline: "center" });
    if (typeof el.focus === "function") el.focus();
    if ("value" in el) {
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      el.textContent = ${JSON.stringify(value)};
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ${JSON.stringify(value)} }));
    }
    return { typed: true, tagName: el.tagName };
  })()`;
}
