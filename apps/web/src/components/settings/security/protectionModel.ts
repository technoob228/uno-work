/**
 * Settings → Security, the simple level: the plain logic behind
 * ProtectionSection.tsx — the API shapes (GET /api/v1/security/protection,
 * PUT /api/v1/security/isolation, POST /api/v1/security/emergency-stop), the
 * words for each isolation mode and what a computer ends up with. No React
 * here, so it is unit-tested.
 *
 * Isolation is set for the whole account ("All computers") and can differ for
 * one computer. It is the person's switch only: the routes are account-only,
 * a computer's own token (its agents) can neither read nor loosen it.
 */

export type IsolationMode = "open" | "limited" | "isolated";
/** A computer's own choice: "inherit" = same as all computers. */
export type ComputerIsolation = IsolationMode | "inherit";

export interface ProtectionComputer {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly mode: ComputerIsolation;
}

export interface PrivateNetwork {
  /** At least one device is connected (has its key). */
  readonly set_up: boolean;
  readonly devices: ReadonlyArray<{ readonly name: string; readonly last_seen?: string }>;
  /** The address of a computer inside the private network, e.g. work.uno. */
  readonly address_hint?: string;
}

export interface EmergencyReport {
  readonly id: string;
  readonly reported_at: string;
  readonly stopped: ReadonlyArray<{ readonly id: number; readonly name: string }>;
  readonly note?: string;
  readonly signed_out: boolean;
  /** open = Uno is looking into it; closed = Uno answered (see `answer`). */
  readonly state: "open" | "closed";
  readonly answer?: string;
}

export interface Protection {
  readonly isolation: {
    readonly all: IsolationMode;
    readonly computers: ReadonlyArray<ProtectionComputer>;
    /** Isolated computers can still use Uno AI (models) — on by default. */
    readonly uno_ai_when_isolated: boolean;
    /** What Limited lets out, beyond Uno itself (Advanced lets you add). */
    readonly limited_allow: ReadonlyArray<string>;
  };
  readonly private_network: PrivateNetwork;
  readonly emergency: EmergencyReport | null;
}

export type IsolationBody =
  | { readonly scope: "all"; readonly mode: IsolationMode }
  | { readonly scope: "computer"; readonly box_id: number; readonly mode: ComputerIsolation }
  | { readonly scope: "uno_ai"; readonly on: boolean };

export interface EmergencyStopBody {
  readonly note?: string;
  readonly sign_out: boolean;
}

export const protectionPath = "/api/v1/security/protection";
export const isolationPath = "/api/v1/security/isolation";
export const emergencyStopPath = "/api/v1/security/emergency-stop";

export const MODE_OPTIONS: ReadonlyArray<{
  readonly value: IsolationMode;
  readonly title: string;
  readonly short: string;
  readonly description: string;
}> = [
  {
    value: "open",
    title: "Open",
    short: "Open",
    description: "Your computers use the internet as usual.",
  },
  {
    value: "limited",
    title: "Limited",
    short: "Limited",
    description:
      "Computers reach only Uno, GitHub and app installs. Nothing on the internet can reach them — you still open them in Uno Work.",
  },
  {
    value: "isolated",
    title: "Isolated",
    short: "Isolated",
    description:
      "No internet in or out. You reach your computers and their files only through your private network.",
  },
];

export function modeTitle(mode: IsolationMode): string {
  return MODE_OPTIONS.find((option) => option.value === mode)?.title ?? mode;
}

export function effectiveMode(all: IsolationMode, computer: ComputerIsolation): IsolationMode {
  return computer === "inherit" ? all : computer;
}

/** Computers that differ from "All computers" — shown open on the page. */
export function overrides(protection: Protection): ReadonlyArray<ProtectionComputer> {
  return protection.isolation.computers.filter((computer) => computer.mode !== "inherit");
}

/** Some computer is (or would be) isolated, but no device is in the private network yet. */
export function needsPrivateNetwork(protection: Protection): boolean {
  if (protection.private_network.set_up) return false;
  const { all, computers } = protection.isolation;
  return (
    all === "isolated" ||
    computers.some((computer) => effectiveMode(all, computer.mode) === "isolated")
  );
}

/** What the red button will stop: everything not already stopped or archived. */
export function stoppable(
  computers: ReadonlyArray<ProtectionComputer>,
): ReadonlyArray<ProtectionComputer> {
  return computers.filter(
    (computer) => !["stopped", "archived", "deleted", "suspended"].includes(computer.status),
  );
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
