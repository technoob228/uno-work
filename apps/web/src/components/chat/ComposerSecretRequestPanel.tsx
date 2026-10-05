/**
 * ComposerSecretRequestPanel - Masked input for agent-requested secrets.
 *
 * Renders above the composer like the pending-question quiz. The value is
 * POSTed straight to the environment's `/api/secrets/result`, which writes it
 * into the project env file — it never touches the chat transcript (the
 * agent can still read the file). The card names the asking thread and the
 * exact file so the person knows who gets what, and where.
 */

import type { ThreadId } from "@t3tools/contracts";
import {
  ASSISTANT_BOT_CARD,
  humanSecretLabel,
  secretHelp,
} from "@t3tools/shared/secretRequestCopy";
import { memo, useState } from "react";
import { ExternalLinkIcon, LockIcon } from "lucide-react";

import { environmentFetchJson, isEnvironmentHttpError } from "../../environments/http/target";
import { useThreadTitle } from "../../hooks/useThreadTitle";
import {
  type ActiveSecretRequest,
  removeSecretRequest,
  useSecretRequests,
} from "../../secretRequestStore";
import { Button } from "../ui/button";

const SECRET_RESULT_PATH = "/api/secrets/result";

export const ComposerSecretRequestPanel = memo(function ComposerSecretRequestPanel({
  threadId,
}: {
  threadId: string | undefined;
}) {
  const requests = useSecretRequests();
  const matching = requests.filter((request) => {
    const requestThreadId = request.event.context?.threadId;
    return requestThreadId === undefined || requestThreadId === threadId;
  });
  const active = matching[0];
  if (!active) return null;
  return (
    <SecretRequestCard
      key={active.event.requestId}
      request={active}
      pendingCount={matching.length}
    />
  );
});

