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

/**
 * Автозаполнение формы логина. Значения сериализуются через JSON.stringify,
 * чтобы исключить инъекцию в код скрипта. Используется и клиентом (Electron
 * webview), и серверным headless-браузером — поэтому живёт здесь, а не в web.
 */
export function buildFillLoginScript(username: string, password: string): string {
  return `(function (user, pass) {
  function setValue(el, value) {
    if (!el) return;
    var proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  var passwordInput = document.querySelector('input[type="password"]');
  var usernameInput =
    document.querySelector('input[autocomplete="username"]') ||
    document.querySelector('input[type="email"]') ||
    document.querySelector('input[name*="user" i], input[name*="login" i], input[name*="email" i]');
  if (!usernameInput && passwordInput) {
    var inputs = Array.prototype.slice.call(document.querySelectorAll("input"));
    var passwordIndex = inputs.indexOf(passwordInput);
    for (var i = passwordIndex - 1; i >= 0; i--) {
      var candidate = inputs[i];
      if (candidate.type === "text" || candidate.type === "email" || candidate.type === "tel") {
        usernameInput = candidate;
        break;
      }
    }
  }
  if (usernameInput) setValue(usernameInput, user);
  if (passwordInput) setValue(passwordInput, pass);
  return Boolean(usernameInput || passwordInput);
})(${JSON.stringify(username)}, ${JSON.stringify(password)});`;
}

/**
 * Перехват логина в встроенном браузере: скрипт ставит слушатели на отправку
 * формы и отдаёт пару логин/пароль хосту через `console.log` с nonce-префиксом.
 *
 * Почему консоль, а не sessionStorage: значение не должно нигде оставаться. К
 * моменту сабмита пароль уже лежит в DOM-инпуте страницы, а сообщение живёт
 * ровно до того, как его прочитает хост (`console-message` у webview) —
 * дополнительного места, где секрет можно найти позже, не появляется.
 *
 * Идемпотентен: повторный вызов с тем же nonce слушателей не удваивает.
 */
export function buildLoginCaptureScript(nonce: string): string {
  return `(function (nonce) {
  if (window.__unoLoginCaptureNonce === nonce) return true;
  window.__unoLoginCaptureNonce = nonce;
  function findUsername(passwordInput) {
    var direct =
      document.querySelector('input[autocomplete="username"]') ||
      document.querySelector('input[type="email"]') ||
      document.querySelector('input[name*="user" i], input[name*="login" i], input[name*="email" i]');
    if (direct && direct.value) return direct.value;
    var inputs = Array.prototype.slice.call(document.querySelectorAll("input"));
    var passwordIndex = inputs.indexOf(passwordInput);
    for (var i = passwordIndex - 1; i >= 0; i--) {
      var candidate = inputs[i];
      if (
        (candidate.type === "text" || candidate.type === "email" || candidate.type === "tel") &&
        candidate.value
      ) {
        return candidate.value;
      }
    }
    return "";
  }
  function emit() {
    try {
      var passwordInput = null;
      var candidates = document.querySelectorAll('input[type="password"]');
      for (var i = 0; i < candidates.length; i++) {
        if (candidates[i].value) {
          passwordInput = candidates[i];
          break;
        }
      }
      if (!passwordInput) return;
      var username = findUsername(passwordInput);
      if (!username) return;
      console.log(
        nonce + JSON.stringify({ username: username, password: passwordInput.value }),
      );
    } catch (error) {
      /* страница могла запретить доступ — молча выходим */
    }
  }
  document.addEventListener("submit", emit, true);
  document.addEventListener(
    "click",
    function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      // SPA-логины отправляются кнопкой без form.submit.
      if (target.closest('button, input[type="submit"], [role="button"]')) emit();
    },
    true,
  );
  document.addEventListener(
    "keydown",
    function (event) {
      if (event.key === "Enter") emit();
    },
    true,
  );
  return true;
})(${JSON.stringify(nonce)});`;
}
