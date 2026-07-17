# Handoff: Assistant settings must target the selected environment

## Summary

The Assistant settings page is not environment-scoped. In a desktop client connected to a remote environment, saving an assistant's Telegram configuration can send the request to the local (primary) daemon instead of the remote daemon that owns the assistant project.

This makes the UI appear to save successfully while the remote server never receives a connector record. The practical symptom is that Telegram creates no remote thread and the bot never replies; reminders also fail with `No enabled Telegram or Slack connector`.

## Incident evidence (2026-07-13)

- Target environment: `hostkey81337` (`655585cd-d92d-49e9-9d75-39f5b9e141e5`).
- Target project: `assistant-home` / “Assistant”.
- Before repair, the server database contained **zero** rows in `manager_assistant_connectors` and **zero** mapped Telegram threads for this project.
- The assistant's own event log contained the failed `create_reminder` response: `No enabled Telegram or Slack connector is available to deliver the reminder.`
- The active server project default was `codex / gpt-5.4`, while its working assistant thread was `claudeAgent / claude-fable-5`. This is a separate configuration inconsistency that makes new threads select an unintended model.
- Manual server-side repair proved the backend works: a connector record was saved for `assistant-home`, explicitly configured as `hermes / openai/gpt-5.6-terra`, with an allowlisted Telegram chat, and enabled.

## Technical root cause

`apps/web/src/lib/managerApi.ts` implements manager operations through same-origin relative requests:

```ts
fetch("/api/manager/…", { credentials: "include" });
```

There is no `environmentId`, remote base URL, or remote bearer token in this API. Consequently it can only address the daemon serving the renderer's origin (normally the primary/local daemon).

This conflicts with the environment architecture used elsewhere in the app:

- Chat and orchestration commands are scoped through `EnvironmentConnection` / `WsRpcClient`.
- Saved environments retain a remote `httpBaseUrl` and bearer token in `apps/web/src/environments/runtime/catalog.ts`.
- `apps/web/src/environments/remote/api.ts` already contains the authenticated remote-fetch mechanics, but only for auth endpoints.

The route compounds the ambiguity: `apps/web/src/routes/_chat.assistant.$projectId.tsx` identifies an assistant only by `projectId`; it does not carry an environment ID. Project IDs are not globally unique across environments.

## Required fix

### 1. Make the route explicitly environment-scoped

Replace the assistant route with an environment-qualified route, for example:

```
/_chat/assistant/$environmentId/$projectId
```

Pass both values into `AssistantConfig`. Update all navigation and tests that open the Assistant settings page. Do not infer the destination from `activeEnvironmentId`; it can change while a page is mounted.

### 2. Replace same-origin manager fetches with an environment-aware client

Extract the generic authenticated request path from `apps/web/src/environments/remote/api.ts` (currently private as `fetchRemoteJson`) into a reusable environment HTTP client.

The manager client must accept an environment target:

```ts
type ManagerApiTarget =
  | { kind: "primary" }
  | { kind: "saved"; httpBaseUrl: string; bearerToken: string };
```

Resolve it from the explicit `environmentId`:

- primary: same-origin request with credentials/cookies;
- saved: absolute URL plus `Authorization: Bearer <saved environment token>`.

Keep bearer tokens in the existing protected persistence flow. They must never be copied into component state, URLs, logs, or error messages.

Thread the target through every manager operation in `managerApi.ts`, including:

- assistant overview and creation;
- access-token and project allowlist updates;
- Telegram and Slack connector saves;
- assistant file read/write;
- reminders, proposals, and other manager operations exposed from the UI.

### 3. Use the remote server's state for the page

`AssistantConfig` currently calls the same-origin manager API and uses its results to populate fields. After routing, all reads and writes must use the selected environment's target. Display the environment label near the page title (for example, `Assistant · hostkey81337`) so the destination is visible before a user saves a bot token.

### 4. Prevent silent cross-environment saves

- Reject opening the page if the supplied environment connection is not bootstrapped or the saved environment has no bearer session.
- Show a blocking, actionable error such as “Reconnect Hostkey before editing Assistant settings.”
- After every mutation, re-read the overview from the same environment and show its label in the success message.
- Never fall back from a saved environment to primary/local on an authentication or transport error.

## Test plan

1. Unit-test target resolution for a primary and a saved environment; assert that the saved case uses its absolute base URL and bearer header.
2. Unit-test that manager API methods require an explicit target/environment ID.
3. Route test: navigating to an assistant settings page preserves the supplied `environmentId` through refresh and back/forward.
4. Integration test with two mock HTTP daemons:
   - opening Assistant settings for remote loads only remote overview;
   - saving Telegram config sends one request to remote and none to primary;
   - a remote `401` remains an error and never retries against primary.
5. Desktop smoke test with a real saved SSH environment:
   - save a connector on the remote assistant;
   - query remote overview and verify `enabled` / model selection;
   - send a Telegram message and verify the resulting thread has the remote environment ID.

## Acceptance criteria

- A remote assistant page never reads or writes the local manager API.
- Assistant settings URLs are unambiguous across environments.
- A Telegram connector saved while viewing Hostkey creates a record only in Hostkey's `manager_assistant_connectors` table.
- New Telegram threads use the connector's explicit model selection.
- `bun fmt`, `bun lint`, and `bun typecheck` pass after implementation.

## Related files

- `apps/web/src/lib/managerApi.ts`
- `apps/web/src/components/AssistantConfig.tsx`
- `apps/web/src/routes/_chat.assistant.$projectId.tsx`
- `apps/web/src/environments/remote/api.ts`
- `apps/web/src/environments/runtime/catalog.ts`
- `apps/web/src/environments/runtime/service.ts`
- `apps/server/src/manager/http.ts`
- `apps/server/src/manager/Layers/TelegramConnector.ts`
