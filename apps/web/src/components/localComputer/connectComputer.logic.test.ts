import type { MyComputerPairStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  activityLine,
  activityTimeLabel,
  computerStatusLine,
  detectSystem,
  diagnoseInstall,
  disconnectNote,
  LOCAL_OS,
  LOCAL_OS_ORDER,
  pairProgress,
  stepLabel,
  type LocalOs,
} from "./connectComputer.logic";

const URL = "https://app.uno4.work/c/7KQ2-M9XD";
const commands = {
  mac: `curl -fsSL ${URL} | sh`,
  linux: `(curl -fsSL ${URL} || wget -qO- ${URL}) | sh`,
  windows: `irm "${URL}?ps=1" | iex`,
};

const diagnose = (
  text: string,
  options: { step?: string | null; os?: LocalOs; codeUsable?: boolean } = {},
) =>
  diagnoseInstall({
    text,
    step: options.step ?? null,
    os: options.os ?? "windows",
    commands,
    codeUsable: options.codeUsable ?? true,
  });

const status = (patch: Partial<MyComputerPairStatus>): MyComputerPairStatus => ({
  state: "waiting",
  step: null,
  message: null,
  computerId: null,
  ...patch,
});

describe("detectSystem", () => {
  const cases: ReadonlyArray<[string, string, LocalOs, boolean]> = [
    [
      "macOS Chrome",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36",
      "mac",
      false,
    ],
    [
      "Windows 11 Edge",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Edg/130",
      "windows",
      false,
    ],
    [
      "Ubuntu Firefox",
      "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Firefox/131.0",
      "linux",
      false,
    ],
    ["ChromeOS", "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/130", "linux", false],
    [
      "Android, which says Linux",
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130",
      "mac",
      true,
    ],
    [
      "iPhone, which says Mac OS X",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      "mac",
      true,
    ],
    ["nothing to go on", "curl/8.0", "mac", false],
  ];
  for (const [name, userAgent, os, phone] of cases) {
    it(name, () => {
      expect(detectSystem({ userAgent })).toEqual({ os, phone });
    });
  }

  it("takes an iPad that presents itself as a Mac for a tablet", () => {
    const userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15";
    expect(detectSystem({ userAgent, maxTouchPoints: 5 }).phone).toBe(true);
    expect(detectSystem({ userAgent, maxTouchPoints: 0 }).phone).toBe(false);
  });

  it("prefers the browser's own platform hint over a frozen user agent", () => {
    expect(detectSystem({ userAgent: "Mozilla/5.0", uaPlatform: "Windows" }).os).toBe("windows");
    expect(detectSystem({ userAgent: "Mozilla/5.0", uaPlatform: "Linux" }).os).toBe("linux");
  });
});

describe("LOCAL_OS", () => {
  it("has a way to open the terminal for each system", () => {
    for (const os of LOCAL_OS_ORDER) expect(LOCAL_OS[os].howTo.length).toBeGreaterThan(0);
  });

  it("sends Windows to PowerShell, where irm | iex works, on 10 and 11", () => {
    expect(LOCAL_OS.windows.terminal).toBe("PowerShell");
    expect(LOCAL_OS.windows.howTo.join(" ")).toMatch(/Windows 10 or 11/);
    expect(LOCAL_OS.windows.howTo.join(" ")).toMatch(/not Command Prompt/);
  });
});

describe("pairProgress", () => {
  const FUTURE = "2026-10-31T12:15:00Z";
  const now = Date.parse("2026-10-31T12:00:00Z");
  const progress = (
    current: MyComputerPairStatus | null,
    computers: ReadonlyArray<{ id: string; online: boolean }> = [],
    nowMs = now,
  ) => pairProgress({ status: current, computers, expiresAt: FUTURE, nowMs });

  it("waits until the console answers", () => {
    expect(progress(null).kind).toBe("waiting");
    expect(progress(status({})).kind).toBe("waiting");
  });

  it("doesn't call a taken code connected: the helper still has to come online", () => {
    const claimed = status({ state: "claimed", computerId: "7" });
    expect(progress(claimed).kind).toBe("finishing");
    expect(progress(claimed, [{ id: "7", online: false }]).kind).toBe("finishing");
    expect(progress(claimed, [{ id: "7", online: true }])).toEqual({
      kind: "connected",
      computerId: "7",
    });
  });

  it("doesn't take another computer's being online for this one", () => {
    const claimed = status({ state: "claimed", computerId: "7" });
    expect(progress(claimed, [{ id: "8", online: true }]).kind).toBe("finishing");
  });

  it("connects a helper that reported a failure and got through later", () => {
    const failed = status({ state: "failed", step: "connect", computerId: "7" });
    expect(progress(failed, [{ id: "7", online: true }]).kind).toBe("connected");
  });

  it("keeps the code usable after a failure before it was taken", () => {
    expect(progress(status({ state: "failed", step: "download" }))).toMatchObject({
      kind: "failed",
      step: "download",
      codeUsable: true,
    });
  });

  it("marks the code spent once taken or out of time", () => {
    const taken = status({ state: "failed", step: "install", computerId: "7" });
    expect(progress(taken)).toMatchObject({ kind: "failed", codeUsable: false });
    const late = progress(status({ state: "failed", step: "download" }), [], Date.parse(FUTURE));
    expect(late).toMatchObject({ kind: "failed", codeUsable: false });
  });

  it("lets the console decide when a waiting code expires", () => {
    const wrongClock = Date.parse("2027-01-01T00:00:00Z");
    expect(progress(status({}), [], wrongClock).kind).toBe("waiting");
    expect(progress(status({ state: "expired" })).kind).toBe("expired");
  });
});

