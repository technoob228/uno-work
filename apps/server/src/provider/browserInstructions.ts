/**
 * Инструкции для всех харнессов про встроенный браузер Uno Work.
 *
 * Каждый харнесс (Claude / Codex / OpenCode / Uno) получает один и тот же текст
 * через свой механизм системного промпта. Текст рассказывает, как открыть
 * страницу в правой панели приложения через bridge-endpoint, и упоминает
 * `getuno.xyz/llms.txt` для задач, связанных с инфраструктурой.
 */
import * as FS from "node:fs";
import * as Path from "node:path";

import {
  BROWSER_BRIDGE_COMMAND_PATH,
  BROWSER_BRIDGE_OPEN_PATH,
  BROWSER_BRIDGE_TOKEN_ENV,
  BROWSER_BRIDGE_URL_ENV,
} from "../browserBridge.ts";

/**
 * Возвращает блок инструкций или undefined, если bridge выключен (нет URL).
 * `baseUrl` подставляется в пример curl, чтобы модель не угадывала порт.
 */
export function buildBrowserInstructions(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  return `## Встроенный браузер Uno Work

У приложения есть встроенный браузер в правой панели предпросмотра. Ты можешь открыть в нём любую веб-страницу для пользователя — например, чтобы показать документацию, дашборд, локальный dev-сервер или результат деплоя.

Чтобы открыть URL в браузере приложения, отправь POST-запрос на bridge-endpoint. Адрес и токен доступны в переменных окружения \`${BROWSER_BRIDGE_URL_ENV}\` и \`${BROWSER_BRIDGE_TOKEN_ENV}\`:

\`\`\`bash
curl -fsS -X POST "$${BROWSER_BRIDGE_URL_ENV}${BROWSER_BRIDGE_OPEN_PATH}" \\
  -H "Authorization: Bearer $${BROWSER_BRIDGE_TOKEN_ENV}" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com"}'
\`\`\`

Открывай страницу, когда пользователь просит «открой … в браузере», когда нужно показать запущенный локально сервис, или когда визуальный результат полезнее текстового описания. Открывай только http(s)-адреса.

Если нужно управлять уже открытой страницей, используй command-endpoint. Он вернёт JSON-результат после выполнения команды в активной вкладке встроенного браузера:

\`\`\`bash
curl -fsS -X POST "$${BROWSER_BRIDGE_URL_ENV}${BROWSER_BRIDGE_COMMAND_PATH}" \\
  -H "Authorization: Bearer $${BROWSER_BRIDGE_TOKEN_ENV}" \\
  -H "Content-Type: application/json" \\
  -d '{"command":"state","timeoutMs":5000}'
\`\`\`

Доступные команды: \`openUrl\`, \`state\`, \`screenshot\`, \`click\`, \`clickText\`, \`type\`, \`press\`, \`navigate\`, \`reload\`, \`back\`, \`forward\`, \`evaluate\`. Предпочитай точные selector/text команды и не выводи в логи пароли, токены или содержимое приватных полей.

## Инфраструктура через Uno

Если задача связана с инфраструктурой (VPS, прокси, SMS, хостинг, виртуальные карты), сверься с машиночитаемым описанием продуктов Uno: https://getuno.xyz/llms.txt — там актуальные возможности и эндпоинты.`;
}

/**
 * Записывает инструкции в файл и возвращает его путь — для харнессов
 * (OpenCode/Uno), у которых системные инструкции задаются путём к файлу, а не
 * инлайн-текстом. Возвращает undefined, если bridge выключен. Идемпотентно
 * перезаписывает файл при каждом старте инстанса.
 */
export function writeBrowserInstructionsFile(input: {
  readonly stateDir: string;
  readonly baseUrl: string | undefined;
}): string | undefined {
  const instructions = buildBrowserInstructions(input.baseUrl);
  if (!instructions) return undefined;
  const filePath = Path.join(input.stateDir, "uno-browser-instructions.md");
  try {
    FS.mkdirSync(input.stateDir, { recursive: true });
    FS.writeFileSync(filePath, `${instructions}\n`, "utf8");
    return filePath;
  } catch {
    return undefined;
  }
}
