/**
 * «Open» an App Store app already signed in with the Uno account. The daemon
 * asks the console for a one-time link at the moment of the click; the link
 * signs this browser in to Uno for this computer's apps and lands in the app,
 * which signs in without asking for a password.
 *
 * A browser blocks tabs opened after an `await`, so the tab opens right away,
 * empty, and gets its address when the link arrives. The desktop app hands
 * every window.open to the system browser instead (and ignores about:blank),
 * so there the link is opened once it's known. No link (older console, app not
 * ready) → the app's plain address: it asks for its own sign-in, as before.
 */
import { isElectron } from "~/env";

export async function openAppSignedIn(
  getLink: () => Promise<{ readonly url: string }>,
  fallbackUrl: string | null,
): Promise<void> {
  const tab = isElectron ? null : window.open("", "_blank");
  if (tab) {
    try {
      tab.opener = null;
      tab.document.title = "Opening…";
    } catch {
      // Cross-origin by now — nothing to tidy.
    }
  }
  let url = fallbackUrl;
  try {
    url = (await getLink()).url;
  } catch {
    // The app's own address still works, with its own sign-in.
  }
  if (!url || !/^https?:\/\//.test(url)) {
    tab?.close();
    return;
  }
  if (tab) tab.location.replace(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}