describe("diagnoseInstall", () => {
  it("offers the PowerShell command when pasted into Command Prompt", () => {
    const fix = diagnose("'irm' is not recognized as an internal or external command,");
    expect(fix.id).toBe("wrong-window");
    expect(fix.command).toBe(`powershell -c "irm '${URL}?ps=1' | iex"`);
    expect(diagnose('"irm" не является внутренней или внешней командой').id).toBe("wrong-window");
  });

  it("doesn't take a PowerShell error for Command Prompt", () => {
    const text = "The term 'Get-FileHash' is not recognized as the name of a cmdlet, function";
    expect(diagnose(text, { step: "checksum" }).id).toBe("execution-policy");
  });

  it("gives a one-window change for the execution policy", () => {
    const fix = diagnose(
      "File C:\\x.ps1 cannot be loaded because running scripts is disabled on this system.",
    );
    expect(fix.id).toBe("execution-policy");
    expect(fix.command).toBe(
      `Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned -Force; ${commands.windows}`,
    );
    expect(diagnose("выполнение сценариев отключено в этой системе").id).toBe("execution-policy");
  });

  it("stops at a policy the organization enforces", () => {
    const fix = diagnose(
      "Windows PowerShell updated your execution policy successfully, but the setting is overridden by a policy defined at a more specific scope.",
    );
    expect(fix).toMatchObject({ id: "organization-policy", next: "stop", command: null });
  });

  it("recognizes each shell saying curl is missing", () => {
    for (const text of [
      "bash: curl: command not found",
      "zsh: command not found: curl",
      "sh: 1: curl: not found",
      "sh: 1: wget: not found",
      "Neither curl nor wget is installed.",
      "bash: curl: команда не найдена",
    ]) {
      expect(diagnose(text, { os: "linux" }).id).toBe("no-curl");
    }
    expect(diagnose("bash: curl: command not found", { os: "linux" }).command).toBe(
      `sudo apt install -y curl && ${commands.linux}`,
    );
  });

  it("doesn't take a 404 from curl for a missing curl", () => {
    const fix = diagnose("curl: (22) The requested URL returned error: 404 Not Found", {
      os: "mac",
    });
    expect(fix.id).not.toBe("no-curl");
  });

  it("doesn't suggest apt outside Linux", () => {
    const fix = diagnose("zsh: command not found: curl", { os: "mac" });
    expect(fix.id).toBe("no-curl");
    expect(fix.command).toBe(commands.mac);
  });

  it("walks through restoring the helper from Windows Security", () => {
    for (const text of [
      "Operation did not complete successfully because the file contains a virus or potentially unwanted software",
      "This script contains malicious content and has been blocked by your antivirus software.",
      "Microsoft Defender removed it",
    ]) {
      const fix = diagnose(text, { step: "start" });
      expect(fix.id).toBe("defender");
      expect(fix.steps[1]).toMatch(/Restore/);
      expect(fix.command).toBe(commands.windows);
    }
  });

  it("stops at Smart App Control: there is nothing to paste", () => {
    const fix = diagnose("An Application Control policy has blocked this file.", { step: "start" });
    expect(fix).toMatchObject({ id: "smart-app-control", next: "stop", command: null });
  });

  it("recognizes a computer without a network, in every wording", () => {
    for (const text of [
      "curl: (6) Could not resolve host: app.uno4.work",
      "curl: (7) Failed to connect to app.uno4.work port 443",
      "curl: (28) Operation timed out",
      "The remote name could not be resolved: 'app.uno4.work'",
      "Unable to connect to the remote server",
      "curl: (60) SSL certificate problem: unable to get local issuer certificate",
      "Could not reach Uno. Check your internet connection and try again.",
      "Не удается соединиться с удаленным сервером",
    ]) {
      expect(diagnose(text).id).toBe("no-network");
    }
    expect(
      diagnose("Could not download the helper. Check your internet connection and try again.", {
        step: "download",
        os: "mac",
      }).command,
    ).toBe(commands.mac);
  });

  it("tells to leave sudo or the administrator window", () => {
    const sudo = diagnose("Do not run this as root or with sudo.", { step: "root", os: "linux" });
    expect(sudo).toMatchObject({ id: "as-admin", title: "Don’t run it with sudo" });
    const admin = diagnose("Do not run this as Administrator.", { step: "root" });
    expect(admin.title).toBe("Don’t run it as administrator");
  });

  it("asks for a new code when the helper says the old one is spent", () => {
    const fix = diagnose(
      "This command has expired or was already used. Get a new one in Uno Work.",
      {
        step: "claim",
      },
    );
    expect(fix).toMatchObject({ id: "code-used", next: "new-code", command: null });
  });

  it("waits for a helper that installed and keeps trying", () => {
    const fix = diagnose(
      "The helper is installed but could not connect to Uno yet. Last problem: dial tcp: i/o timeout",
      {
        step: "connect",
        codeUsable: false,
      },
    );
    expect(fix).toMatchObject({ id: "cant-connect", next: "wait", command: null });
  });

  it("shows the computer's own words where they say what's unsupported", () => {
    const fix = diagnose("This processor is not supported: riscv64.", {
      step: "arch",
      os: "linux",
    });
    expect(fix).toMatchObject({ id: "unsupported", next: "stop", showMessage: true });
  });

  it("offers the command again after a damaged download", () => {
    const fix = diagnose("The downloaded helper is damaged: its checksum does not match.", {
      step: "checksum",
      os: "mac",
    });
    expect(fix).toMatchObject({ id: "damaged", next: "run", command: commands.mac });
  });

  it("says when Uno itself refused to link the computer", () => {
    const fix = diagnose("Too many attempts. Wait a minute and try again.", {
      step: "claim",
      os: "mac",
    });
    expect(fix).toMatchObject({ id: "not-linked", next: "run", showMessage: true });
  });

  it("is honest about what it doesn't recognize", () => {
    const fix = diagnose("Something nobody has seen before", { os: "mac" });
    expect(fix).toMatchObject({ id: "unknown", next: "run", showMessage: true });
    expect(fix.title).toBe("Uno can’t tell what went wrong");
    expect(fix.command).toBe(commands.mac);
  });

  it("swaps the command for a new code once this one is spent", () => {
    const fix = diagnose("curl: (6) Could not resolve host", { codeUsable: false });
    expect(fix).toMatchObject({ id: "no-network", next: "new-code", command: null });
  });

  it("never returns the long dash or a promise", () => {
    const texts = [
      "virus",
      "is not recognized as an internal or external command",
      "group policy",
      "running scripts is disabled",
      "curl: not found",
      "as root",
      "already used",
      "timed out",
      "smart app control",
      "unknown",
    ];
    for (const text of texts) {
      const fix = diagnose(text);
      const words = [fix.title, fix.body, ...fix.steps].join(" ");
      expect(words).not.toContain("—");
      expect(words).not.toMatch(/24\/7|100\s*%|guarantee|always/i);
    }
  });
});

