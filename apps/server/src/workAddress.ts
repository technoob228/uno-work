/**
 * The address the person opens this computer's Uno Work at
 * (`https://<label>.uno4.work`), learned from the owner's own requests: the
 * console forwards them with `X-Forwarded-Host`.
 *
 * Why (P16, 28.10): asked "open it in my browser", an agent had no link to
 * give — it grepped Uno Work's own build for a "private link" and then asked
 * the person to paste their uno4.work address. The tools now hand out a link
 * to the app inside the person's Uno Work themselves (`workAppLink`).
 *
 * Only an authenticated request may set it (portPreviewHttp.ts): a forged
 * header can't point the agent's links at someone else's address.
 */
import { WORK_APP_LINK_PATH } from "@t3tools/shared/portPreview";

/** `<label>.uno4.work` (the account's own address) or the shared `app.uno4.work`. */
const WORK_HOST = /^(?:[bcdfghjkmnpqrstvwxz2-9]{10}|app)\.uno4\.work$/;

/** The Work host of a request's `X-Forwarded-Host` (or `Host`); null for anything else. */
export function workHostOf(headers: {
  readonly [name: string]: string | ReadonlyArray<string> | undefined;
}): string | null {
  const raw = headers["x-forwarded-host"] ?? headers["host"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const host = value.split(",")[0]!.trim().toLowerCase().replace(/:\d+$/, "");
  return WORK_HOST.test(host) ? host : null;
}

let rememberedHost: string | null = null;

/**
 * Should this host replace the remembered one? The account's own address
 * wins over the shared `app.uno4.work` (which only redirects there).
 */
export function preferWorkHost(current: string | null, next: string): boolean {
  if (current === next) return false;
  if (current !== null && next === "app.uno4.work" && current !== "app.uno4.work") return false;
  return true;
}

export function rememberWorkHost(host: string): void {
  if (preferWorkHost(rememberedHost, host)) rememberedHost = host;
}

/** Wants a check: a Work host this daemon hasn't settled on yet. */
export function isNewWorkHost(host: string): boolean {
  return preferWorkHost(rememberedHost, host);
}

/** `https://<label>.uno4.work`, once the person opened Uno Work here; else null. */
export function currentWorkAddress(): string | null {
  return rememberedHost ? `https://${rememberedHost}` : null;
}

/** Tests only. */
export function resetWorkAddressForTests(): void {
  rememberedHost = null;
}

/** A link that opens an app of this computer inside the person's Uno Work. */
export function workAppLink(workAddress: string, appId: string): string {
  return `${workAddress}${WORK_APP_LINK_PATH}?app=${encodeURIComponent(appId)}`;
}
