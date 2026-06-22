import {
  GlobeIcon,
  KeyRoundIcon,
  Loader2Icon,
  PlusIcon,
  ShieldIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useState } from "react";
import type { BrowserCredentialRecord, BrowserCredentialScope } from "@t3tools/contracts";

import { isElectron } from "../../env";
import { useBrowserCredentials, useInvalidateBrowserCredentials } from "../preview/BrowserPane";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function BrowserSettingsPanel() {
  const browserProfileScope = useSettings((settings) => settings.browserProfileScope);
  const browserAutomationLevel = useSettings((settings) => settings.browserAutomationLevel);
  const { updateSettings } = useUpdateSettings();
  const credentialsQuery = useBrowserCredentials();
  const invalidateCredentials = useInvalidateBrowserCredentials();
  const [isAdding, setIsAdding] = useState(false);

  const credentials = credentialsQuery.data ?? [];

  const handleDelete = useCallback(
    async (id: string) => {
      if (!window.desktopBridge) return;
      await window.desktopBridge.deleteBrowserCredential(id);
      await invalidateCredentials();
    },
    [invalidateCredentials],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection title="Профиль браузера" icon={<GlobeIcon className="size-3.5" />}>
        <SettingsRow
          title="Профиль сессий и cookies"
          description="Общий профиль на весь аккаунт или отдельный профиль для каждого проекта (изолированные cookies и вход)."
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
                  {scope === "account" ? "Аккаунт" : "Проект"}
                </button>
              ))}
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection title="Automation" icon={<ShieldIcon className="size-3.5" />}>
        <SettingsRow
          title="Browser automation"
          description="Уровень команд, которые агент может выполнять во встроенном браузере через Uno Work bridge."
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

      <SettingsSection
        title="Сохранённые входы"
        icon={<KeyRoundIcon className="size-3.5" />}
        headerAction={
          isElectron ? (
            <Button size="xs" variant="ghost" onClick={() => setIsAdding((value) => !value)}>
              <PlusIcon className="size-3.5" />
              Добавить
            </Button>
          ) : null
        }
      >
        {!isElectron ? (
          <SettingsRow
            title="Недоступно"
            description="Сохранение паролей доступно только в десктоп-приложении (используется системное шифрование)."
          />
        ) : (
          <>
            {isAdding ? (
              <AddCredentialRow
                defaultScope={browserProfileScope}
                onDone={async () => {
                  setIsAdding(false);
                  await invalidateCredentials();
                }}
                onCancel={() => setIsAdding(false)}
              />
            ) : null}
            {credentialsQuery.isPending ? (
              <SettingsRow
                title={<Loader2Icon className="size-4 animate-spin text-muted-foreground" />}
                description="Загрузка…"
              />
            ) : credentials.length === 0 && !isAdding ? (
              <SettingsRow
                title="Пока пусто"
                description="Добавьте логин и пароль для сайта — кнопка автозаполнения появится в браузере на совпадающем домене."
              />
            ) : (
              credentials.map((credential) => (
                <CredentialRow
                  key={credential.id}
                  credential={credential}
                  onDelete={() => handleDelete(credential.id)}
                />
              ))
            )}
          </>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function CredentialRow({
  credential,
  onDelete,
}: {
  credential: BrowserCredentialRecord;
  onDelete: () => void;
}) {
  return (
    <SettingsRow
      title={credential.origin}
      description={`${credential.username} · ${credential.scope === "account" ? "весь аккаунт" : "проект"}`}
      control={
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Удалить"
          onClick={onDelete}
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      }
    />
  );
}

function AddCredentialRow({
  defaultScope,
  onDone,
  onCancel,
}: {
  defaultScope: BrowserCredentialScope;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [origin, setOrigin] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [scope, setScope] = useState<BrowserCredentialScope>(defaultScope);
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    if (!window.desktopBridge || !origin.trim() || !username.trim()) return;
    setSaving(true);
    try {
      const saved = await window.desktopBridge.saveBrowserCredential({
        origin: origin.trim(),
        username: username.trim(),
        password,
        scope,
      });
      if (!saved) {
        toastManager.add({
          type: "error",
          title: "Не удалось сохранить",
          description:
            "Проверьте, что адрес начинается с http(s):// и доступно системное шифрование.",
        });
        return;
      }
      onDone();
    } finally {
      setSaving(false);
    }
  }, [origin, username, password, scope, onDone]);

  return (
    <div className="space-y-2 border-t border-border/60 px-4 py-4 sm:px-5">
      <input
        type="text"
        value={origin}
        onChange={(event) => setOrigin(event.target.value)}
        placeholder="https://github.com"
        className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus:border-ring"
      />
      <div className="flex gap-2">
        <input
          type="text"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          placeholder="Логин или e-mail"
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs outline-none focus:border-ring"
        />
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Пароль"
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs outline-none focus:border-ring"
        />
      </div>
      <div className="flex items-center justify-between">
        <div className="inline-flex overflow-hidden rounded-md border border-input text-xs">
          {(["account", "project"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setScope(value)}
              className={
                scope === value
                  ? "bg-accent px-3 py-1 text-accent-foreground"
                  : "px-3 py-1 text-muted-foreground hover:bg-accent/50"
              }
            >
              {value === "account" ? "Аккаунт" : "Проект"}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <Button size="xs" variant="ghost" onClick={onCancel} disabled={saving}>
            Отмена
          </Button>
          <Button
            size="xs"
            onClick={handleSave}
            disabled={saving || !origin.trim() || !username.trim()}
          >
            {saving ? <Loader2Icon className="size-3.5 animate-spin" /> : "Сохранить"}
          </Button>
        </div>
      </div>
    </div>
  );
}
