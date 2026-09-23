/**
 * The Settings sidebar, as data: which entries belong to this app and which
 * belong to the machine currently being configured.
 *
 * Grouping is the whole point. A person reading "Agents" under a heading that
 * names a machine knows the page changes when they pick another machine; a
 * person reading "General" under "This app" knows it does not. The routes and
 * section ids are unchanged — only the presentation groups them.
 *
 * Kept free of React so the grouping can be tested with plain objects.
 *
 * @module components/settings/settingsNavGroups
 */
import type { EnvironmentId } from "@t3tools/contracts";
import {
  ShieldCheckIcon,
  ArchiveIcon,
  BotIcon,
  CircleUserIcon,
  FlaskConicalIcon,
  GitBranchIcon,
  GlobeIcon,
  KeyRoundIcon,
  LayersIcon,
  Link2Icon,
  PlugIcon,
  PuzzleIcon,
  Settings2Icon,
  SmartphoneIcon,
  SparklesIcon,
} from "lucide-react";
import type { ComponentType } from "react";

import type { FeatureFlagKey } from "../../featureFlags";
import {
  appSettingsPath,
  environmentSettingsPath,
  type AppSettingsSection,
  type EnvironmentSettingsSection,
} from "./settingsScopeRoutes";

type NavIcon = ComponentType<{ className?: string }>;

interface AppNavItem {
  readonly label: string;
  readonly section: AppSettingsSection;
  readonly icon: NavIcon;
  /** When set, the entry is hidden unless this feature flag is enabled. */
  readonly flag?: FeatureFlagKey;
}

interface EnvironmentNavItem {
  readonly label: string;
  readonly section: EnvironmentSettingsSection;
  readonly icon: NavIcon;
}

const APP_NAV_ITEMS: ReadonlyArray<AppNavItem> = [
  { label: "General", section: "general", icon: Settings2Icon },
  { label: "Connections", section: "connections", icon: Link2Icon },
  { label: "Phone", section: "phone", icon: SmartphoneIcon },
  { label: "Browser", section: "browser", icon: GlobeIcon, flag: "browserCompanion" },
  { label: "Labs", section: "labs", icon: FlaskConicalIcon },
];

const ENVIRONMENT_NAV_ITEMS: ReadonlyArray<EnvironmentNavItem> = [
  { label: "General", section: "general", icon: Settings2Icon },
  { label: "Agents", section: "providers", icon: PlugIcon },
  { label: "Telegram", section: "assistants", icon: BotIcon },
  { label: "Apps", section: "apps", icon: SparklesIcon },
  { label: "Source Control", section: "source-control", icon: GitBranchIcon },
  { label: "Archive", section: "archived", icon: ArchiveIcon },
];

/**
 * The browser build talks to exactly one machine — the box daemon that
 * serves the page — so its machine entries always point at that one, and the
 * machine's general page is called what it mostly is there: the account.
 */
const WEB_ENVIRONMENT_NAV_ITEMS: ReadonlyArray<EnvironmentNavItem> = [
  { label: "Account", section: "general", icon: CircleUserIcon },
  { label: "Agents", section: "providers", icon: PlugIcon },
  { label: "Telegram", section: "assistants", icon: BotIcon },
  { label: "Apps", section: "apps", icon: SparklesIcon },
  { label: "Source Control", section: "source-control", icon: GitBranchIcon },
  { label: "Archive", section: "archived", icon: ArchiveIcon },
];

/**
 * Credentials (one store for every machine), the machines list and Extensions
 * are reached through the primary daemon and do not change with the machine
 * selector, so they sit with the app's own entries.
 */
interface FlatNavItem {
  readonly label: string;
  readonly to: string;
  readonly icon: NavIcon;
  readonly flag?: FeatureFlagKey;
}

const FLAT_APP_NAV_ITEMS: ReadonlyArray<FlatNavItem> = [
  { label: "Credentials", to: "/settings/vault", icon: KeyRoundIcon, flag: "vault" },
  // The machines list is always on; the `workspace` flag now only gates the
  // "Advanced sharing" fold inside the page.
  { label: "My machines", to: "/settings/workspace", icon: LayersIcon },
  { label: "Computer access", to: "/settings/computer-access", icon: ShieldCheckIcon },
  { label: "Extensions", to: "/settings/extensions", icon: PuzzleIcon, flag: "plugins" },
];

export interface SettingsNavEntry {
  readonly label: string;
  readonly to: string;
  readonly icon: NavIcon;
}

export type SettingsNavGroup =
  | {
      readonly kind: "app";
      readonly heading: string;
      readonly entries: ReadonlyArray<SettingsNavEntry>;
    }
  | {
      readonly kind: "machine";
      readonly heading: string;
      readonly environmentId: EnvironmentId;
      readonly entries: ReadonlyArray<SettingsNavEntry>;
    };

export const APP_NAV_GROUP_HEADING = "This app";

export function machineNavGroupHeading(machineLabel: string): string {
  return `Machine: ${machineLabel}`;
}

/**
 * Build the grouped nav. `machine` is the machine being configured (null
 * before the app knows any, in which case only the app group is shown rather
 * than a group of broken links).
 */
export function buildSettingsNavGroups(input: {
  readonly isWebApp: boolean;
  readonly isFlagEnabled: (flag: FeatureFlagKey | undefined) => boolean;
  readonly machine: { readonly environmentId: EnvironmentId; readonly label: string } | null;
}): ReadonlyArray<SettingsNavGroup> {
  const appEntries: SettingsNavEntry[] = [
    ...APP_NAV_ITEMS.filter((item) => input.isFlagEnabled(item.flag)).map((item) => ({
      label: item.label,
      icon: item.icon,
      to: appSettingsPath(item.section),
    })),
    ...FLAT_APP_NAV_ITEMS.filter((item) => input.isFlagEnabled(item.flag)).map((item) => ({
      label: item.label,
      icon: item.icon,
      to: item.to,
    })),
  ];

  const groups: SettingsNavGroup[] = [
    { kind: "app", heading: APP_NAV_GROUP_HEADING, entries: appEntries },
  ];

  const machine = input.machine;
  if (machine) {
    const items = input.isWebApp ? WEB_ENVIRONMENT_NAV_ITEMS : ENVIRONMENT_NAV_ITEMS;
    groups.push({
      kind: "machine",
      heading: machineNavGroupHeading(machine.label),
      environmentId: machine.environmentId,
      entries: items.map((item) => ({
        label: item.label,
        icon: item.icon,
        to: environmentSettingsPath(machine.environmentId, item.section),
      })),
    });
  }

  return groups;
}
