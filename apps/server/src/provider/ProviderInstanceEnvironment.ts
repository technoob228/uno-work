import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

import { isInheritableHarnessEnv } from "../secretRedaction.ts";

/**
 * Окружение демона без секретов Uno, которые харнессу не нужны
 * (см. isInheritableHarnessEnv). Всё, что харнессу положено, драйвер
 * добавляет поверх явно.
 */
export function sanitizeInheritedHarnessEnvironment(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  let next: NodeJS.ProcessEnv | undefined;
  for (const [name, value] of Object.entries(baseEnv)) {
    if (isInheritableHarnessEnv(name, value)) continue;
    next ??= { ...baseEnv };
    delete next[name];
  }
  return next ?? baseEnv;
}

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const inherited = sanitizeInheritedHarnessEnvironment(baseEnv);
  if (!environment || environment.length === 0) {
    return inherited;
  }

  // Переменные экземпляра задал сам владелец для этого харнесса — их не чистим.
  const next: NodeJS.ProcessEnv = { ...inherited };
  for (const variable of environment) {
    next[variable.name] = variable.value;
  }
  return next;
}
