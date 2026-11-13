/**
 * Computers lifecycle: the one "Add computer" window (which step is open), the
 * open Remove / Delete confirmation, the desktop app's "Make this Mac one of
 * your computers?" card, and where agents run for this Mac (desktop only).
 * One store for the whole app — the window is opened from Home, the computers
 * menu, Settings, Connectors and My Uno.
 *
 * What is true about the computers (connected, online, what each is for) comes
 * from the cloud computer (`useOwnComputers`); this keeps only the window.
 */
import type { ComputerPurpose, MyComputerPairing } from "@t3tools/contracts";
import { create } from "zustand";

import type { LocalOs } from "../components/localComputer/connectComputer.logic";

export type { ComputerPurpose };
export type AddStep = "choose" | "own" | "purpose" | "bring" | "done";

/** A Remove / Delete / Stop all confirmation, open over the page (it outlives the menu it came from). */
export type LifecycleConfirm =
  | {
      readonly kind: "remove";
      readonly name: string;
      readonly computerId: string;
    }
  | {
      readonly kind: "delete";
      readonly name: string;
      readonly boxId: number;
      readonly environmentId: string | null;
      readonly lastOnPlan: boolean;
    }
  /** "Stop all agents on my computer" (trust tiers, 13.11). */
  | { readonly kind: "stop-all" };

export interface BroughtWork {
  readonly chats: number;
  readonly projects: ReadonlyArray<string>;
  readonly keys: number;
}

/** Desktop app, Settings → This computer: where this Mac's chats run (SPEC variant b). */
export type WhereAgentsRun = "cloud" | "here";

interface LifecycleState {
  /** The "Add computer" window. */
  readonly addOpen: boolean;
  readonly step: AddStep;
  /** The cloud path: today's flow (plan, region) in AddEnvModal. */
  readonly cloudOpen: boolean;
  /** Dev Mode's old ways in (SSH, address + code). */
  readonly customOpen: boolean;
  readonly os: LocalOs;
  /** Mac / Windows: "or paste one command" was opened. */
  readonly showCommand: boolean;
  readonly pairing: MyComputerPairing | null;
  readonly pairError: string | null;
  /** The computer that just connected (a `MyComputer` id). */
  readonly computerId: string | null;
  readonly purposeChosen: ComputerPurpose | null;
  /** The desktop app set this Mac up itself: "What is it for?" opens with this picked. */
  readonly preselect: ComputerPurpose | null;
  /** The desktop app's "Make this Mac one of your computers?": hidden after an answer. */
  readonly thisMacPrompt: "ask" | "installing" | "done";
  readonly brought: BroughtWork | null;
  readonly whereAgentsRun: WhereAgentsRun;
  readonly confirm: LifecycleConfirm | null;
}

const closedWindow = {
  addOpen: false,
  step: "choose",
  showCommand: false,
  pairing: null,
  pairError: null,
  computerId: null,
  purposeChosen: null,
  preselect: null,
  brought: null,
} as const;

const THIS_MAC_PROMPT_KEY = "uno:this-mac-prompt";
const WHERE_AGENTS_RUN_KEY = "uno:where-agents-run";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // this page only
  }
}

export const useLifecycle = create<LifecycleState>(() => ({
  ...closedWindow,
  cloudOpen: false,
  customOpen: false,
  os: "mac",
  confirm: null,
  thisMacPrompt: read(THIS_MAC_PROMPT_KEY) === "done" ? "done" : "ask",
  whereAgentsRun: read(WHERE_AGENTS_RUN_KEY) === "here" ? "here" : "cloud",
}));

export const lifecycle = {
  openAdd: () => useLifecycle.setState({ ...closedWindow, addOpen: true }),
  /** Straight to "Your own computer" (Connectors' "Connect computer"). */
  openOwn: (os?: LocalOs) =>
    useLifecycle.setState((state) => ({
      ...closedWindow,
      addOpen: true,
      step: "own",
      os: os ?? state.os,
    })),
  close: () => useLifecycle.setState(closedWindow),
  go: (step: AddStep) => useLifecycle.setState({ step }),
  openCloud: () => useLifecycle.setState({ ...closedWindow, cloudOpen: true }),
  setCloudOpen: (cloudOpen: boolean) => useLifecycle.setState({ cloudOpen }),
  openCustom: () => useLifecycle.setState({ ...closedWindow, customOpen: true }),
  setCustomOpen: (customOpen: boolean) => useLifecycle.setState({ customOpen }),
  setOs: (os: LocalOs) => useLifecycle.setState({ os }),
  showCommand: () => useLifecycle.setState({ showCommand: true }),
  paired: (pairing: MyComputerPairing) => useLifecycle.setState({ pairing, pairError: null }),
  pairFailed: (pairError: string) => useLifecycle.setState({ pairError }),
  /** A code expired or failed: the next one is asked for. */
  repair: () => useLifecycle.setState({ pairing: null, pairError: null }),
  connected: (computerId: string) => useLifecycle.setState({ computerId, step: "purpose" }),
  chosePurpose: (purpose: ComputerPurpose) =>
    useLifecycle.setState({ purposeChosen: purpose, step: "bring" }),
  brought: (brought: BroughtWork | null) => useLifecycle.setState({ brought, step: "done" }),
  confirm: (confirm: LifecycleConfirm | null) => useLifecycle.setState({ confirm }),
  /** The desktop app installed the helper on this Mac: straight to "What is it for?", Full picked. */
  thisMacConnected: (computerId: string) => {
    write(THIS_MAC_PROMPT_KEY, "done");
    useLifecycle.setState({
      ...closedWindow,
      addOpen: true,
      step: "purpose",
      computerId,
      preselect: "full",
      thisMacPrompt: "done",
    });
  },
  setThisMacPrompt: (thisMacPrompt: "ask" | "installing" | "done") => {
    write(THIS_MAC_PROMPT_KEY, thisMacPrompt === "done" ? "done" : null);
    useLifecycle.setState({ thisMacPrompt });
  },
  setWhereAgentsRun: (whereAgentsRun: WhereAgentsRun) => {
    write(WHERE_AGENTS_RUN_KEY, whereAgentsRun === "here" ? "here" : null);
    useLifecycle.setState({ whereAgentsRun });
  },
};
