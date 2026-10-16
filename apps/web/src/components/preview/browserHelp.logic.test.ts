import { describe, expect, it } from "vitest";

import { browserHelpCopy, helpSiteHost, SESSION_STAYS_LINE } from "./browserHelp.logic";

describe("browserHelpCopy", () => {
  it("a sign-in names the site and the one thing to do", () => {
    const copy = browserHelpCopy({
      reason: "Sign in to github.com",
      url: "https://github.com/login?return_to=%2Fgetuno%2Flanding",
    });
    expect(copy.kind).toBe("signIn");
    expect(copy.title).toBe("The agent needs you to sign in to github.com");
    expect(copy.action).toBe("Sign in for the agent");
    expect(copy.activeTitle).toBe("You're signing in for the agent on github.com");
  });

  it("a 2FA code counts as signing in", () => {
    expect(browserHelpCopy({ reason: "GitHub asks for a 2FA code", url: null }).kind).toBe(
      "signIn",
    );
    expect(browserHelpCopy({ reason: "Enter the login code", url: null }).title).toBe(
      "The agent needs you to sign in",
    );
  });

  it("a captcha is its own ask", () => {
    const copy = browserHelpCopy({
      reason: "There's a captcha",
      url: "https://www.example.com/",
    });
    expect(copy.kind).toBe("captcha");
    expect(copy.title).toBe("The agent needs you to pass a check on example.com");
  });

  it("anything else: plain take control", () => {
    const copy = browserHelpCopy({ reason: "Pick the right account", url: "about:blank" });
    expect(copy.kind).toBe("other");
    expect(copy.action).toBe("Take control");
    expect(copy.title).toBe("The agent needs you");
  });

  it("says the password isn't stored", () => {
    expect(SESSION_STAYS_LINE).toContain("your password isn't stored");
  });
});

describe("helpSiteHost", () => {
  it("drops www and survives junk", () => {
    expect(helpSiteHost("https://www.github.com/x")).toBe("github.com");
    expect(helpSiteHost("not a url")).toBeNull();
    expect(helpSiteHost(undefined)).toBeNull();
  });
});
