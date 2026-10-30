/**
 * What the scope sentence does on each settings page. A page either lets the
 * person pick what it applies to, or says in one line who owns it. Pure, so
 * the table can be tested.
 *
 * @module components/settings/settingsPageScope
 */
import { SIMPLE_SETTINGS_PATHS } from "./settingsNavGroups";
import { parseSettingsScopeLocation } from "./settingsScopeRoutes";

export type SettingsPageScope =
  /** Project and computer can be picked, "All computers" included. */
  | { readonly kind: "scoped" }
  /** Only a computer: what's here exists per computer, projects don't apply. */
  | { readonly kind: "computer" }
  /** Nothing to pick: says who owns the page. */
  | { readonly kind: "owned"; readonly owner: SettingsPageOwner };

export type SettingsPageOwner =
  | "account"
  | "connectors"
  | "this-computer"
  | "skills"
  | "assistants"
  | "dev-mode"
  | "device"
  | "credentials";

const SCOPED_MACHINE_SECTIONS: ReadonlySet<string> = new Set([
  "general",
  "source-control",
  "worktrees",
  "projects",
]);

const OWNED_PATHS: Readonly<Record<string, SettingsPageOwner>> = {
  [SIMPLE_SETTINGS_PATHS.account]: "account",
  [SIMPLE_SETTINGS_PATHS.connectors]: "connectors",
  [SIMPLE_SETTINGS_PATHS.skills]: "skills",
  [SIMPLE_SETTINGS_PATHS.assistants]: "assistants",
  [SIMPLE_SETTINGS_PATHS.computer]: "this-computer",
  [SIMPLE_SETTINGS_PATHS.developer]: "dev-mode",
  "/settings/vault": "credentials",
};

export function settingsPageScope(pathname: string): SettingsPageScope | null {
  if (pathname === SIMPLE_SETTINGS_PATHS.ai) return { kind: "scoped" };
  const owner = OWNED_PATHS[pathname];
  if (owner) return { kind: "owned", owner };
  const location = parseSettingsScopeLocation(pathname);
  if (pathname.startsWith("/settings/environment/")) {
    return location.section !== null && SCOPED_MACHINE_SECTIONS.has(location.section)
      ? { kind: "scoped" }
      : { kind: "computer" };
  }
  if (pathname.startsWith("/settings/app/")) return { kind: "owned", owner: "device" };
  return null;
}

/** The one line for pages nothing can be picked on. */
export function settingsOwnerLine(owner: SettingsPageOwner, computerLabel: string): string {
  switch (owner) {
    case "account":
      return "Your plan is the same on every computer. General settings here belong to this device.";
    case "connectors":
      return `Apps connect through your Uno account, so every computer gets them. Servers of your own stay on ${computerLabel}.`;
    case "this-computer":
      return `These belong to ${computerLabel}.`;
    case "skills":
      return `Skills are added to ${computerLabel}.`;
    case "assistants":
      return `Assistants live on ${computerLabel}.`;
    case "dev-mode":
      return "Dev mode follows you to every computer.";
    case "device":
      return "These belong to this app on this device.";
    case "credentials":
      return "One store for all your computers.";
  }
}
