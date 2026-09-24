/**
 * What the Uno chat says about its engine (0.0.84): Hermes being installed,
 * failed, or a brought key that is gone. Pure — the banner and the send guard
 * render what this decides.
 */
import { AI_PROVIDER_LABELS, type AssistantLlmStatus } from "@t3tools/contracts";

export type AssistantEngineAction = "retry" | "install" | "settings";

export interface AssistantEngineNotice {
  readonly id: string;
  readonly variant: "info" | "warning" | "error";
  readonly title: string;
  readonly description: string | null;
  /** Monospace progress / error tail. */
  readonly detail: string | null;
  readonly action: AssistantEngineAction | null;
  readonly busy: boolean;
}

export function assistantEngineNotice(
  status: AssistantLlmStatus | null,
): AssistantEngineNotice | null {
  if (status === null) return null;
  const { harness } = status;
  switch (harness.state) {
    case "installing":
      return {
        id: "installing",
        variant: "info",
        title: "Setting up Uno's engine…",
        description:
          "Installing Hermes on this computer. The first time takes a minute or two — Uno answers as soon as it's done.",
        detail: harness.logTail,
        action: null,
        busy: true,
      };
    case "missing":
      return {
        id: "missing",
        variant: "warning",
        title: "Uno's engine isn't installed yet",
        description: "Uno runs on Hermes. Install it to start chatting.",
        detail: null,
        action: "install",
        busy: false,
      };
    case "failed":
    case "unsupported":
      return {
        id: harness.state,
        variant: "error",
        title: "Couldn't set up Uno's engine",
        description: harness.message,
        detail: harness.logTail,
        action: "retry",
        busy: false,
      };
    case "checking":
    case "ready":
      break;
  }
  if (status.provider !== "uno") {
    const key = status.keys.find((entry) => entry.provider === status.provider);
    if (!key?.configured) {
      return {
        id: "key-missing",
        variant: "warning",
        title: `Your ${AI_PROVIDER_LABELS[status.provider]} key is not on this computer`,
        description: "Add it in Settings → Agents, or switch Uno back to the Uno gateway.",
        detail: null,
        action: "settings",
        busy: false,
      };
    }
  } else if (!status.gatewayConfigured) {
    return {
      id: "gateway-missing",
      variant: "warning",
      title: "This computer has no Uno AI key yet",
      description: "Sign in to your Uno account, or use your own provider key.",
      detail: null,
      action: "settings",
      busy: false,
    };
  }
  return null;
}

/** Why a message can't go out right now (the engine isn't there), or null. */
export function assistantEngineSendBlock(status: AssistantLlmStatus | null): string | null {
  if (status === null) return null;
  switch (status.harness.state) {
    case "installing":
      return "Uno's engine is still being installed — your message can go out in a moment.";
    case "missing":
    case "failed":
    case "unsupported":
      return "Uno's engine isn't installed on this computer. Use Retry above the message box.";
    default:
      return null;
  }
}
