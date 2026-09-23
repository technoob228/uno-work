/**
 * Settings → General → Appearance: how the window is laid out. Only shown
 * with the Labs flag "Layout options"; the standard sidebar stays the
 * default. Switching is instant — pins, the chosen section and open tabs are
 * shared by every layout.
 */
import { isElectron } from "../../env";
import { useFeatureFlag } from "../../hooks/useFeatureFlags";
import { type NavLayout, useNavStore } from "../../navigation/navStore";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

const OPTIONS: ReadonlyArray<{ value: NavLayout; label: string; hint: string }> = [
  {
    value: "sidebar",
    label: "Sidebar",
    hint: "Home, Inbox, pins and Chats / Files / Apps in one sidebar.",
  },
  {
    value: "rail",
    label: "Rail + panel",
    hint: "A narrow rail of icons; the panel next to it shows one section at a time.",
  },
  {
    value: "tabs",
    label: "Desktop tabs",
    hint: "Tabs on top for the chats, apps and files you open. Desktop app only.",
  },
];

export function AppearanceLayoutSection() {
  const enabled = useFeatureFlag("navLayouts");
  const layout = useNavStore((state) => state.layout);
  const setLayout = useNavStore((state) => state.setLayout);
  if (!enabled) return null;
  const current = OPTIONS.find((option) => option.value === layout) ?? OPTIONS[0]!;
  const tabsHere = layout !== "tabs" || isElectron;
  return (
    <SettingsSection title="Appearance">
      <SettingsRow
        title="Layout"
        description={
          tabsHere
            ? current.hint
            : "Desktop tabs work in the Uno Work desktop app; here you see the sidebar."
        }
        resetAction={
          layout !== "sidebar" ? (
            <SettingResetButton label="layout" onClick={() => setLayout("sidebar")} />
          ) : null
        }
        control={
          <Select
            value={layout}
            onValueChange={(value) => {
              if (value === "sidebar" || value === "rail" || value === "tabs") setLayout(value);
            }}
          >
            <SelectTrigger
              className="w-full sm:w-44"
              aria-label="Layout"
              data-testid="settings-layout"
            >
              <SelectValue>{current.label}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {OPTIONS.map((option) => (
                <SelectItem hideIndicator key={option.value} value={option.value}>
                  {option.label}
                  {option.value === "tabs" && !isElectron ? " (desktop app)" : ""}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
