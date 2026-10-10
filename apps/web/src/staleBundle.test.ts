import { describe, expect, it, vi } from "vitest";

import {
  compareWorkVersions,
  handlePreloadError,
  PRELOAD_RELOAD_WINDOW_MS,
  readUiFromOrigin,
  resolveStaleBundleNotice,
  switchReloadUrl,
  workMachineOpenUrl,
  type StaleBundlePage,
} from "./staleBundle";

const browserOnWork: StaleBundlePage = {
  onWorkProxyHost: true,
  isElectron: false,
  isLite: false,
  bundleVersion: "0.0.108",
  uiFromOrigin: false,
};

describe("workMachineOpenUrl", () => {
  it("names the computer and keeps only a safe relative next", () => {
    expect(workMachineOpenUrl(2385)).toBe("/_work/open?box=2385");
    expect(workMachineOpenUrl(2385, "/computer")).toBe("/_work/open?box=2385&next=%2Fcomputer");
    expect(workMachineOpenUrl(2385, "//evil.example")).toBe("/_work/open?box=2385");
    expect(workMachineOpenUrl(2385, "https://evil.example")).toBe("/_work/open?box=2385");
  });
});

describe("compareWorkVersions", () => {
  it("compares numerically, ignoring a v prefix", () => {
    expect(compareWorkVersions("0.0.108", "0.0.116")).toBe(-1);
    expect(compareWorkVersions("0.0.116", "0.0.108")).toBe(1);
    expect(compareWorkVersions("v0.0.116", "0.0.116")).toBe(0);
    expect(compareWorkVersions("0.0.99", "0.0.100")).toBe(-1);
  });
});

describe("switchReloadUrl", () => {
  it("loads another computer's own interface when its version differs (0.0.108 page → 0.0.116 computer)", () => {
    expect(
      switchReloadUrl(
        browserOnWork,
        { isPrimary: false, unoBoxId: 2385, serverVersion: "0.0.116" },
        "/computer",
      ),
    ).toBe("/_work/open?box=2385&next=%2Fcomputer");
  });

  it("loads it too when the version is not known yet (not connected, asleep)", () => {
    expect(
      switchReloadUrl(browserOnWork, { isPrimary: false, unoBoxId: 2385, serverVersion: null }),
    ).toBe("/_work/open?box=2385");
  });

  it("switches in place when the versions match", () => {
    expect(
      switchReloadUrl(browserOnWork, {
        isPrimary: false,
        unoBoxId: 2385,
        serverVersion: "0.0.108",
      }),
    ).toBeNull();
  });

  it("never reloads for the computer that served the page, a non-Uno machine, desktop, lite or a direct address", () => {
    const other = { isPrimary: false, unoBoxId: 2385, serverVersion: "0.0.116" } as const;
    expect(switchReloadUrl(browserOnWork, { ...other, isPrimary: true })).toBeNull();
    expect(switchReloadUrl(browserOnWork, { ...other, unoBoxId: null })).toBeNull();
    expect(switchReloadUrl({ ...browserOnWork, isElectron: true }, other)).toBeNull();
    expect(switchReloadUrl({ ...browserOnWork, isLite: true }, other)).toBeNull();
    expect(switchReloadUrl({ ...browserOnWork, onWorkProxyHost: false }, other)).toBeNull();
  });
});

describe("resolveStaleBundleNotice", () => {
  it("the computer that served the page updated itself → a new version, plain reload", () => {
    const notice = resolveStaleBundleNotice(browserOnWork, {
      environmentId: "env-395",
      isPrimary: true,
      unoBoxId: 395,
      serverVersion: "0.0.117",
    });
    expect(notice).toMatchObject({
      kind: "newer",
      clientVersion: "0.0.108",
      serverVersion: "0.0.117",
      action: { kind: "reload" },
      key: "env-395:0.0.108:0.0.117",
    });
  });

  it("works the same on a computer's direct address (reload serves the updated bundle)", () => {
    expect(
      resolveStaleBundleNotice(
        { ...browserOnWork, onWorkProxyHost: false },
        { environmentId: "e", isPrimary: true, unoBoxId: 395, serverVersion: "0.0.117" },
      )?.action,
    ).toEqual({ kind: "reload" });
  });

  it("another Uno computer on a Work address → its own address; older computer says so", () => {
    const notice = resolveStaleBundleNotice(
      { ...browserOnWork, bundleVersion: "0.0.117" },
      { environmentId: "env-2507", isPrimary: false, unoBoxId: 2507, serverVersion: "0.0.112" },
    );
    expect(notice).toMatchObject({
      kind: "older",
      action: { kind: "open", url: "/_work/open?box=2507" },
    });
  });

  it("stays quiet where a reload would not help or nothing differs", () => {
    const other = {
      environmentId: "e",
      isPrimary: false,
      unoBoxId: 2385,
      serverVersion: "0.0.116",
    } as const;
    // Direct address: a reload brings back this same machine's bundle.
    expect(
      resolveStaleBundleNotice({ ...browserOnWork, onWorkProxyHost: false }, other),
    ).toBeNull();
    expect(resolveStaleBundleNotice({ ...browserOnWork, isElectron: true }, other)).toBeNull();
    expect(resolveStaleBundleNotice({ ...browserOnWork, isLite: true }, other)).toBeNull();
    expect(resolveStaleBundleNotice(browserOnWork, { ...other, serverVersion: null })).toBeNull();
    expect(
      resolveStaleBundleNotice(browserOnWork, { ...other, serverVersion: "0.0.108" }),
    ).toBeNull();
    // Dev build without a version.
    expect(
      resolveStaleBundleNotice({ ...browserOnWork, bundleVersion: "0.0.0" }, other),
    ).toBeNull();
  });
});

