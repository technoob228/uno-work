const statusElement = document.getElementById("status");

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve(
        chrome.runtime.lastError
          ? { ok: false, error: chrome.runtime.lastError.message }
          : response,
      );
    });
  });
}

async function refreshStatus() {
  const response = await send({ type: "status" });
  const count = response?.data?.sharedTabs ?? 0;
  statusElement.textContent =
    count === 0 ? "No tabs shared." : `${count} tab${count === 1 ? "" : "s"} shared.`;
}

document.getElementById("share").addEventListener("click", async () => {
  // Host permissions are optional and requested here, where a user gesture
  // exists — the extension asks for nothing until the user shares a tab.
  const granted = await chrome.permissions.request({ origins: ["https://*/*", "http://*/*"] });
  if (!granted) {
    statusElement.textContent = "Permission denied — cannot act in tabs.";
    return;
  }
  const response = await send({ type: "share-active-tab" });
  statusElement.textContent = response?.ok ? "Tab shared." : (response?.error ?? "Failed.");
  await refreshStatus();
});

document.getElementById("revoke").addEventListener("click", async () => {
  await chrome.storage.session.set({ managedTabIds: [] });
  await refreshStatus();
});

void refreshStatus();
