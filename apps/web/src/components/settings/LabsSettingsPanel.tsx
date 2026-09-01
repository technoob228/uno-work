import { FEATURE_FLAGS, resolveFeatureFlag, type FeatureFlagKey } from "../../featureFlags";
import { useFeatureFlagOverrides, useSetFeatureFlag } from "../../hooks/useFeatureFlags";
import { Switch } from "../ui/switch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

/**
 * Labs — device-level feature flags. Each entry in the `FEATURE_FLAGS`
 * registry renders as a labeled Switch. Choices persist to the app-scope
 * client settings; there are no users yet, so this is purely a testing aid
 * for turning experimental surfaces on and off.
 */
export function LabsSettingsPanel() {
  const overrides = useFeatureFlagOverrides();
  const setFlag = useSetFeatureFlag();

  return (
    <SettingsPageContainer>
      <SettingsSection title="Feature flags">
        {FEATURE_FLAGS.map((flag) => {
          const key = flag.key as FeatureFlagKey;
          const value = resolveFeatureFlag(overrides, key);
          const isOverridden = overrides[key] !== undefined && overrides[key] !== flag.default;
          return (
            <SettingsRow
              key={flag.key}
              title={flag.label}
              description={flag.description}
              resetAction={
                isOverridden ? (
                  <SettingResetButton
                    label={`${flag.label} flag`}
                    onClick={() => setFlag(key, flag.default)}
                  />
                ) : null
              }
              control={
                <Switch
                  checked={value}
                  onCheckedChange={(checked) => setFlag(key, Boolean(checked))}
                  aria-label={`Toggle ${flag.label}`}
                />
              }
            />
          );
        })}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
