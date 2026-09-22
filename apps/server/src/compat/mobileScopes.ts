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

/** Все имена скоупов, которые этот сервер вообще знает (= набор owner). */
export const KNOWN_SCOPES: ReadonlySet<string> = new Set(OWNER_SCOPES);

/**
 * Апстрим переименовал session-метод `bearer-session-token` →
 * `bearer-access-token`; их Schema.Literals отвергает наш литерал и валит
 * decode всего AuthSessionState / ServerConfig на клиенте. Транслируем
 * литерал в ответах для апстримных потребителей (bearer-запросы и
 * wsTicket-коннекты). Наши клиенты после расширения союза в contracts
 * переваривают оба написания.
 */
export function toUpstreamSessionMethod<M extends string>(method: M): M | "bearer-access-token" {
  return method === "bearer-session-token" ? "bearer-access-token" : method;
}

export function translateAuthDescriptorForUpstream<
  D extends { readonly sessionMethods: ReadonlyArray<string> },
>(descriptor: D): D {
  return {
    ...descriptor,
    sessionMethods: descriptor.sessionMethods.map(toUpstreamSessionMethod),
  };
}
