/**
 * Mobile-compat: скоупы апстримного T3-клиента. У нашего сервера скоупов
 * нет — доступ определяется ролью сессии, поэтому маппим роль в наборы,
 * литерально совпадающие с upstream AuthStandardClientScopes /
 * AuthAdministrativeScopes. Мобилке эти строки нужны только чтобы включить
 * свои фичи (composer, терминал, ревью); реальный доступ по-прежнему
 * ограничивает наша роль.
 */
const STANDARD_CLIENT_SCOPES = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "relay:read",
] as const;

const OWNER_SCOPES = [
  ...STANDARD_CLIENT_SCOPES,
  "access:read",
  "access:write",
  "relay:write",
] as const;

export function scopesForSessionRole(role: string | undefined): ReadonlyArray<string> {
  return role === "owner" ? OWNER_SCOPES : STANDARD_CLIENT_SCOPES;
}
