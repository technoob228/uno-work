/**
 * Computers lifecycle: the one "Add computer" window (which step is open), what
 * each of the person's own computers is for (a tool for agents, or a full
 * computer), and where agents run on it (the secondary path). One store for
 * the whole app, like "Connect my computer" — the window is opened from
 * Home, the computers menu, Settings and My Uno.
 *
 * What's true about the computers (connected, online) still comes from the
 * daemon (`useMyComputers`) and the saved environments; this keeps only the
 * person's choices and the window's progress.
 */
import type { MyComputerPairing } from "@t3tools/contracts";
import { create } from "zustand";

import type { LocalOs } from "../components/localComputer/connectComputer.logic";
import { INITIAL_FALLBACK, saveFallback, type FallbackVariant } from "./flag";

export type ComputerPurpose = "tool" | "full";
export type AddStep = "choose" | "own" | "purpose" | "bring" | "done";

/** A Remove / Delete confirmation, open over the page (it outlives the menu it came from). */
export type LifecycleConfirm =
  | {
      readonly kind: "remove";
      readonly name: string;
      readonly computerId: string | null;
      readonly environmentId: string | null;
    }
  | {
      readonly kind: "delete";
      readonly name: string;
      readonly boxId: number;
      readonly environmentId: string | null;
      readonly lastOnPlan: boolean;
    };

export interface BroughtWork {
  readonly chats: number;
  readonly projects: ReadonlyArray<string>;
  readonly keys: number;
}

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
  /** By `MyComputer` id. A computer without an entry is a tool for agents. */
  readonly purposes: Readonly<Record<string, ComputerPurpose>>;
  /** A full computer shows up as a computer of its own (its environment id). */
  readonly environmentOf: Readonly<Record<string, string>>;
  /** The secondary path: agents run on the computer itself (by `MyComputer` id). */
  readonly runsHere: Readonly<Record<string, boolean>>;
  readonly fallback: FallbackVariant;
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

export const useLifecycle = create<LifecycleState>(() => ({
  ...closedWindow,
  cloudOpen: false,
  customOpen: false,
  os: "mac",
  purposes: {},
  environmentOf: {},
  runsHere: {},
  fallback: INITIAL_FALLBACK,
  confirm: null,
  thisMacPrompt: readThisMacPrompt(),
}));

const THIS_MAC_PROMPT_KEY = "uno:this-mac-prompt";

function readThisMacPrompt(): "ask" | "done" {
  try {
    return localStorage.getItem(THIS_MAC_PROMPT_KEY) === "done" ? "done" : "ask";
  } catch {
    return "ask";
  }
}

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
  connected: (computerId: string) => useLifecycle.setState({ computerId, step: "purpose" }),
  setPurpose: (computerId: string, purpose: ComputerPurpose) =>
    useLifecycle.setState((state) => ({
      purposes: { ...state.purposes, [computerId]: purpose },
    })),
  chosePurpose: (purpose: ComputerPurpose) =>
    useLifecycle.setState({ purposeChosen: purpose, step: "bring" }),
  linkEnvironment: (computerId: string, environmentId: string | null) =>
    useLifecycle.setState((state) => {
      const next = { ...state.environmentOf };
      if (environmentId === null) delete next[computerId];
      else next[computerId] = environmentId;
      return { environmentOf: next };
    }),
  brought: (brought: BroughtWork | null) => useLifecycle.setState({ brought, step: "done" }),
  setRunsHere: (computerId: string, on: boolean) =>
    useLifecycle.setState((state) => ({ runsHere: { ...state.runsHere, [computerId]: on } })),
  forget: (computerId: string) =>
    useLifecycle.setState((state) => {
      const purposes = { ...state.purposes };
      const environmentOf = { ...state.environmentOf };
      const runsHere = { ...state.runsHere };
      delete purposes[computerId];
      delete environmentOf[computerId];
      delete runsHere[computerId];
      return { purposes, environmentOf, runsHere };
    }),
  confirm: (confirm: LifecycleConfirm | null) => useLifecycle.setState({ confirm }),
  /** The desktop app installed the helper on this Mac: straight to "What is it for?", Full picked. */
  thisMacConnected: (computerId: string) =>
    useLifecycle.setState({
      ...closedWindow,
      addOpen: true,
      step: "purpose",
      computerId,
      preselect: "full",
      thisMacPrompt: "done",
    }),
  setThisMacPrompt: (thisMacPrompt: "ask" | "installing" | "done") => {
    try {
      if (thisMacPrompt === "done") localStorage.setItem(THIS_MAC_PROMPT_KEY, "done");
      else localStorage.removeItem(THIS_MAC_PROMPT_KEY);
    } catch {
      // this page only
    }
    useLifecycle.setState({ thisMacPrompt });
  },
  setFallback: (fallback: FallbackVariant) => {
    saveFallback(fallback);
    useLifecycle.setState({ fallback });
  },
};

/** The `MyComputer` id behind a full computer's environment (null: not one of the person's own). */
export function computerOfEnvironment(
  environmentOf: Readonly<Record<string, string>>,
  environmentId: string | null,
): string | null {
  if (environmentId === null) return null;
  for (const [computerId, env] of Object.entries(environmentOf)) {
    if (env === environmentId) return computerId;
  }
  return null;
}
