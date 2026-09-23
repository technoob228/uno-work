/** Where a computer can be reached from. STUB — filled by the network branch. */
import type { UnoBox } from "@t3tools/contracts";

import { SettingsRow, SettingsSection } from "../settingsLayout";

export function NetworkAccess({ box }: { readonly box: UnoBox }) {
  return (
    <SettingsSection title="Who can reach it">
      <SettingsRow title={`Network for ${box.name}`} description="Coming soon." />
    </SettingsSection>
  );
}
