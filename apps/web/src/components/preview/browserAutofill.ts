/**
 * Скрипт автозаполнения логина/пароля, исполняемый внутри webview через
 * `executeJavaScript`. Значения сериализуются через JSON.stringify, чтобы
 * исключить инъекцию в код скрипта.
 */
export function buildAutofillScript(username: string, password: string): string {
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
