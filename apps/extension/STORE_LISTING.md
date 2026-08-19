# Chrome Web Store — материалы подачи

Скопировать в форму как есть. Видимость — **Unlisted**.

## Item name

Uno Work Companion

## Short description (≤132 chars)

Lets the Uno Work app act in tabs you share with it — clicking, typing and navigating in sessions you are already signed into.

## Detailed description

Uno Work is a coding and automation workspace that runs on your own machine — an Uno box or a VM you own. This extension is the bridge between that workspace and this browser.

When you ask the assistant to do something on the web, it can act directly in your browser instead of a separate headless one. That means it works inside sessions you are already signed into: no passwords to share, no accounts to re-authenticate, no copies of your cookies anywhere.

**What it can do**
- open a page and report its URL, title and load state
- navigate, reload, go back and forward
- click elements, type text, press keys
- capture a screenshot of the visible area on request

**What it cannot do**
- act in tabs you have not shared — it only touches tabs it opened itself and tabs you explicitly share from the popup
- run arbitrary or remotely supplied code — the command set is fixed and every in-page action ships with the extension
- collect data — there is no analytics, no telemetry and no server of its own. Results go only to the Uno Work application you are signed into.

**How to use it**
1. Install the extension.
2. Open Uno Work in this browser — it detects the extension automatically.
3. Ask the assistant to do something on the web. To use a page you already have open, click "Share the current tab" in the extension popup.

Website access is an optional permission, requested the first time you share a tab — installing the extension grants access to no site.

Requires an Uno Work workspace: https://uno4.dev

## Single purpose

Execute a fixed set of browser actions, requested by the user through the Uno Work application, in browser tabs the user has explicitly shared with the extension.

## Permission justifications

**tabs** — The assistant needs to open a page on the user's request and report that tab's URL, title and load state back to the application so the user can see what happened. Used only for tabs the extension opened or the user shared.

**scripting** — Performing the user's requested actions inside a shared tab: clicking an element, typing into a field, pressing a key. All injected code is statically declared in the extension package; nothing is fetched or evaluated at runtime.

**storage** — Storing the session-scoped list of tabs the user has shared, so the extension knows where it is allowed to act. Cleared when the browser session ends.

**Optional host permissions (http/https)** — Required to act in the sites the user shares. Declared as optional and requested only when the user clicks "Share the current tab", so installation grants access to nothing.

**Remote code** — None. The extension does not load or execute code from any remote source, and does not expose an "evaluate arbitrary script" command.

## Data usage disclosures

- Does the extension collect personally identifiable information? **No**
- Health information? **No**
- Financial and payment information? **No**
- Authentication information? **No**
- Personal communications? **No**
- Location? **No**
- Web history? **No** — the URL and title of a shared tab are returned to the user's own application and are not collected by us.
- User activity? **No**
- Website content? **No** — screenshots of a shared tab are returned to the user's own application on request and are not collected by us.

Certifications: does not sell or transfer user data to third parties; does not use or transfer data for purposes unrelated to the item's single purpose; does not use or transfer data to determine creditworthiness or for lending.

## Privacy policy URL

https://uno4.dev/privacy-extension

## Screenshots to capture (1280×800)

1. Uno Work with the assistant driving a page in a shared tab, side by side.
2. The extension popup with "Share the current tab" and the shared-tabs count.
3. The permission prompt shown when sharing the first tab.

## Support / homepage

https://uno4.dev · hello@uno4.dev
