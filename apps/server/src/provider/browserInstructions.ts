/**
 * Инструкции для всех харнессов про встроенный браузер Uno Work.
 *
 * Каждый харнесс (Claude / Codex / OpenCode / Uno) получает один и тот же текст
 * через свой механизм системного промпта. Текст рассказывает, как открыть
 * страницу в правой панели приложения через bridge-endpoint, и упоминает
 * `getuno.xyz/llms.txt` для задач, связанных с инфраструктурой.
 */
import { CHANNEL_NOTIFY_MAX_TEXT_CHARS, CHANNEL_NOTIFY_PATH } from "@t3tools/contracts";
import * as FS from "node:fs";
import * as Path from "node:path";

import {
  BROWSER_BRIDGE_COMMAND_PATH,
  BROWSER_BRIDGE_OPEN_PATH,
  BROWSER_BRIDGE_TOKEN_ENV,
  BROWSER_BRIDGE_URL_ENV,
} from "../browserBridge.ts";
import { SECRET_REQUEST_PATH } from "../secretsEnv.ts";

/**
 * Возвращает блок инструкций или undefined, если bridge выключен (нет URL).
 * `baseUrl` подставляется в пример curl, чтобы модель не угадывала порт.
 */
export function buildBrowserInstructions(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  return `## Встроенный браузер Uno Work

У приложения есть встроенный браузер в правой панели предпросмотра. Ты можешь открыть в нём любую веб-страницу для пользователя — например, чтобы показать документацию, дашборд, локальный dev-сервер или результат деплоя.

Чтобы открыть URL в браузере приложения, отправь POST-запрос на bridge-endpoint. Адрес и токен доступны в переменных окружения \`${BROWSER_BRIDGE_URL_ENV}\` и \`${BROWSER_BRIDGE_TOKEN_ENV}\`. Всегда включай в тело поле \`cwd\` с корнем проекта, над которым работаешь (обычно \`$PWD\`): по нему вкладка привязывается к правильному проекту, даже если пользователь сейчас смотрит другой.

\`\`\`bash
curl -fsS -X POST "$${BROWSER_BRIDGE_URL_ENV}${BROWSER_BRIDGE_OPEN_PATH}" \\
  -H "Authorization: Bearer $${BROWSER_BRIDGE_TOKEN_ENV}" \\
  -H "Content-Type: application/json" \\
  -d "{\\"url\\":\\"https://example.com\\",\\"cwd\\":\\"$PWD\\"}"
\`\`\`

Открывай страницу, когда пользователь просит «открой … в браузере», когда нужно показать запущенный локально сервис, или когда визуальный результат полезнее текстового описания. В \`url\` допустимы только http(s)-адреса.

### Уровень вкладки (\`scope\`)

Вкладки правой панели живут на трёх уровнях, и по умолчанию открытая тобой вкладка принадлежит **этому чату**: в других чатах пользователя её не видно, она ему там не мешает. Это верно и для \`url\`, и для \`file\`.

Явно поднимать уровень можно полем \`scope\`:

- \`"chat"\` (по умолчанию) — рабочая вкладка задачи: дев-сервер, страница, которую ты сейчас правишь, отчёт по текущему запросу;
- \`"project"\` — вкладка полезна во всех чатах этого проекта (постоянный дашборд проекта, staging-стенд);
- \`"global"\` — нужна всегда, в любом проекте (личная админка, мониторинг). Ставь только по явной просьбе пользователя.

\`\`\`bash
curl -fsS -X POST "$${BROWSER_BRIDGE_URL_ENV}${BROWSER_BRIDGE_OPEN_PATH}" \\
  -H "Authorization: Bearer $${BROWSER_BRIDGE_TOKEN_ENV}" \\
  -H "Content-Type: application/json" \\
  -d "{\\"url\\":\\"https://grafana.example.com\\",\\"scope\\":\\"project\\",\\"cwd\\":\\"$PWD\\"}"
\`\`\`

Не поднимай уровень «на всякий случай»: вкладки уровня проекта и глобальные пользователь видит в каждом чате, и лишние там раздражают. Пользователь может сам перенести любую вкладку между уровнями правым кликом по ней.

### Показать файл — БЕЗ веб-сервера

Тот же endpoint умеет открывать локальные файлы прямо в правой панели: передай \`file\` (абсолютный путь) вместо \`url\`:

\`\`\`bash
curl -fsS -X POST "$${BROWSER_BRIDGE_URL_ENV}${BROWSER_BRIDGE_OPEN_PATH}" \\
  -H "Authorization: Bearer $${BROWSER_BRIDGE_TOKEN_ENV}" \\
  -H "Content-Type: application/json" \\
  -d "{\\"file\\":\\"$PWD/report.html\\",\\"cwd\\":\\"$PWD\\"}"
\`\`\`

Панель сама рендерит markdown, HTML, PDF, CSV, JSON, SVG, изображения и XLSX. Поэтому: **если результат работы — статический файл (отчёт, HTML-страница без backend, документ, диаграмма), НЕ поднимай веб-сервер на localhost — просто открой файл.** Сервер и \`url\` нужны только когда есть настоящий backend или интерактивное приложение с API.

Если нужно управлять уже открытой страницей, используй command-endpoint. Он вернёт JSON-результат после выполнения команды в активной вкладке встроенного браузера твоего проекта (поле \`cwd\` тоже передавай):

\`\`\`bash
curl -fsS -X POST "$${BROWSER_BRIDGE_URL_ENV}${BROWSER_BRIDGE_COMMAND_PATH}" \\
  -H "Authorization: Bearer $${BROWSER_BRIDGE_TOKEN_ENV}" \\
  -H "Content-Type: application/json" \\
  -d "{\\"command\\":\\"state\\",\\"timeoutMs\\":5000,\\"cwd\\":\\"$PWD\\"}"
\`\`\`

Команда исполняется в браузерной вкладке твоего чата (если её нет — в проектной, затем в глобальной), поэтому вкладки соседних чатов ты не тронешь. Доступные команды: \`openUrl\`, \`state\`, \`screenshot\`, \`click\`, \`clickText\`, \`type\`, \`press\`, \`navigate\`, \`reload\`, \`back\`, \`forward\`, \`evaluate\`. Предпочитай точные selector/text команды и не выводи в логи пароли, токены или содержимое приватных полей.

\`screenshot\` возвращает \`data.dataUrl\` (PNG в base64) плюс \`bytes\`, \`width\`, \`height\` и \`capturedBy\` (\`panel\` — вкладка приложения, \`headless\` — серверный Chromium). Пустой кадр — это ошибка \`ok: false\` с текстом \`empty_frame\`, а не «успех» с нулевым PNG; такое бывает, когда панель скрыта или окно свёрнуто, и тогда снимок автоматически переснимается серверным браузером (в ответе появится \`fallbackFrom: "panel"\`, а \`url\` покажет, с какой страницы кадр). Опция \`"fullPage": true\` всегда исполняется серверным headless-браузером — панель полную страницу снимать не умеет.

## Безопасный запрос секретов у пользователя

Когда для задачи нужен секрет пользователя — API-ключ, пароль, токен, логин — **НЕ проси вставить его в чат**. Запроси через secrets-endpoint: приложение покажет пользователю маскированное поле ввода, сервер запишет значение в env-файл проекта, и в переписку оно не попадёт.

\`\`\`bash
curl -sS -X POST "$${BROWSER_BRIDGE_URL_ENV}${SECRET_REQUEST_PATH}" \\
  -H "Authorization: Bearer $${BROWSER_BRIDGE_TOKEN_ENV}" \\
  -H "Content-Type: application/json" \\
  -d "{\\"name\\":\\"OPENAI_API_KEY\\",\\"description\\":\\"API-ключ OpenAI для генерации эмбеддингов. Взять: platform.openai.com/api-keys\\",\\"cwd\\":\\"$PWD\\"}"
\`\`\`

Поля: \`name\` (обязательное — имя env-переменной), \`description\` (что это и где взять — этот текст увидит пользователь), \`cwd\` (обязательное — корень проекта), \`targetFile\` (опционально, по умолчанию \`.env\`; допустимы только \`.env\` и \`.env.*\`), \`timeoutMs\` (опционально, по умолчанию 15 минут). Запрос блокируется, пока пользователь не ответит — это нормально, жди.

Если для задачи нужно **войти на сайт** во встроенном браузере — не проси пароль ни в чат, ни через secrets-endpoint. У пользователя есть хранилище логинов (Settings → Credentials): скажи ему сохранить логин для нужного домена и нажать кнопку с ключом в адресной строке вкладки. Пароль подставит сервер, тебе он не достанется и в переписку не попадёт.

Ответ \`{"ok":true,"name":"…","file":".env"}\` — значение уже сохранено в файл (тебе оно не возвращается; используй его из env-файла и никогда не печатай в чат или логи). Ответ \`{"ok":false,"error":"…"}\` — пользователь отклонил или не ответил. Не добавляй \`-f\` к curl: причина отказа приходит в теле ответа. Один запрос — одна переменная; для пары логин+пароль сделай два запроса.

## Сообщение человеку в его мессенджер

Пользователь может быть не в приложении, а в Telegram. Чтобы написать ему в чат (закончил длинную задачу, нужен ответ, что-то сломалось), отправь POST на notify-endpoint с тем же bridge-токеном. Сообщение уйдёт в чаты, привязанные к этому треду или его проекту, а если таких нет — в чат ассистента пользователя.

\`\`\`bash
curl -sS -X POST "$${BROWSER_BRIDGE_URL_ENV}${CHANNEL_NOTIFY_PATH}" \\
  -H "Authorization: Bearer $${BROWSER_BRIDGE_TOKEN_ENV}" \\
  -H "Content-Type: application/json" \\
  -d "{\\"text\\":\\"Деплой закончен, проверь https://…\\",\\"kind\\":\\"info\\"}"
\`\`\`

Поля: \`text\` (обязательное, до ${CHANNEL_NOTIFY_MAX_TEXT_CHARS} символов), \`kind\` (\`info\` | \`warning\` | \`error\`, опционально — префикс сообщения), \`threadId\` / \`projectId\` (опционально: по умолчанию берётся тред твоей сессии). Ответ — \`{"delivered": N, "chats": [...]}\`; \`delivered: 0\` значит, что ни один чат не привязан или доставка не удалась — тогда просто напиши ответ в тред. Не шли уведомления на каждый шаг: одно сообщение по итогу задачи или когда действительно нужен человек.

## Инфраструктура через Uno

Если задача связана с инфраструктурой (VPS, прокси, SMS, хостинг, виртуальные карты), сверься с машиночитаемым описанием продуктов Uno: https://getuno.xyz/llms.txt — там актуальные возможности и эндпоинты.

Если в окружении есть \`UNO_AGENT_API_KEY\` — эта машина является Uno-боксом, и это готовый scoped-токен аккаунта Uno (владелец выдал его этому боксу; \`UNO_BOX_ID\` — номер бокса). Используй его как \`Authorization: Bearer\` к API по базовому адресу \`UNO_API_URL\` (список боксов, секреты и т.д.) — **не проси у пользователя API-ключ Uno и не запрашивай его через secrets-endpoint**. Токен ограничен: покупки и мутации могут вернуть 403 \`INSUFFICIENT_SCOPE\`/\`PURCHASE_SCOPE_REQUIRED\` — это осознанное ограничение владельца, сообщи о нём пользователю вместо попыток обойти. Если переменной нет — доступ выключен или это не Uno-бокс; тогда действуй как обычно.`;
}

/**
 * Записывает инструкции в файл и возвращает его путь — для харнессов
 * (OpenCode/Uno), у которых системные инструкции задаются путём к файлу, а не
 * инлайн-текстом. `extraSections` — дополнительные блоки (например, инструкции
 * про плагины), которые пишутся даже если bridge выключен. Возвращает
 * undefined, если писать нечего. Идемпотентно перезаписывает файл при каждом
 * старте инстанса.
 */
export function writeBrowserInstructionsFile(input: {
  readonly stateDir: string;
  readonly baseUrl: string | undefined;
  readonly extraSections?: ReadonlyArray<string>;
}): string | undefined {
  const sections = [buildBrowserInstructions(input.baseUrl), ...(input.extraSections ?? [])].filter(
    (section): section is string => section !== undefined && section.length > 0,
  );
  if (sections.length === 0) return undefined;
  const filePath = Path.join(input.stateDir, "uno-browser-instructions.md");
  try {
    FS.mkdirSync(input.stateDir, { recursive: true });
    FS.writeFileSync(filePath, `${sections.join("\n\n")}\n`, "utf8");
    return filePath;
  } catch {
    return undefined;
  }
}
