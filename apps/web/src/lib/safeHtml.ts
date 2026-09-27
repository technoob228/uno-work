/**
 * HTML from files (a .docx converted by mammoth or laid out by docx-preview)
 * is untrusted: a document can carry `javascript:` links, event handlers or
 * `<script>`. Anything rendered into the app's own DOM (not a sandboxed
 * iframe) goes through here first.
 *
 * - `sanitizeDocumentHtml` — for `dangerouslySetInnerHTML`: DOMPurify with
 *   no scripts/forms/embeds, no `on*` handlers, links limited to
 *   http(s)/mailto/tel/#anchor, `data:` only for raster images.
 * - `hardenLinks` — for DOM a library already built: rewrites every `<a>`
 *   the same way (unsafe href dropped, external ones open in a new window,
 *   which Electron hands to the system browser).
 */
import DOMPurify from "dompurify";

const SAFE_LINK_PROTOCOL = /^(?:https?|mailto|tel):/i;
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif);base64,/i;
const HAS_PROTOCOL = /^[a-z][a-z0-9+.-]*:/i;

/** Whether `href` may stay on a link in rendered document HTML. */
export function isSafeLinkHref(href: string): boolean {
  // Browsers ignore control chars and whitespace inside the scheme
  // ("java\tscript:"), so judge the value without them.
  // eslint-disable-next-line no-control-regex
  const value = href.replace(/[\u0000- \u007f-\u009f]/g, "");
  if (value === "") return false;
  if (value.startsWith("#")) return true;
  if (SAFE_LINK_PROTOCOL.test(value)) return true;
  // Relative links have no meaning inside a rendered document; drop them
  // rather than let them navigate the app.
  return false;
}

/** Whether `src` may stay on an image in rendered document HTML. */
export function isSafeImageSrc(src: string): boolean {
  const value = src.trim();
  return SAFE_DATA_IMAGE.test(value) || /^https?:/i.test(value) || /^blob:/i.test(value);
}

function hardenAnchor(anchor: HTMLAnchorElement): void {
  const href = anchor.getAttribute("href");
  if (href === null) return;
  if (!isSafeLinkHref(href)) {
    anchor.removeAttribute("href");
    return;
  }
  if (!href.trim().startsWith("#") && HAS_PROTOCOL.test(href.trim())) {
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noopener noreferrer");
  }
}

let hooksInstalled = false;
function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node instanceof HTMLAnchorElement) hardenAnchor(node);
    if (node instanceof HTMLImageElement) {
      const src = node.getAttribute("src");
      if (src !== null && !isSafeImageSrc(src)) node.removeAttribute("src");
      node.removeAttribute("srcset");
    }
  });
}

/** Sanitize untrusted document HTML for `dangerouslySetInnerHTML`. */
export function sanitizeDocumentHtml(html: string): string {
  installHooks();
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      "script",
      "style",
      "iframe",
      "frame",
      "frameset",
      "object",
      "embed",
      "form",
      "input",
      "button",
      "textarea",
      "select",
      "option",
      "link",
      "meta",
      "base",
      "svg",
      "math",
    ],
    FORBID_ATTR: ["style", "srcset", "action", "formaction", "xlink:href"],
    ALLOW_DATA_ATTR: false,
    // Lets `data:image/...` through to the hook above, which keeps only
    // raster images; every other data: URL is dropped there.
    ADD_DATA_URI_TAGS: ["img"],
  });
}

/** Make every link under `root` safe (for DOM built by a library). */
export function hardenLinks(root: ParentNode): void {
  root.querySelectorAll("a").forEach(hardenAnchor);
  root.querySelectorAll("[href]").forEach((el) => {
    if (el instanceof HTMLAnchorElement) return;
    const href = el.getAttribute("href");
    if (href !== null && !isSafeLinkHref(href)) el.removeAttribute("href");
  });
}
