/**
 * Settings → AI → "Your subscription": what a Claude / ChatGPT row says.
 *
 * Claude Code without a sign-in of its own runs on Uno AI (the daemon reports
 * `auth.type` "unoAi", ready). That is not the person's subscription: the row
 * says so and still offers Sign in — before 02.10 it showed "Connected" and no
 * way to sign in. On a trial computer Claude has no Uno AI: the daemon reports
 * it signed out, and the row is just "Sign in with Claude". An own sign-in
 * can be signed out.
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
  /** True when the row offers Sign out (own account on this computer). */
  readonly canSignOut: boolean;
}

/** Label of the row's setup button. */
export function subscriptionActionLabel(
  row: SubscriptionRowState,
  subscription: { readonly label: string },
): string | null {
  if (row.paneKind === "install") return "Install";
  if (row.paneKind === "signin") return `Sign in with ${subscription.label}`;
  return null;
}

export function subscriptionRowState(input: {
  readonly kind: ProviderPaneKind;
  readonly onUnoAi: boolean;
  readonly accountLabel: string | null;
  readonly email: string | null;
}): SubscriptionRowState {
  if (input.kind === "models" && input.onUnoAi) {
    return { state: "unoAi", paneKind: "signin", detail: null, canSignOut: false };
  }
  if (input.kind === "models") {
    const detail = [input.accountLabel, input.email]
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
      .join(" · ");
    return {
      state: "connected",
      paneKind: null,
      detail: detail.length > 0 ? detail : null,
      canSignOut: true,
    };
  }
  if (input.kind === "install" || input.kind === "signin") {
    return { state: "setup", paneKind: input.kind, detail: null, canSignOut: false };
  }
  return { state: "none", paneKind: null, detail: null, canSignOut: false };
}
