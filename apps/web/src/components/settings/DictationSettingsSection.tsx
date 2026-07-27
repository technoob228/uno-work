import { MicIcon } from "lucide-react";
import {
  DEFAULT_DICTATION_CLEANUP_MODEL,
  DICTATION_LANGUAGE_LABELS,
  DICTATION_LANGUAGES,
  DICTATION_STT_MODEL,
  type DictationLanguage,
} from "@t3tools/contracts";

import { isDictationSupported } from "../../dictation/dictationRecorder";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

const isDictationLanguage = (value: string): value is DictationLanguage =>
  (DICTATION_LANGUAGES as readonly string[]).includes(value);

export function DictationSettingsSection({
  shortcutLabel,
}: {
  /** Rendered under the toggle so the hotkey is discoverable from settings. */
  shortcutLabel: string | null;
}) {
  const dictation = useSettings((settings) => settings.dictation);
  const { updateSettings } = useUpdateSettings();
  const supported = isDictationSupported();

  return (
    <SettingsSection title="Диктовка" icon={<MicIcon className="size-3.5" />}>
      <SettingsRow
        title="Голосовой ввод в чате"
        description={
          supported
            ? `Кнопка микрофона рядом с отправкой. Речь распознаётся моделью ${DICTATION_STT_MODEL} через Uno LLM.`
            : "Этот клиент не умеет записывать звук (нет MediaRecorder)."
        }
        status={shortcutLabel ? `Горячая клавиша: ${shortcutLabel}` : null}
        control={
          <Switch
            checked={dictation.enabled}
            disabled={!supported}
            onCheckedChange={(checked) =>
              updateSettings({ dictation: { ...dictation, enabled: Boolean(checked) } })
            }
          />
        }
      />

      <SettingsRow
        title="Язык"
        description="«Auto» — модель определяет язык сама. Явный язык надёжнее: авто-детект иногда возвращает перевод на английский вместо расшифровки."
        control={
          <Select
            value={dictation.language}
            onValueChange={(value) => {
              if (typeof value === "string" && isDictationLanguage(value)) {
                updateSettings({ dictation: { ...dictation, language: value } });
              }
            }}
          >
            <SelectTrigger className="w-full sm:w-44" aria-label="Язык диктовки">
              <SelectValue>{DICTATION_LANGUAGE_LABELS[dictation.language]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {DICTATION_LANGUAGES.map((language) => (
                <SelectItem key={language} value={language}>
                  {DICTATION_LANGUAGE_LABELS[language]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        title="Правка по контексту проекта"
        description="Второй проход через Uno LLM: чинит пунктуацию и термины проекта, которые модель распознавания слышит впервые. При сбое вставляется исходная расшифровка."
        control={
          <Switch
            checked={dictation.cleanupEnabled}
            onCheckedChange={(checked) =>
              updateSettings({ dictation: { ...dictation, cleanupEnabled: Boolean(checked) } })
            }
          />
        }
      />

      <SettingsRow
        title="Модель для правки"
        description="Любая модель каталога Uno. Нужна быстрая — она добавляет задержку к каждой диктовке."
        resetAction={
          dictation.cleanupModel !== DEFAULT_DICTATION_CLEANUP_MODEL ? (
            <SettingResetButton
              label="dictation cleanup model"
              onClick={() =>
                updateSettings({
                  dictation: { ...dictation, cleanupModel: DEFAULT_DICTATION_CLEANUP_MODEL },
                })
              }
            />
          ) : null
        }
        control={
          <DraftInput
            className="w-full sm:w-72"
            value={dictation.cleanupModel}
            placeholder={DEFAULT_DICTATION_CLEANUP_MODEL}
            onCommit={(next) =>
              updateSettings({
                dictation: {
                  ...dictation,
                  cleanupModel: next.trim() || DEFAULT_DICTATION_CLEANUP_MODEL,
                },
              })
            }
          />
        }
      />

      <SettingsRow
        title="Свой словарь"
        description="Слова, имена и термины, которые нужно писать правильно: через запятую или с новой строки. Названия папок проекта добавляются автоматически."
        control={
          <DraftInput
            className="w-full sm:w-72"
            value={dictation.vocabulary}
            placeholder="Uno Work, fishcode, ворктри"
            onCommit={(next) => updateSettings({ dictation: { ...dictation, vocabulary: next } })}
          />
        }
      />

      <SettingsRow
        title="Сразу отправлять"
        description="Отправлять сообщение сразу после расшифровки, не давая вычитать текст."
        control={
          <Switch
            checked={dictation.autoSend}
            onCheckedChange={(checked) =>
              updateSettings({ dictation: { ...dictation, autoSend: Boolean(checked) } })
            }
          />
        }
      />
    </SettingsSection>
  );
}
