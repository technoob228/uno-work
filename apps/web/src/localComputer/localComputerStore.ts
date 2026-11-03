/**
 * "Connect my computer": which screen is open and the pairing in progress. One
 * dialog for the whole app, opened from the computer menu and from Connectors,
 * so this lives outside any of them. What's true about the computers comes from
 * the daemon (`useMyComputers.ts`), not from here.
 */
import type { MyComputerPairing } from "@t3tools/contracts";
import { create } from "zustand";

import { COMPUTERS_LIFECYCLE } from "../computersLifecycle/flag";
import { lifecycle } from "../computersLifecycle/store";

import {
  detectSystem,
  type InstallFix,
  type LocalOs,
} from "../components/localComputer/connectComputer.logic";

export type ConnectStep = "warning" | "command" | "stuck" | "fix" | "connected";

interface LocalComputerState {
  readonly dialog: "connect" | "manage" | "import" | null;
  readonly step: ConnectStep;
  readonly os: LocalOs;
  /** A phone or tablet: the command has to run on another computer. */
  readonly phone: boolean;
  readonly pairing: MyComputerPairing | null;
  readonly requesting: boolean;
  readonly pairError: string | null;
  /** The person copied the command, so they may need the way out. */
  readonly copied: boolean;
  /** The next step for what the person pasted from their terminal. */
  readonly fix: InstallFix | null;
  readonly connectedId: string | null;
  readonly manageId: string | null;
}

const closed = {
  dialog: null,
  step: "warning",
  pairing: null,
  requesting: false,
  pairError: null,
  copied: false,
  fix: null,
  connectedId: null,
  manageId: null,
} as const;

export const useLocalComputer = create<LocalComputerState>(() => ({
  ...closed,
  os: "mac",
  phone: false,
}));

function browserSystem() {
  const { userAgent, maxTouchPoints } = navigator;
  const { userAgentData } = navigator as { userAgentData?: { platform?: string } };
  return detectSystem({ userAgent, maxTouchPoints, uaPlatform: userAgentData?.platform });
}

export const localComputer = {
  openConnect: () => {
    // Computers lifecycle (02.11): every "connect your computer" goes to the one window.
    if (COMPUTERS_LIFECYCLE) {
      lifecycle.openOwn(browserSystem().os);
      return;
    }
    useLocalComputer.setState({ ...closed, ...browserSystem(), dialog: "connect" });
  },
  openManage: (computerId: string) =>
    useLocalComputer.setState({ ...closed, dialog: "manage", manageId: computerId }),
  openImport: (computerId: string) =>
    useLocalComputer.setState({ ...closed, dialog: "import", manageId: computerId }),
  close: () => useLocalComputer.setState(closed),

  pairRequested: () => useLocalComputer.setState({ requesting: true, pairError: null }),
  paired: (pairing: MyComputerPairing) =>
    useLocalComputer.setState({
      pairing,
      step: "command",
      requesting: false,
      copied: false,
      fix: null,
    }),
  pairFailed: (pairError: string) => useLocalComputer.setState({ requesting: false, pairError }),

  setOs: (os: LocalOs) => useLocalComputer.setState({ os, copied: false }),
  markCopied: () => useLocalComputer.setState({ copied: true }),
  /** The helper called home: the dialog turns by itself. */
  connected: (connectedId: string) =>
    useLocalComputer.setState({ step: "connected", connectedId, fix: null }),
  stuck: () => useLocalComputer.setState({ step: "stuck" }),
  backToCommand: () => useLocalComputer.setState({ step: "command", fix: null }),
  showFix: (fix: InstallFix) => useLocalComputer.setState({ step: "fix", fix }),
};
