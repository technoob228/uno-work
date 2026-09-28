/**
 * Uno gateway model ids as the harnesses show them. Uno Code slugs carry the
 * harness provider (`uno/anthropic/…`, `uno-russia/…`); Hermes lists the
 * gateway ids themselves.
 */
const UNO_HARNESS_PROVIDER_PREFIXES = ["uno/", "uno-russia/"] as const;

/** `uno/anthropic/claude-opus-5.5` → `anthropic/claude-opus-5.5`; gateway ids stay as they are. */
export function unoGatewayModelId(slug: string): string {
  const lower = slug.toLowerCase();
  for (const prefix of UNO_HARNESS_PROVIDER_PREFIXES) {
    if (lower.startsWith(prefix)) return lower.slice(prefix.length);
  }
  return lower;
}
