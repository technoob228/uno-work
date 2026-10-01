import { GlobeIcon, KeyRoundIcon, Loader2Icon, ShieldIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { ensureLocalApi } from "../../localApi";
import {
  useInvalidateBrowserCredentials,
  useLegacyDesktopCredentials,
} from "../preview/BrowserPane";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useFeatureFlag } from "../../hooks/useFeatureFlags";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { FeatureDisabledPanel } from "./FeatureDisabledPanel";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function BrowserSettingsPanel() {
  const browserEnabled = useFeatureFlag("browserCompanion");
  const browserProfileScope = useSettings((settings) => settings.browserProfileScope);
  const browserAutomationLevel = useSettings((settings) => settings.browserAutomationLevel);
  const { updateSettings } = useUpdateSettings();
  const navigate = useNavigate();
  const legacyQuery = useLegacyDesktopCredentials();
  const invalidateCredentials = useInvalidateBrowserCredentials();
  const [migrating, setMigrating] = useState(false);

  const legacyCredentials = legacyQuery.data ?? [];

  /**
   * Перенос старого локального хранилища десктопа (Electron safeStorage) в общее
   * хранилище демона. Пароль читается через IPC и уходит на демон, где ложится в
   * `ServerSecretStore`; из старого файла запись удаляется только после успешной
   * записи в vault, иначе логин остался бы в двух местах и разъехался.
   */
  const migrateLegacy = useCallback(async () => {
    if (!window.desktopBridge || legacyCredentials.length === 0) return;
    setMigrating(true);
    let moved = 0;
    const failed: string[] = [];
    try {
      const api = ensureLocalApi();
      const existing = await api.vault.list();
      for (const legacy of legacyCredentials) {
        const password = await window.desktopBridge.revealBrowserCredentialPassword(legacy.id);
        if (password === null) {
          failed.push(legacy.origin);
          continue;
        }
        const duplicate = existing.find(
          (candidate) => candidate.url === legacy.origin && candidate.username === legacy.username,
        );
        try {
          await api.vault.upsert({
            ...(duplicate ? { id: duplicate.id } : {}),
            input: {
              label: legacy.origin.replace(/^https?:\/\//, ""),
              url: legacy.origin,
              username: legacy.username,
              password,
            },
          });
          await window.desktopBridge.deleteBrowserCredential(legacy.id);
          moved += 1;
        } catch {
          failed.push(legacy.origin);
        }
      }
      await Promise.all([legacyQuery.refetch(), invalidateCredentials()]);
      toastManager.add({
        type: failed.length > 0 ? "warning" : "success",
        title: `Logins moved: ${moved}`,
        description:
          failed.length > 0
            ? `Couldn't move: ${failed.join(", ")}. They stay in the old storage.`
            : "You can now see them in both the web and desktop app.",
      });
    } finally {
      setMigrating(false);
    }
  }, [invalidateCredentials, legacyCredentials, legacyQuery]);

  if (!browserEnabled) {
    return <FeatureDisabledPanel feature="Browser" />;
  }

  return (
    <SettingsPageContainer>
      <SettingsSection title="Browser profile" icon={<GlobeIcon className="size-3.5" />}>
        <SettingsRow
          title="Sessions and cookies"
          description="One profile for your whole account, or a separate one per project with its own cookies and sign-ins."
          control={
            <div className="inline-flex overflow-hidden rounded-md border border-input text-xs">
              {(["account", "project"] as const).map((scope) => (
                <button
                  key={scope}
                  type="button"
                  onClick={() => updateSettings({ browserProfileScope: scope })}
                  className={
                    browserProfileScope === scope
                      ? "bg-accent px-3 py-1.5 text-accent-foreground"
                      : "px-3 py-1.5 text-muted-foreground hover:bg-accent/50"
                  }
                >
                  {scope === "account" ? "Account" : "Project"}
                </button>
              ))}
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection title="Automation" icon={<ShieldIcon className="size-3.5" />}>
        <SettingsRow
          title="Browser automation"
          description="What the agent is allowed to do in the built-in browser."
          control={
            <div className="inline-flex overflow-hidden rounded-md border border-input text-xs">
              {(["full", "safe", "off"] as const).map((level) => (
                <button
                  key={level}
                  type="button"
                  onClick={() => updateSettings({ browserAutomationLevel: level })}
                  className={
                    browserAutomationLevel === level
                      ? "bg-accent px-3 py-1.5 text-accent-foreground"
                      : "px-3 py-1.5 text-muted-foreground hover:bg-accent/50"
                  }
                >
                  {level === "full" ? "Full" : level === "safe" ? "Safe" : "Off"}
                </button>
              ))}
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection title="Saved logins" icon={<KeyRoundIcon className="size-3.5" />}>
        <SettingsRow
          title="Logins live in Credentials"
          description="One list for the whole app, web and desktop. The key button in the address bar fills in the password on a matching site."
          control={
            <Button
              size="xs"
              variant="outline"
              onClick={() => void navigate({ to: "/settings/vault" })}
            >
              Open Credentials
            </Button>
          }
        />
        {legacyCredentials.length > 0 ? (
          <SettingsRow
            title={`Move ${legacyCredentials.length} ${legacyCredentials.length === 1 ? "login" : "logins"} from old local storage`}
            description="Desktop passwords used to be stored apart and were visible only on this Mac. Moving copies them to Credentials and removes them from the old file."
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={migrating}
                onClick={() => void migrateLegacy()}
              >
                {migrating ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                Move
              </Button>
            }
          />
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
