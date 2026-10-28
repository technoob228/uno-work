/**
 * ComposerSecretRequestPanel - Masked input for agent-requested secrets.
 *
 * Renders above the composer like the pending-question quiz. The value is
 * POSTed straight to the environment's `/api/secrets/result`, which writes it
 * into the project env file — it never touches the chat transcript (the
 * agent can still read the file). The card names the asking thread and the
 * exact file so the person knows who gets what, and where.
 *
 * P15 (28.10): the field is not a password field — Chrome offered the saved
 * Uno Work password for "Paste the Stripe secret key" — and once the agent's
 * turn is over the card says the key is still wanted and what saving it does
 * (the request stays open; the answer comes back to the chat as a message).
 */

import type { ThreadId } from "@t3tools/contracts";
import {
  ASSISTANT_BOT_CARD,
  humanSecretLabel,
  secretHelp,
} from "@t3tools/shared/secretRequestCopy";
import { memo, useState, type CSSProperties } from "react";
import { ExternalLinkIcon, EyeIcon, EyeOffIcon, LockIcon } from "lucide-react";

import { environmentFetchJson, isEnvironmentHttpError } from "../../environments/http/target";
import { useThreadTitle } from "../../hooks/useThreadTitle";
import {
  type ActiveSecretRequest,
  removeSecretRequest,
  useSecretRequests,
} from "../../secretRequestStore";
import { Button } from "../ui/button";

const SECRET_RESULT_PATH = "/api/secrets/result";

/**
 * Mask the value with CSS on a plain text field where the browser can: a
 * password field makes password managers offer the site's saved password.
 * Firefox without `-webkit-text-security` keeps a password field.
 */
function canMaskTextField(): boolean {
  return typeof CSS !== "undefined" && CSS.supports("-webkit-text-security", "disc");
}

export const ComposerSecretRequestPanel = memo(function ComposerSecretRequestPanel({
  threadId,
  agentWorking = false,
}: {
  threadId: string | undefined;
  /** The chat on screen is working right now (its turn isn't over). */
  agentWorking?: boolean;
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
      agentWorking={agentWorking}
    />
  );
});

const SecretRequestCard = memo(function SecretRequestCard({
  request,
  pendingCount,
  agentWorking,
}: {
  request: ActiveSecretRequest;
  pendingCount: number;
  agentWorking: boolean;
}) {
  const [value, setValue] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [maskWithCss] = useState(canMaskTextField);
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
          <p
            className="mt-2 flex items-start gap-1.5 text-xs text-foreground/80"
            data-testid="secret-request-status"
          >
            <span
              aria-hidden
              className={`mt-1 size-1.5 shrink-0 rounded-full ${agentWorking ? "bg-sky-500" : "bg-amber-500"}`}
            />
            {secretRequestStatusLine(agentWorking)}
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
        <div className="relative min-w-0 flex-1">
        <input
          // A plain text field masked with CSS: password managers leave it alone.
          type={maskWithCss || revealed ? "text" : "password"}
          name="uno-secret-value"
          autoComplete={maskWithCss ? "off" : "new-password"}
          autoCorrect="off"
          autoCapitalize="off"
          data-1p-ignore="true"
          data-lpignore="true"
          data-bwignore="true"
          data-form-type="other"
          aria-label={assistantBot ? "Bot token" : `${label} value`}
          style={
            maskWithCss && !revealed
              ? ({ WebkitTextSecurity: "disc" } as CSSProperties)
              : undefined
          }
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
          className="h-9 w-full rounded-lg border border-border/60 bg-muted/20 pr-9 pl-3 font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted-foreground/45 focus:border-blue-500/40"
        />
        {value.length > 0 ? (
          <button
            type="button"
            onClick={() => setRevealed((shown) => !shown)}
            aria-label={revealed ? "Hide" : "Show"}
            title={revealed ? "Hide" : "Show what you pasted"}
            className="absolute top-1/2 right-1.5 inline-flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {revealed ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
          </button>
        ) : null}
        </div>
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

/**
 * What happens with the request now (P15, 28.10: after "Done" the card hung
 * on with no word on whether anyone still waits for the key). The request
 * stays open after the agent's turn; a later answer reaches the chat as a
 * message and the agent goes on from there.
 */
export function secretRequestStatusLine(agentWorking: boolean): string {
  return agentWorking
    ? "Uno picks it up as soon as you save it."
    : "Still needed. Uno finished this turn without it — save it any time, and Uno gets a message in this chat and carries on.";
}

/** Full path of the env file the server writes: the request's folder + file name. */
export function secretTargetPath(cwd: string, targetFile: string): string {
  const folder = cwd.replace(/[/\\]+$/, "");
  return folder.length > 0 ? `${folder}/${targetFile}` : targetFile;
}

/** The home folder as `~` ("~/projects/bot/.env"), never `/home/unowork/…`. */
export function homeRelativePath(path: string): string {
  return path.replace(/^\/home\/[^/]+(?=\/|$)/u, "~").replace(/^\/Users\/[^/]+(?=\/|$)/u, "~");
}
