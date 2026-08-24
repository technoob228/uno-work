/**
 * Инструкции для всех харнессов про систему плагинов Uno Work.
 *
 * Каждый харнесс (Claude / Codex / OpenCode / Uno) получает один и тот же
 * текст через свой механизм системного промпта — рядом с инструкциями про
 * встроенный браузер. Текст объясняет агенту, как расширить сам харнесс,
 * записав один JSON-файл: демон подхватывает его без рестарта.
 */

/**
 * Возвращает блок инструкций. `pluginsDir` — фактическая директория плагинов
 * текущего демона, чтобы модель не угадывала путь.
 */
export function buildPluginInstructions(pluginsDir: string): string {
  return `## Плагины Uno Work — расширяй свой собственный harness

Приложение Uno Work, внутри которого ты работаешь, расширяется декларативными плагинами. Демон следит за директорией \`${pluginsDir}/\` и подхватывает изменения без рестарта. Когда пользователь просит «сделай, чтобы приложение …» (автоматизацию, реакцию на события, задачу по расписанию, свой экран с данными) — создай или отредактируй плагин, а не отвечай, что это невозможно.

Две формы плагина:
- \`${pluginsDir}/<id>.json\` — один файл, только hooks и crons;
- \`${pluginsDir}/<id>/plugin.json\` — директория: тот же манифест плюс любые файлы рядом. Только эта форма может показывать **панель** (см. ниже). \`<id>\` не должен совпадать с именем файла-плагина.

Формат манифеста:

\`\`\`json
{
  "name": "Название для страницы Settings → Extensions",
  "description": "Что делает плагин (по-русски или по-английски)",
  "version": "0.1.0",
  "enabled": true,
  "hooks": [
    {
      "on": "thread.turn-diff-completed",
      "run": { "kind": "shell", "command": "notify-send 'Uno Work' 'Агент закончил задачу'" }
    }
  ],
  "crons": [
    {
      "id": "morning-digest",
      "schedule": "0 9 * * 1-5",
      "run": { "kind": "shell", "command": "~/scripts/digest.sh", "cwd": "~", "timeoutMs": 120000 }
    },
    {
      "id": "health-poll",
      "every": "15m",
      "run": { "kind": "shell", "command": "curl -fsS https://example.com/health || echo DOWN" }
    }
  ]
}
\`\`\`

**hooks** — реакция на события оркестрации. \`on\` — точный тип события, префикс (\`"thread.*"\`) или \`"*"\`. Полезные типы: \`thread.created\`, \`thread.message-sent\`, \`thread.turn-start-requested\`, \`thread.turn-diff-completed\` (ход агента завершён, есть diff), \`thread.archived\`, \`project.created\`. Команда получает переменные окружения \`UNO_PLUGIN_EVENT\` (JSON события), \`UNO_PLUGIN_EVENT_TYPE\`, \`UNO_PLUGIN_ID\`, \`UNO_PLUGIN_TRIGGER\`.

**crons** — задачи по расписанию: либо \`schedule\` (5-польный cron, локальное время, точность — минута), либо \`every\` (интервал: \`"5m"\`, \`"2h"\`, \`"1d"\`; минимум одна минута). Ровно одно из двух полей.

**panel** — статическая «софтинка» плагина во вкладке правой панели приложения: \`"panel": { "title": "Deploys", "path": "panel/index.html" }\`. \`path\` — файл внутри директории плагина (относительный, без \`..\`; должен существовать, иначе плагин помечается невалидным). Панель открывается из Settings → Extensions и из меню «+» в табстрипе правой панели.

Как устроена панель:
- Это обычные статические файлы: HTML + встроенный (inline) JS и CSS. Никаких localhost-серверов, сборщиков и внешних CDN — CSP разрешает только \`self\` (плюс inline-скрипты) и \`data:\`-картинки.
- Панель рендерится в изолированном iframe (sandbox без same-origin): доступа к приложению, его кукам и хранилищу у неё нет.
- Данные готовит cron того же плагина: пишет \`data.json\` рядом с \`index.html\`, а страница читает его \`fetch("data.json")\` (относительный путь; кэш отключён, так что после крона достаточно перезагрузить вкладку).

**Мост панель → приложение.** Панель может не только показывать данные, но и управлять приложением — через \`postMessage\` родителю. Вставь в страницу этот сниппет (промис-обёртка) и зови методы:

\`\`\`html
<script>
const uno = (() => {
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || message.__unoPanel !== 1) return;
    if (message.event) { listeners.forEach((fn) => fn(message.event)); return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result);
  });
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      window.parent.postMessage({ __unoPanel: 1, id, method, params }, "*");
    });
  return {
    openFile: (path) => call("openFile", { path }),
    openUrl: (url) => call("openUrl", { url }),
    sendToThread: (text, threadTag) => call("sendToThread", { text, threadTag }),
    subscribe: (pattern, onEvent) => { listeners.push(onEvent); return call("subscribe", { pattern }); },
  };
})();
</script>
\`\`\`

Методы моста (других нет; неизвестный метод вернёт ошибку):
- \`openFile(path)\` — открыть файл вкладкой правой панели. Абсолютный путь либо относительный от корня проекта; \`..\` запрещены.
- \`openUrl(url)\` — открыть страницу во встроенном браузере.
- \`sendToThread(text, threadTag?)\` — отправить задачу агенту в текущем проекте. Тред заводится сам с заголовком \`[<имя плагина>] <threadTag>\`; один и тот же \`threadTag\` продолжает тот же тред (по умолчанию \`"panel"\`), т.е. панель может вести с агентом диалог. Права треда наследуются от проекта — панель НЕ расширяет права агента. Возвращает \`{ threadId, created }\`; пользователь видит тост и запись в Settings → Extensions.
- \`subscribe(pattern, onEvent)\` — подписка на события проекта вкладки: \`thread.upserted\`, \`thread.removed\`, \`project.upserted\`, \`project.removed\` (паттерны как у hooks: \`"thread.*"\`, \`"*"\`). Обработчик получает \`{ type, projectId, payload }\` — удобно, чтобы панель перерисовывалась, когда агент закончил ход.

Ограничения моста: не больше 10 вызовов в секунду на вкладку (сверх — ошибка), события приходят только по проекту вкладки, никакого доступа к файлам и сети приложения у панели нет.

Рецепт «сделай мне дашборд/мини-приложение без бэкенда»: директория-плагин + \`panel\` + cron, обновляющий данные:

\`\`\`json
{
  "name": "Deploys",
  "description": "Статус последних деплоев",
  "panel": { "title": "Deploys", "path": "panel/index.html" },
  "crons": [
    {
      "id": "refresh",
      "every": "5m",
      "run": {
        "kind": "shell",
        "command": "curl -fsS https://example.com/api/deploys > data.json",
        "cwd": "${pluginsDir}/deploys/panel"
      }
    }
  ]
}
\`\`\`

рядом — \`${pluginsDir}/deploys/panel/index.html\` со скриптом, который читает \`data.json\` и рисует список.

**run** — пока единственный вид действия: \`{"kind": "shell", "command": "...", "cwd": "...", "timeoutMs": 60000}\`. Команда исполняется через \`/bin/sh -c\` от пользователя демона; таймаут по умолчанию 60 с, максимум 10 мин. Сложную логику выноси в скрипт рядом (например \`~/.unowork/scripts/\`) и вызывай его из \`command\`.

Правила:
- Перед созданием посмотри, что уже лежит в \`${pluginsDir}/\` — возможно, нужный плагин уже есть и его надо отредактировать, а не дублировать.
- Нужен результат-приложение без бэкенда (дашборд, отчёт, чек-лист, статус чего-нибудь) — это панельный плагин, а не файл в проекте: интерактив делается HTML+JS в панели, данные обновляет cron в \`data.json\` рядом.
- После записи файла кратко скажи пользователю, что плагин появился в Settings → Extensions, где его можно выключить.
- Ошибки конфигурации видны там же (некорректный файл не исполняется, а показывается с ошибкой).
- Не пиши в \`command\` секреты — плагин-файл хранится в открытом виде; бери их из переменных окружения или файлов пользователя.`;
}
