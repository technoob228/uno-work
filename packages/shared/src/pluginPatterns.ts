/**
 * Event pattern matching for plugins — one vocabulary for the daemon and the
 * app.
 *
 * The same syntax drives manifest hooks on the server (`hook.on` matched
 * against `OrchestrationEvent.type`) and panel subscriptions in the browser
 * (`subscribe { pattern }` over the panel postMessage bridge), so it lives in
 * shared code instead of being reimplemented on either side.
 *
 * Syntax (deliberately tiny, no globbing):
 * - `"*"` — everything;
 * - `"thread.*"` — prefix match on the dotted namespace;
 * - anything else — exact match.
 */
export function hookMatches(pattern: string, eventType: string): boolean {
  if (pattern === "*") return true;
  if (pattern === eventType) return true;
  return pattern.endsWith(".*") && eventType.startsWith(pattern.slice(0, -1));
}

/** True when at least one of the patterns matches. */
export function anyHookMatches(patterns: Iterable<string>, eventType: string): boolean {
  for (const pattern of patterns) {
    if (hookMatches(pattern, eventType)) return true;
  }
  return false;
}