const SecretRequestCard = memo(function SecretRequestCard({
  request,
  pendingCount,
}: {
  request: ActiveSecretRequest;
  pendingCount: number;
}) {
  const [value, setValue] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { event } = request;
  const requesterThreadId = event.context?.threadId;
  const requesterTitle = useThreadTitle(
    request.environmentId,
    (requesterThreadId ?? null) as ThreadId | null,
  );
  const requester =
    requesterTitle ?? (requesterThreadId ? `chat ${requesterThreadId}` : "an unidentified session");
  const targetPath = homeRelativePath(secretTargetPath(event.cwd, event.targetFile));
  const label = humanSecretLabel(event.name);
  // A Telegram bot token: the one step only the person can do, with its button.
  const help = secretHelp(event.name);
  // The assistant's own bot (assistant_connect): no file, its own words.
  const assistantBot = event.purpose === "assistant-telegram-bot";

  const submit = async (decline: boolean) => {
    if (isSubmitting) return;
    if (!decline && value.trim().length === 0) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await environmentFetchJson<{ ok: boolean }>({
        environmentId: request.environmentId,
        pathname: SECRET_RESULT_PATH,
        method: "POST",
        body: decline
          ? { requestId: event.requestId, responseToken: event.responseToken, decline: true }
          : { requestId: event.requestId, responseToken: event.responseToken, value },
      });
      removeSecretRequest(event.requestId);
    } catch (cause) {
      if (isEnvironmentHttpError(cause) && cause.status === 404) {
        // The server no longer waits on this request (timeout, supersede, or
        // another tab answered). A decline can vanish silently, but a typed-in
        // value must not: tell the user instead of discarding their input.
        if (decline) {
          removeSecretRequest(event.requestId);
          return;
        }
        setError(
          "This request has expired — nothing was saved. Ask the agent to request the secret again.",
        );
        setIsSubmitting(false);
        return;
      }
      setError(cause instanceof Error ? cause.message : String(cause));
      setIsSubmitting(false);
    }
  };

  return (
    <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20 px-4 py-3 sm:px-5">
      <div className="flex items-center gap-2">
        <LockIcon className="size-3.5 text-muted-foreground/60" />
        <span className="text-[11px] font-semibold tracking-widest text-muted-foreground/50 uppercase">
          {assistantBot ? "Telegram" : "Secret requested"}
        </span>
        {pendingCount > 1 ? (
          <span className="flex h-5 items-center rounded-md bg-muted/60 px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground/60">
            1/{pendingCount}
          </span>
        ) : null}
      </div>
      <p className="mt-1.5 text-sm text-foreground/90" data-testid="secret-request-title">
        {assistantBot ? (
          ASSISTANT_BOT_CARD.title
        ) : label === event.name ? (
          <>
            The agent needs <code className="rounded bg-muted/50 px-1 font-mono">{event.name}</code>
          </>
        ) : (
          <>Uno needs your {label}</>
        )}
        {event.description && !assistantBot ? <> — {event.description}</> : null}
      </p>
      {help ? (
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
          <a
            href={help.url}
            target="_blank"
            rel="noreferrer"
            data-testid="secret-help-link"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-accent"
          >
            {help.label}
            <ExternalLinkIcon className="size-3.5 text-muted-foreground" />
          </a>
          <ol className="list-decimal pl-4 text-xs leading-relaxed text-muted-foreground">
            {help.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      ) : null}
      {assistantBot ? (
        <p className="mt-2 text-xs text-muted-foreground/65">{ASSISTANT_BOT_CARD.note}</p>
      ) : (
        <>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
            <dt className="text-muted-foreground/65">Asked by</dt>
            <dd className="min-w-0 truncate font-medium text-foreground/90" title={requester}>
              {requester}
            </dd>
            <dt className="text-muted-foreground/65">Saved to</dt>
            <dd className="min-w-0 break-all font-mono text-foreground/90">{targetPath}</dd>
          </dl>
          <p className="mt-1 text-xs text-muted-foreground/65">
            Not the chat. The agent can read it from this file.
          </p>
        </>
      )}
      {/*
        Deliberately not a <form>: the panel renders inside the composer's
        <form>, and Chromium does not propagate `submit` out of a nested form,
        so React's delegated onSubmit never ran — Enter/Save did a native GET
        submit that reloaded the whole app and dropped the pasted value.
        Enter is handled on the input instead; preventDefault also stops the
        implicit submission of the outer composer form.
      */}
      <div className="mt-3 flex items-center gap-2">
        <input
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          autoFocus
          value={value}
          disabled={isSubmitting}
          onChange={(changeEvent) => setValue(changeEvent.currentTarget.value)}
          onKeyDown={(keyEvent) => {
            if (keyEvent.key !== "Enter" || keyEvent.nativeEvent.isComposing) return;
            keyEvent.preventDefault();
            keyEvent.stopPropagation();
            void submit(false);
          }}
          placeholder={
            assistantBot
              ? ASSISTANT_BOT_CARD.placeholder
              : label === event.name
                ? `Paste ${event.name} here`
                : `Paste the ${label} here`
          }
          className="h-9 min-w-0 flex-1 rounded-lg border border-border/60 bg-muted/20 px-3 font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted-foreground/45 focus:border-blue-500/40"
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isSubmitting}
          onClick={() => void submit(true)}
        >
          {assistantBot ? "Not now" : "Decline"}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={isSubmitting || value.trim().length === 0}
          onClick={() => void submit(false)}
        >
          {assistantBot ? "Connect" : "Save"}
        </Button>
      </div>
      {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
    </div>
  );
});

/** Full path of the env file the server writes: the request's folder + file name. */
export function secretTargetPath(cwd: string, targetFile: string): string {
  const folder = cwd.replace(/[/\\]+$/, "");
  return folder.length > 0 ? `${folder}/${targetFile}` : targetFile;
}

/** The home folder as `~` ("~/projects/bot/.env"), never `/home/unowork/…`. */
export function homeRelativePath(path: string): string {
  return path.replace(/^\/home\/[^/]+(?=\/|$)/u, "~").replace(/^\/Users\/[^/]+(?=\/|$)/u, "~");
}
