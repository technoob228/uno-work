/**
 * POST /api/home/suggestions — body `{"threadIds": ["…"]}` (up to three recent
 * chats Home shows). Answers `{"suggestions": [{threadId, label, prompt}]}`:
 * concrete follow-ups a small model made from the end of those chats
 * (homeSuggestions.ts). Any signed-in session; nothing here changes anything.
 *
 * Cached in memory by (chat, its last update): Home opens often, and the
 * answer only changes when a chat does. No Uno AI (no key, no hours, gateway
 * down) is `{"suggestions": [], "unavailable": true}` — Home just shows no
 * hints from chats.
 */
import { ThreadId } from "@t3tools/contracts";
import { Effect, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { respondToAuthError } from "./auth/http.ts";
import { ServerAuth } from "./auth/Services/ServerAuth.ts";
import {
  MAX_SUGGESTION_CHATS,
  requestSuggestions,
  type HomeSuggestion,
  type SuggestionChat,
} from "./homeSuggestions.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "./serverSettings.ts";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const CACHE_TTL_MS = 6 * 60 * 60_000;
const FAILURE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 50;

const cache = new Map<string, { at: number; ttl: number; suggestions: HomeSuggestion[] }>();
const inFlight = new Map<string, Promise<HomeSuggestion[] | null>>();

export const homeSuggestionsRouteLayer = HttpRouter.add(
  "POST",
  "/api/home/suggestions",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    yield* serverAuth.authenticateHttpRequest(request);
    const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    const rawIds =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>)["threadIds"]
        : null;
    const ids = Array.isArray(rawIds)
      ? [...new Set(rawIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
      : [];
    if (ids.length === 0 || ids.length > MAX_SUGGESTION_CHATS) {
      return HttpServerResponse.jsonUnsafe(
        { error: `Expected {"threadIds": [1..${MAX_SUGGESTION_CHATS} ids]}.` },
        { status: 400, headers: NO_STORE },
      );
    }

    const projections = yield* ProjectionSnapshotQuery;
    const chats: SuggestionChat[] = [];
    const versions: string[] = [];
    for (const id of ids) {
      const detail = yield* projections
        .getThreadDetailById(ThreadId.make(id))
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(detail) || detail.value.archivedAt !== null) continue;
      const thread = detail.value;
      chats.push({
        threadId: id,
        title: thread.title,
        messages: thread.messages.map((message) => ({ role: message.role, text: message.text })),
      });
      versions.push(`${id}@${thread.updatedAt}`);
    }
    if (chats.length === 0) {
      return HttpServerResponse.jsonUnsafe({ suggestions: [] }, { headers: NO_STORE });
    }

    const key = versions.join("|");
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < cached.ttl) {
      return HttpServerResponse.jsonUnsafe(
        cached.suggestions.length === 0 && cached.ttl === FAILURE_TTL_MS
          ? { suggestions: [], unavailable: true }
          : { suggestions: cached.suggestions },
        { headers: NO_STORE },
      );
    }

    const settings = yield* (yield* ServerSettingsService).getSettings.pipe(
      Effect.orElseSucceed(() => null),
    );
    const apiKey = settings?.uno.apiKey ?? "";
    const result = yield* Effect.promise(() => {
      let pending = inFlight.get(key);
      if (!pending) {
        pending = requestSuggestions({ apiKey, chats })
          .then((outcome) => {
            if (cache.size >= CACHE_MAX) cache.clear();
            cache.set(key, {
              at: Date.now(),
              ttl: outcome.ok ? CACHE_TTL_MS : FAILURE_TTL_MS,
              suggestions: outcome.ok ? outcome.suggestions : [],
            });
            return outcome.ok ? outcome.suggestions : null;
          })
          .finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
      }
      return pending;
    });
    return HttpServerResponse.jsonUnsafe(
      result === null ? { suggestions: [], unavailable: true } : { suggestions: result },
      { headers: NO_STORE },
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);
