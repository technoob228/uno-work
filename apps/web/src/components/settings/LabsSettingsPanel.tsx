import {
  FEATURE_FLAGS,
  RETIRED_FEATURE_FLAGS,
  featureFlagDefault,
  readStoredFeatureFlag,
  resolveFeatureFlag,
  type FeatureFlagDefinition,
  type FeatureFlagKey,
} from "../../featureFlags";
import { useFeatureFlagOverrides, useSetFeatureFlag } from "../../hooks/useFeatureFlags";
import { useIsStageChannel } from "../../unoChannel";
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
  // On the stage channel the new work is on by default (featureFlags.ts).
  const stage = useIsStageChannel();

  return (
    <SettingsPageContainer>
      <SettingsSection title={stage ? "Feature flags · stage" : "Feature flags"}>
        {FEATURE_FLAGS.filter(
          (flag) =>
            !RETIRED_FEATURE_FLAGS.has(flag.key) &&
            // Stage-only work (0.0.139 Labs) isn't offered on the release channel.
            (stage || (flag as FeatureFlagDefinition).stageDefault === undefined),
        ).map((flag) => {
          const key = flag.key as FeatureFlagKey;
          const value = resolveFeatureFlag(overrides, key, stage);
          const stored = readStoredFeatureFlag(overrides, key);
          const fallback = featureFlagDefault(key, stage);
          const isOverridden = stored !== undefined && stored !== fallback;
          return (
            <SettingsRow
              key={flag.key}
              title={flag.label}
              description={flag.description}
              resetAction={
                isOverridden ? (
                  <SettingResetButton
                    label={`${flag.label} flag`}
                    onClick={() => setFlag(key, fallback)}
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
