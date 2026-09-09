/**
 * Автозаполнение сохранённого логина в открытой вкладке браузера.
 *
 * Ключевое свойство: пароль читает и подставляет сервер. Клиент присылает id
 * креда и вкладку-адресата, сервер достаёт секрет из `ServerSecretStore` и
 * отправляет исполнителю (панель приложения или headless-браузер) готовую
 * команду `fillCredential`. В ответ RPC уходит только `{filled}` — пароль не
 * возвращается клиенту, не попадает в транскрипт чата и не виден модели.
 *
 * Команда `fillCredential` намеренно НЕ входит в allowlist bridge-эндпоинта
 * (`isAllowedBridgeCommand`), поэтому харнесс её вызвать не может: заполнение
 * инициирует только человек из панели.
 *
 * @module CredentialsFill
 */
import type { CredentialFillPayload, CredentialFillResult } from "@t3tools/contracts";
import { Effect } from "effect";

import { BrowserBridge } from "./browserBridge.ts";
import { executeBridgeCommand } from "./browserCommandRouter.ts";
import { CredentialsVaultService } from "./credentialsVault.ts";
import { ServerBrowser } from "./serverBrowser.ts";
import { ServerSettingsService } from "./serverSettings.ts";

export const fillCredentialInBrowser = (
  payload: CredentialFillPayload,
): Effect.Effect<
  CredentialFillResult,
  never,
  CredentialsVaultService | BrowserBridge | ServerBrowser | ServerSettingsService
> =>
  Effect.gen(function* () {
    const vault = yield* CredentialsVaultService;
    const credentials = yield* vault.list;
    const metadata = credentials.find((candidate) => candidate.id === payload.id);
    if (!metadata) {
      return {
        filled: false,
        error: "Сохранённый логин не найден.",
      } satisfies CredentialFillResult;
    }
    const password = yield* vault.reveal(payload.id);
    if (password === null) {
      return {
        filled: false,
        error: "Пароль не удалось прочитать из хранилища сервера.",
      } satisfies CredentialFillResult;
    }
    const result = yield* executeBridgeCommand(
      {
        command: "fillCredential",
        tabId: payload.tabId,
        username: metadata.username,
        password,
      },
      {
        ...(payload.threadId ? { threadId: payload.threadId } : {}),
        ...(payload.cwd ? { cwd: payload.cwd } : {}),
      },
    );
    return (
      result.ok
        ? { filled: true }
        : { filled: false, ...(result.error ? { error: result.error } : {}) }
    ) satisfies CredentialFillResult;
  }).pipe(
    // Ошибка хранилища не должна ронять RPC: пользователю нужен текст причины,
    // а не красный тост «unknown error».
    Effect.catch((error) =>
      Effect.succeed({
        filled: false,
        error: error.message,
      } satisfies CredentialFillResult),
    ),
  );
