/**
 * The HTML pages of a chat on the move. A page is a file in this machine's
 * attachments folder, and the activity in the thread only points at it, so a
 * chat that moves without its files shows nothing there. They travel as one
 * JSON file next to the bundle, as stored: the bootstrap is already in them.
 */
import {
  HTML_RENDER_ACTIVITY_KIND,
  type HtmlRenderReference,
  readHtmlRenderReference,
} from "@t3tools/shared/htmlRender";
import { Effect } from "effect";

export interface CarriedPage {
  readonly title: string;
  readonly height: number;
  readonly heights?: HtmlRenderReference["heights"];
  readonly html: string;
}

export function pageReference(activity: {
  readonly kind: string;
  readonly payload: unknown;
}): HtmlRenderReference | null {
  if (activity.kind !== HTML_RENDER_ACTIVITY_KIND) return null;
  return readHtmlRenderReference(activity.payload) ?? null;
}

/**
 * The pages to carry, in timeline order. Newest first against the limit: the
 * page the person saw last is the one they came for.
 */
export function collectPages<E>(input: {
  readonly activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>;
  readonly readPage: (attachmentId: string) => Effect.Effect<string | null, E>;
  readonly maxBytes: number;
}): Effect.Effect<{ readonly pages: ReadonlyArray<CarriedPage>; readonly leftBehind: number }, E> {
  return Effect.gen(function* () {
    const references = input.activities.flatMap((activity) => pageReference(activity) ?? []);
    const pages: CarriedPage[] = [];
    let bytes = 0;
    let leftBehind = 0;
    for (const reference of references.toReversed()) {
      const html = yield* input.readPage(reference.attachmentId);
      const size = html === null ? 0 : Buffer.byteLength(html);
      if (html === null || bytes + size > input.maxBytes) {
        leftBehind += 1;
        continue;
      }
      bytes += size;
      pages.unshift({
        title: reference.title,
        height: reference.height,
        ...(reference.heights ? { heights: reference.heights } : {}),
        html,
      });
    }
    return { pages, leftBehind };
  });
}

/** The file that arrived, read through the same checks as a stored reference. */
export function readPagePack(text: string): ReadonlyArray<CarriedPage> {
  const parsed: unknown = JSON.parse(text);
  const pages = (parsed as { pages?: unknown } | null)?.pages;
  if (!Array.isArray(pages)) return [];
  return pages.flatMap((page: unknown): CarriedPage[] => {
    if (typeof page !== "object" || page === null) return [];
    const { html, ...fields } = page as Record<string, unknown>;
    if (typeof html !== "string") return [];
    const reference = readHtmlRenderReference({
      ...fields,
      attachmentId: "page",
      path: "page.html",
    });
    if (!reference) return [];
    return [
      {
        title: reference.title,
        height: reference.height,
        ...(reference.heights ? { heights: reference.heights } : {}),
        html,
      },
    ];
  });
}
