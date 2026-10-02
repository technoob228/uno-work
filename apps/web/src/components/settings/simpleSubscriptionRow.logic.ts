/**
 * Settings → AI → "Your subscription": what a Claude / ChatGPT row says.
 *
 * Claude Code without a sign-in of its own runs on Uno AI (the daemon reports
 * `auth.type` "unoAi", ready). That is not the person's subscription: the row
 * says so and still offers Sign in — before 02.10 it showed "Connected" and no
 * way to sign in.
 *
 * Pure, so the mapping is tested without React.
 */
import type { ProviderPaneKind } from "../chat/modelPickerProviderPane";

export interface SubscriptionRowState {
  /** connected: own account; unoAi: works on Uno AI; setup: needs install / sign-in; none: blocked. */
  readonly state: "connected" | "unoAi" | "setup" | "none";
  /** Which setup pane the row opens (null: no button). */
  readonly paneKind: Extract<ProviderPaneKind, "install" | "signin"> | null;
  /** "Claude Max · me@example.com" for a connected row. */
  readonly detail: string | null;
}

export function subscriptionRowState(input: {
  readonly kind: ProviderPaneKind;
  readonly onUnoAi: boolean;
  readonly accountLabel: string | null;
  readonly email: string | null;
}): SubscriptionRowState {
  if (input.kind === "models" && input.onUnoAi) {
    return { state: "unoAi", paneKind: "signin", detail: null };
  }
  if (input.kind === "models") {
    const detail = [input.accountLabel, input.email]
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
      .join(" · ");
    return { state: "connected", paneKind: null, detail: detail.length > 0 ? detail : null };
  }
  if (input.kind === "install" || input.kind === "signin") {
    return { state: "setup", paneKind: input.kind, detail: null };
  }
  return { state: "none", paneKind: null, detail: null };
}