describe('one window: <meta name="uno-ui" content="origin">', () => {
  const origin: StaleBundlePage = {
    ...browserOnWork,
    bundleVersion: "0.0.119",
    uiFromOrigin: true,
  };

  it("reads the meta our address puts into index.html", () => {
    const doc = (content: string | null) => ({
      querySelector: (selector: string) =>
        selector === 'meta[name="uno-ui"]' && content !== null
          ? ({ getAttribute: () => content } as unknown as Element)
          : null,
    });
    expect(readUiFromOrigin(doc("origin"))).toBe(true);
    expect(readUiFromOrigin(doc(" Origin "))).toBe(true);
    expect(readUiFromOrigin(doc("machine"))).toBe(false);
    expect(readUiFromOrigin(doc(null))).toBe(false);
    expect(readUiFromOrigin(null)).toBe(false);
  });

  it("switches every computer in place — never loads a computer's own interface", () => {
    expect(
      switchReloadUrl(origin, { isPrimary: false, unoBoxId: 2385, serverVersion: "0.0.116" }),
    ).toBeNull();
    expect(
      switchReloadUrl(
        origin,
        { isPrimary: false, unoBoxId: 2385, serverVersion: null },
        "/computer",
      ),
    ).toBeNull();
  });

  it("an older computer that can update itself (0.0.113+) → Update calls self-update", () => {
    const notice = resolveStaleBundleNotice(origin, {
      environmentId: "env-2385",
      isPrimary: false,
      unoBoxId: 2385,
      serverVersion: "0.0.116",
      supportsSelfUpdate: true,
    });
    expect(notice).toMatchObject({
      kind: "older",
      serverVersion: "0.0.116",
      action: { kind: "self-update" },
    });
  });

  it("the same for the computer behind this address (it no longer serves the interface)", () => {
    expect(
      resolveStaleBundleNotice(origin, {
        environmentId: "env-395",
        isPrimary: true,
        unoBoxId: 395,
        serverVersion: "0.0.114",
        supportsSelfUpdate: true,
      })?.action,
    ).toEqual({ kind: "self-update" });
  });

  it("an older computer before self-update → its page in the console", () => {
    expect(
      resolveStaleBundleNotice(origin, {
        environmentId: "env-74",
        isPrimary: false,
        unoBoxId: 74,
        serverVersion: "0.0.108",
        supportsSelfUpdate: false,
      })?.action,
    ).toEqual({ kind: "console", url: "https://console.uno.place/boxes/74" });
  });

  it("an older machine that is not an Uno computer and can't update itself → nothing to offer", () => {
    expect(
      resolveStaleBundleNotice(origin, {
        environmentId: "env-laptop",
        isPrimary: false,
        unoBoxId: null,
        serverVersion: "0.0.108",
      }),
    ).toBeNull();
  });

  it("a newer computer (canary) → a plain Reload", () => {
    expect(
      resolveStaleBundleNotice(origin, {
        environmentId: "env-2534",
        isPrimary: false,
        unoBoxId: 2534,
        serverVersion: "0.0.120",
        supportsSelfUpdate: true,
      }),
    ).toMatchObject({ kind: "newer", action: { kind: "reload" } });
  });

  it("same version or unknown → quiet", () => {
    const base = { environmentId: "e", isPrimary: false, unoBoxId: 1 } as const;
    expect(resolveStaleBundleNotice(origin, { ...base, serverVersion: "0.0.119" })).toBeNull();
    expect(resolveStaleBundleNotice(origin, { ...base, serverVersion: null })).toBeNull();
  });
});

describe("handlePreloadError", () => {
  function deps(now: number, last: number) {
    return {
      now: () => now,
      readLastReloadAt: () => last,
      writeLastReloadAt: vi.fn<(at: number) => void>(),
      reload: vi.fn<() => void>(),
    };
  }

  it("reloads once when a chunk of the previous bundle is gone", () => {
    const d = deps(1_000_000, 0);
    expect(handlePreloadError(d)).toBe("reload");
    expect(d.writeLastReloadAt).toHaveBeenCalledWith(1_000_000);
    expect(d.reload).toHaveBeenCalledOnce();
  });

  it("does not loop: a second failure within the window is left to the error screen", () => {
    const d = deps(1_000_000, 1_000_000 - PRELOAD_RELOAD_WINDOW_MS + 1);
    expect(handlePreloadError(d)).toBe("skip");
    expect(d.reload).not.toHaveBeenCalled();
  });

  it("reloads again after the window", () => {
    const d = deps(1_000_000, 1_000_000 - PRELOAD_RELOAD_WINDOW_MS - 1);
    expect(handlePreloadError(d)).toBe("reload");
  });
});
