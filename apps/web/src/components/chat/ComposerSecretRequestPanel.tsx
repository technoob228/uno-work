/**
 * ComposerSecretRequestPanel - Masked input for agent-requested secrets.
 *
 * Renders above the composer like the pending-question quiz. The value is
 * POSTed straight to the environment's `/api/secrets/result`, which writes it
 * into the project env file — it never touches the chat transcript or the
 * agent's context.
 */

import { memo, useState } from "react";
import { LockIcon } from "lucide-react";

import { environmentFetchJson, isEnvironmentHttpError } from "../../environments/http/target";
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
      // 404 = the request was already answered elsewhere (other tab, timeout).
      if (isEnvironmentHttpError(cause) && cause.status === 404) {
        removeSecretRequest(event.requestId);
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
          Secret requested
        </span>
        {pendingCount > 1 ? (
          <span className="flex h-5 items-center rounded-md bg-muted/60 px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground/60">
            1/{pendingCount}
          </span>
        ) : null}
      </div>
      <p className="mt-1.5 text-sm text-foreground/90">
        The agent needs <code className="rounded bg-muted/50 px-1 font-mono">{event.name}</code>
        {event.description ? <> — {event.description}</> : null}
      </p>
      <p className="mt-1 text-xs text-muted-foreground/65">
        Saved into <code className="font-mono">{event.targetFile}</code> in the project — it never
        enters the chat.
      </p>
      <form
        className="mt-3 flex items-center gap-2"
        onSubmit={(formEvent) => {
          formEvent.preventDefault();
          void submit(false);
        }}
      >
        <input
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          autoFocus
          value={value}
          disabled={isSubmitting}
          onChange={(changeEvent) => setValue(changeEvent.currentTarget.value)}
          placeholder={`Paste ${event.name} here`}
          className="h-9 min-w-0 flex-1 rounded-lg border border-border/60 bg-muted/20 px-3 font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted-foreground/45 focus:border-blue-500/40"
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isSubmitting}
          onClick={() => void submit(true)}
        >
          Decline
        </Button>
        <Button type="submit" size="sm" disabled={isSubmitting || value.trim().length === 0}>
          Save
        </Button>
      </form>
      {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
    </div>
  );
});
