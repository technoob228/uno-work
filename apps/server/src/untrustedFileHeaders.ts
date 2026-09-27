/**
 * Headers for files whose bytes come from users, agents or cloned repos
 * (chat attachments, project favicons) but are served from the app's own
 * origin. An SVG or HTML file opened directly (new tab, "open image") would
 * otherwise run its scripts with the app's cookies and API access.
 *
 * - `sandbox` + `default-src 'none'`: no scripts, no requests, opaque origin
 *   even when the file is navigated to as a document. `<img src>` rendering
 *   is unaffected (CSP of the image response doesn't apply there).
 * - `nosniff`: the browser trusts our Content-Type instead of guessing HTML.
 */
export const UNTRUSTED_FILE_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

export const UNTRUSTED_FILE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": UNTRUSTED_FILE_CSP,
  "X-Content-Type-Options": "nosniff",
};
