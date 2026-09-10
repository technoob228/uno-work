/**
 * Pure view-state for the harness install / sign-in rows.
 *
 * The same derivation feeds three surfaces (web onboarding, desktop
 * onboarding, provider settings), so it lives here rather than in any one of
 * them: what a harness row shows is a function of the server's provider
 * snapshot plus whatever setup job the user just started.
 *
 * @module components/harness/harnessSetupState
 */
import {
  INSTALLABLE_PROVIDER_DRIVERS,
  ProviderDriverKind,
  type ProviderAuthDriver,
  type ProviderSetupJobState,
  type ServerProvider,
} from "@t3tools/contracts";

/** Drivers that can be signed in from the app. */
export const AUTHABLE_DRIVERS: ReadonlyArray<ProviderAuthDriver> = ["claudeAgent", "codex"];

export type HarnessStatus =
  /** No snapshot yet — the daemon has not reported providers. */
  | "checking"
  /** Installed and authenticated. */
  | "ready"
  /** Installed, but the CLI has no usable account. */
  | "needsSignIn"
  /** Binary not found on PATH. */
  | "notInstalled"
  /** Installed but the daemon could not verify it, or it is turned off. */
  | "attention";

export function isAuthableDriver(
  driver: ProviderDriverKind,
): driver is ProviderDriverKind & ProviderAuthDriver {
  return (AUTHABLE_DRIVERS as ReadonlyArray<string>).includes(driver);
}

export function isInstallableDriver(driver: ProviderDriverKind): boolean {
  return (INSTALLABLE_PROVIDER_DRIVERS as ReadonlyArray<string>).includes(driver);
}

/**
 * Status of one harness row.
 *
 * `providersLoaded` distinguishes "the daemon has not answered yet" (show a
 * spinner) from "the daemon answered and this harness is not among its
 * providers" (show Not installed).
 */
export function resolveHarnessStatus(input: {
  readonly provider: ServerProvider | undefined;
  readonly providersLoaded: boolean;
}): HarnessStatus {
  const { provider } = input;
  if (!provider) return input.providersLoaded ? "notInstalled" : "checking";
  if (!provider.installed) return "notInstalled";
  if (provider.auth.status === "authenticated") {
    return provider.status === "error" ? "attention" : "ready";
  }
  if (provider.auth.status === "unauthenticated") return "needsSignIn";
  // `unknown` auth on an enabled, ready provider means the probe could not
  // verify an account — for Claude/Codex that is almost always "not signed
  // in", which is the actionable reading.
  if (provider.status === "ready") return "ready";
  return provider.enabled ? "needsSignIn" : "attention";
}

export const HARNESS_STATUS_LABEL: Readonly<Record<HarnessStatus, string>> = {
  checking: "Checking…",
  ready: "Ready",
  needsSignIn: "Needs sign-in",
  notInstalled: "Not installed",
  attention: "Needs attention",
};

/** Which action button (if any) a row offers, given its status. */
export function resolveHarnessAction(input: {
  readonly driver: ProviderDriverKind;
  readonly status: HarnessStatus;
}): "install" | "signIn" | "none" {
  if (input.status === "notInstalled") {
    return isInstallableDriver(input.driver) ? "install" : "none";
  }
  if (input.status === "needsSignIn" || input.status === "attention") {
    return isAuthableDriver(input.driver) ? "signIn" : "none";
  }
  return "none";
}

export interface SetupJobView {
  readonly state: ProviderSetupJobState;
  readonly log: string;
  readonly error?: string | undefined;
}

export const isJobActive = (job: SetupJobView | undefined): boolean =>
  job?.state === "queued" || job?.state === "running";

/**
 * Last meaningful line of a job log, for the one-line progress hint under a
 * spinner. Strips ANSI so npm/uv colour codes do not leak into the DOM.
 */
export function progressLine(log: string): string | undefined {
  // oxlint-disable-next-line no-control-regex
  const plain = log.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  const lines = plain.split(/\r?\n|\r/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line.length > 0) return line;
  }
  return undefined;
}

/** Rows shown in the onboarding harness lists, in presentation order. */
export const HARNESS_ROW_DRIVERS: ReadonlyArray<ProviderDriverKind> = [
  "uno",
  "claudeAgent",
  "codex",
  "opencode",
  "hermes",
  "cursor",
].map((value) => ProviderDriverKind.make(value));

/**
 * Harnesses we intend to support but have no driver for yet. Listed as
 * disabled rows so the roadmap is visible without pretending they work.
 */
export const COMING_SOON_HARNESSES: ReadonlyArray<string> = ["Grok"];