describe("stepLabel", () => {
  it("says the known steps in plain words", () => {
    expect(stepLabel("download")).toBe("Downloading the helper");
    expect(stepLabel("connect")).toBe("Connecting to Uno");
  });

  it("keeps a step it doesn't know as clipped text", () => {
    expect(stepLabel("mystery")).toBe("mystery");
    expect(stepLabel("x".repeat(500))).toHaveLength(60);
  });
});

describe("computerStatusLine", () => {
  const now = Date.parse("2026-10-31T12:00:00Z");

  it("says Connected while online", () => {
    expect(computerStatusLine({ online: true, lastSeenAt: null }, now)).toBe("Connected");
  });

  it("says when an offline computer was last seen", () => {
    expect(computerStatusLine({ online: false, lastSeenAt: "2026-10-31T10:00:00Z" }, now)).toBe(
      "Offline · last seen 2h ago",
    );
    expect(computerStatusLine({ online: false, lastSeenAt: "2026-10-31T11:59:59Z" }, now)).toBe(
      "Offline · last seen just now",
    );
  });

  it("doesn't make up a time it doesn't have", () => {
    expect(computerStatusLine({ online: false, lastSeenAt: null }, now)).toBe("Offline");
    expect(computerStatusLine({ online: false, lastSeenAt: "soon" }, now)).toBe("Offline");
  });
});

describe("disconnectNote", () => {
  it("says when the helper leaves", () => {
    expect(disconnectNote({ online: true })).toMatch(/removes itself from this computer/);
    expect(disconnectNote({ online: false })).toMatch(/next online/);
  });
});

const clock = () => "11:40";

describe("the journal", () => {
  it("reads as a sentence", () => {
    expect(activityLine({ kind: "run", summary: "ls -t ~/Downloads" })).toBe(
      "Ran ls -t ~/Downloads",
    );
    expect(activityLine({ kind: "write", summary: "~/a.txt" })).toBe("Wrote ~/a.txt");
  });

  it("shows the time for today and the date for earlier", () => {
    const now = new Date(2026, 9, 31, 12, 0).getTime();
    expect(activityTimeLabel(new Date(2026, 9, 31, 11, 40).toISOString(), now, clock)).toBe(
      "11:40",
    );
    expect(activityTimeLabel(new Date(2026, 9, 28, 11, 40).toISOString(), now, clock)).toBe(
      "Oct 28",
    );
    expect(activityTimeLabel("nonsense", now, clock)).toBe("");
  });
});
