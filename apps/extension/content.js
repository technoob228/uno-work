/**
 * Bridge between the Uno Work page and the extension service worker.
 *
 * The page cannot talk to the service worker directly (and we deliberately do
 * not publish the extension id into the page), so this content script relays
 * `window.postMessage` traffic. It only runs on Uno Work origins, listed in the
 * manifest's content_scripts matches.
 */

const PAGE_SOURCE = "uno-work-page";
const EXTENSION_SOURCE = "uno-work-extension";

function announce() {
  window.postMessage(
    {
      source: EXTENSION_SOURCE,
      type: "hello",
      version: chrome.runtime.getManifest().version,
    },
    window.location.origin,
  );
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const message = event.data;
  if (!message || message.source !== PAGE_SOURCE || typeof message.requestId !== "string") return;

  if (message.type === "hello") {
    announce();
    return;
  }

  chrome.runtime.sendMessage(
    { type: message.type, input: message.input },
    (response) => {
      const error = chrome.runtime.lastError;
      window.postMessage(
        {
          source: EXTENSION_SOURCE,
          type: "result",
          requestId: message.requestId,
          response: error ? { ok: false, error: error.message } : response,
        },
        window.location.origin,
      );
    },
  );
});

announce();
