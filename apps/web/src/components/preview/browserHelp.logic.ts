/**
 * What the "the agent needs you" card says (w0138, Misha 16.10): the agent hit
 * a sign-in, a captcha or a 2FA code in its browser and called the person
 * (`requestHelp` → `page.help.reason`). The card names the site and the one
 * thing to do — "Sign in for the agent" — in plain words. Pure, so tested.
 */

export type BrowserHelpKind = "signIn" | "captcha" | "other";

export interface BrowserHelpCopy {
  readonly kind: BrowserHelpKind;
  /** "The agent needs you to sign in to github.com" */
  readonly title: string;
  /** The button that hands the browser to the person. */
  readonly action: string;
  /** While the person is at the browser. */
  readonly activeTitle: string;
  readonly activeHint: string;
}

/** Said on every sign-in card: where the session lives, and that the password does not. */
export const SESSION_STAYS_LINE =
  "The agent keeps this session on its computer; your password isn't stored.";

/** The site's host without "www." ("github.com"); null for a blank page or no URL. */
export function helpSiteHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host || null;
  } catch {
    return null;
  }
}

const SIGN_IN = /\b(sign[\s-]?in|log[\s-]?in|login|password|2fa|two[\s-]factor|code|otp|verify)\b/i;
const CAPTCHA = /\b(captcha|recaptcha|hcaptcha|are you (a )?human|robot)\b/i;

export function browserHelpCopy(input: {
  readonly reason: string;
  readonly url: string | null | undefined;
}): BrowserHelpCopy {
  const host = helpSiteHost(input.url);
  const on = host ? ` on ${host}` : "";
  if (CAPTCHA.test(input.reason)) {
    return {
      kind: "captcha",
      title: `The agent needs you to pass a check${on}`,
      action: "Do it for the agent",
      activeTitle: `You're at the agent's browser${on}`,
      activeHint: "Pass the check in the browser, then hand it back.",
    };
  }
  if (SIGN_IN.test(input.reason)) {
    return {
      kind: "signIn",
      title: `The agent needs you to sign in${host ? ` to ${host}` : ""}`,
      action: "Sign in for the agent",
      activeTitle: `You're signing in for the agent${on}`,
      activeHint: "Type your login, password and code in the browser, then hand it back.",
    };
  }
  return {
    kind: "other",
    title: `The agent needs you${on}`,
    action: "Take control",
    activeTitle: `You're at the agent's browser${on}`,
    activeHint: "Do what it asked, then hand the browser back.",
  };
}
