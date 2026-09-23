/** Journal of every way into a computer. STUB — filled by the journal branch. */
import type { UnoBox } from "@t3tools/contracts";

import { SettingsRow, SettingsSection } from "../settingsLayout";

export function SecurityOverview(_props: {
  readonly boxes: ReadonlyArray<UnoBox>;
  readonly selectedId: number | null;
  readonly onSelect: (id: number) => void;
}) {
  return null;
}

export function AccessJournal({ box }: { readonly box: UnoBox }) {
  return (
    <SettingsSection title="Who got in">
      <SettingsRow title={`Access journal for ${box.name}`} description="Coming soon." />
    </SettingsSection>
  );
}
