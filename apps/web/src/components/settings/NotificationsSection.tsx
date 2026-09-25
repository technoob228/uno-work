/**
 * Settings → General → Notifications: when Uno Work pops up a system
 * notification on this device (see inbox/systemNotifications.ts). On by
 * default for what needs the person; this is where it is changed.
 */
import {
  NOTIFICATION_MODES,
  type NotificationMode,
  setNotificationMode,
  useNotificationMode,
  useSystemNotificationsState,
} from "../../inbox/systemNotifications";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

function isMode(value: unknown): value is NotificationMode {
  return NOTIFICATION_MODES.some((option) => option.value === value);
}

export function NotificationsSection() {
  const mode = useNotificationMode();
  const state = useSystemNotificationsState();
  if (state === "unsupported") return null;
  const current =
    NOTIFICATION_MODES.find((option) => option.value === mode) ?? NOTIFICATION_MODES[0]!;
  const description =
    state === "blocked"
      ? "Notifications are blocked in this browser's settings. Allow them for this site to get them."
      : state === "ask"
        ? `${current.hint} Your browser will ask to allow them.`
        : current.hint;
  return (
    <SettingsSection title="Notifications">
      <SettingsRow
        title="Notify me on this device"
        description={description}
        resetAction={
          mode !== "smart" ? (
            <SettingResetButton
              label="notifications"
              onClick={() => void setNotificationMode("smart")}
            />
          ) : null
        }
        control={
          <Select
            value={mode}
            onValueChange={(value) => {
              if (isMode(value)) void setNotificationMode(value);
            }}
          >
            <SelectTrigger
              className="w-full sm:w-52"
              aria-label="Notify me on this device"
              data-testid="settings-notifications"
            >
              <SelectValue>{current.label}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {NOTIFICATION_MODES.map((option) => (
                <SelectItem hideIndicator key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
