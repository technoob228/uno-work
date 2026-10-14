/**
 * "What powers your assistant" (Misha 14.10): Uno AI, the person's own
 * Claude or ChatGPT plan, or their own key — four cards, one tap. Used in
 * Settings → AI and on the new-assistant card.
 *
 * A plan that isn't signed in yet signs in from the card and switches the
 * assistant to it as soon as the sign-in lands:
 * - Claude — Claude Code's own sign-in on this computer (the same dialog as
 *   Settings → AI → Agents); the assistant runs it through Nous' official
 *   Hermes plugin.
 * - ChatGPT — the assistant's own sign-in (a page and a code), apart from the
 *   Codex CLI's.
 *
 * One choice per computer: every assistant chat on it runs on the same AI.
 * An older daemon (no `subscriptions` in its status) gets Uno AI and keys only.
 *
 * @module components/assistant/AssistantPowerPicker
 */
import {
  AI_PROVIDER_LABELS,
  type AssistantLlmProvider,
  type AssistantSignInStatus,
  BYOK_PROVIDER_IDS,
  type EnvironmentId,
  isSubscriptionLlmProvider,
  type SubscriptionLlmProvider,
  type SubscriptionLlmStatus,
} from "@t3tools/contracts";
import { assistantModelLabel, SUBSCRIPTION_DEFAULT_MODEL } from "@t3tools/shared/assistantLlm";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  SparklesIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { assistantLlmQueryKey, useAssistantLlm } from "../../assistant/useAssistantLlm";
import {
  cancelAssistantSignIn,
  getAssistantSignIn,
  listAssistantLlmModels,
  startAssistantSignIn,
} from "../../lib/assistantLlmApi";
import { cn } from "../../lib/utils";
import { HarnessSignInDialog } from "../harness/HarnessSignInDialog";
import { useHarnessSetup } from "../harness/useHarnessSetup";
import { openInstallDocs } from "../onboarding/harnessInstallLinks";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";

type PowerCard = "uno" | SubscriptionLlmProvider | "key";

/** While a sign-in is waiting, look at the computer this often. */
const SIGN_IN_POLL_MS = 2_500;

function cardOf(provider: AssistantLlmProvider): PowerCard {
  if (provider === "uno") return "uno";
  if (isSubscriptionLlmProvider(provider)) return provider;
  return "key";
}

function subscriptionLine(subscription: SubscriptionLlmStatus): string {
  if (subscription.state === "ready") {
    const who = [subscription.plan, subscription.account].filter(Boolean).join(" · ");
    return who.length > 0 ? `${who} · Uno doesn't charge` : "Signed in · Uno doesn't charge";
  }
  if (subscription.state === "needs-hermes" || subscription.state === "unavailable") {
    return subscription.message ?? "Not available on this computer yet.";
  }
  return subscription.provider === "claude"
    ? "Sign in once with your Claude Pro or Max — your plan's limits apply."
    : "Sign in once with your ChatGPT plan — your plan's limits apply.";
}

function PowerCardButton(props: {
  readonly id: PowerCard;
  readonly title: string;
  readonly line: string;
  readonly selected: boolean;
  readonly busy: boolean;
  readonly disabled?: boolean | undefined;
  readonly badge?: string | undefined;
  readonly action?: ReactNode | undefined;
  readonly onPick: () => void;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-3 transition-colors",
        props.selected ? "border-primary bg-primary/5" : "border-border",
        props.disabled ? "opacity-60" : "hover:bg-accent/40",
      )}
      data-testid={`assistant-power-${props.id}`}
    >
      <button
        type="button"
        role="radio"
        aria-checked={props.selected}
        disabled={props.disabled || props.busy}
        onClick={props.onPick}
        className="flex w-full cursor-pointer items-start gap-2.5 text-left disabled:cursor-default"
      >
        <span
          className={cn(
            "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border",
            props.selected ? "border-primary bg-primary" : "border-input",
          )}
          aria-hidden
        >
          {props.busy ? (
            <LoaderCircleIcon className="size-3 animate-spin text-primary-foreground" />
          ) : props.selected ? (
            <span className="size-1.5 rounded-full bg-primary-foreground" />
          ) : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            {props.title}
            {props.badge ? (
              <span className="rounded border border-border px-1 text-[10px] font-normal text-muted-foreground">
                {props.badge}
              </span>
            ) : null}
          </span>
          <span className="block text-xs leading-snug text-muted-foreground">{props.line}</span>
        </span>
      </button>
      {props.action ? <div className="pl-6.5">{props.action}</div> : null}
    </div>
  );
}

function ChatgptSignInDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSignedIn: () => void;
}) {
  const { environmentId, onSignedIn, onOpenChange } = props;
  const [status, setStatus] = useState<AssistantSignInStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const done = useRef(false);

  useEffect(() => {
    let cancelled = false;
    startAssistantSignIn({ environmentId, provider: "chatgpt" })
      .then((next) => !cancelled && setStatus(next))
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [environmentId]);

  useEffect(() => {
    if (status?.state !== "waiting") return;
    const timer = setInterval(() => {
      void getAssistantSignIn({ environmentId, provider: "chatgpt" })
        .then(setStatus)
        .catch(() => undefined);
    }, SIGN_IN_POLL_MS);
    return () => clearInterval(timer);
  }, [environmentId, status?.state]);

  useEffect(() => {
    if (status?.state === "succeeded" && !done.current) {
      done.current = true;
      onSignedIn();
    }
  }, [onSignedIn, status?.state]);

  const close = () => {
    if (status?.state === "waiting") {
      void cancelAssistantSignIn({ environmentId, provider: "chatgpt" }).catch(() => undefined);
    }
    onOpenChange(false);
  };

  const copyCode = () => {
    if (!status?.code) return;
    void navigator.clipboard
      ?.writeText(status.code)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())}>
      <DialogPopup className="max-w-md" data-testid="assistant-chatgpt-sign-in">
        <DialogHeader>
          <DialogTitle>Sign in to ChatGPT for Uno</DialogTitle>
          <DialogDescription>
            Uno gets its own sign-in to your ChatGPT plan on this computer. Your Codex sign-in, if
            you have one, stays as it is.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 px-6 pb-2">
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : status?.state === "succeeded" ? (
            <p className="inline-flex items-center gap-2 text-sm">
              <CheckIcon className="size-4 text-success" /> Signed in. Switching Uno to your ChatGPT
              plan…
            </p>
          ) : status?.state === "failed" ? (
            <p className="text-sm text-destructive">{status.message}</p>
          ) : status?.url || status?.code ? (
            <>
              {status.url ? (
                <Button
                  size="sm"
                  className="self-start"
                  onClick={() => openInstallDocs(status.url!)}
                >
                  <ExternalLinkIcon className="mr-1 size-3.5" /> Open the ChatGPT page
                </Button>
              ) : null}
              {status.code ? (
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">Enter this code there</span>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-base tracking-widest">
                      {status.code}
                    </code>
                    <Button size="sm" variant="outline" onClick={copyCode}>
                      <CopyIcon className="mr-1 size-3" />
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  </div>
                </div>
              ) : null}
              <p className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                <LoaderCircleIcon className="size-3.5 animate-spin" /> Waiting for you to confirm on
                that page…
              </p>
            </>
          ) : (
            <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircleIcon className="size-4 animate-spin" /> Getting a sign-in code…
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            {status?.state === "succeeded" ? "Close" : "Cancel"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function AssistantPowerPicker(props: {
  readonly environmentId: EnvironmentId;
  /** Shown above the cards; omit in a settings row that has its own title. */
  readonly heading?: string;
  readonly className?: string;
}) {
  const { environmentId } = props;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const llm = useAssistantLlm(environmentId);
  const setup = useHarnessSetup(environmentId);
  const [picking, setPicking] = useState<PowerCard | null>(null);
  const [claudeSignInOpen, setClaudeSignInOpen] = useState(false);
  const [chatgptSignInOpen, setChatgptSignInOpen] = useState(false);
  /** A plan the person asked for, to switch to once its sign-in lands. */
  const [pending, setPending] = useState<SubscriptionLlmProvider | null>(null);

  const status = llm.status;
  const subscriptions = status?.subscriptions;
  const current = cardOf(status?.provider ?? "uno");
  const firstKey = BYOK_PROVIDER_IDS.find(
    (provider) => status?.keys.find((key) => key.provider === provider)?.configured,
  );

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: assistantLlmQueryKey(environmentId) });

  const switchTo = async (card: PowerCard) => {
    setPicking(card);
    try {
      if (card === "uno" || card === "claude" || card === "chatgpt") {
        const model =
          card === "uno"
            ? ((await listAssistantLlmModels({ environmentId, provider: "uno" })).defaultModel ??
              "uno/smart")
            : SUBSCRIPTION_DEFAULT_MODEL[card];
        await llm.setLlm({ provider: card, model });
        toastManager.add({
          type: "success",
          title:
            card === "uno"
              ? "Uno runs on Uno AI"
              : `Uno runs on your ${AI_PROVIDER_LABELS[card]} plan`,
          description: `Model: ${assistantModelLabel(model)}. The next message uses it.`,
        });
        return;
      }
      if (firstKey === undefined) {
        void navigate({ to: "/settings/ai" });
        return;
      }
      const list = await listAssistantLlmModels({ environmentId, provider: firstKey });
      if (!list.defaultModel) throw new Error(list.error ?? "That key lists no models.");
      await llm.setLlm({ provider: firstKey, model: list.defaultModel });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't switch Uno's AI",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPicking(null);
    }
  };

  // A sign-in landed: switch to the plan that was asked for.
  const pendingReady =
    pending !== null &&
    subscriptions?.find((subscription) => subscription.provider === pending)?.state === "ready";
  useEffect(() => {
    if (!pendingReady || pending === null) return;
    setPending(null);
    setClaudeSignInOpen(false);
    setChatgptSignInOpen(false);
    void switchTo(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- switchTo reads the latest state.
  }, [pendingReady]);
  // While one is pending, the daemon re-probes Claude Code; look again often.
  useEffect(() => {
    if (pending === null) return;
    const timer = setInterval(() => void refresh(), SIGN_IN_POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh is stable per environment.
  }, [pending, environmentId]);

  if (!llm.supported) return null;

  const pickSubscription = (subscription: SubscriptionLlmStatus) => {
    if (subscription.state === "ready") {
      void switchTo(subscription.provider);
      return;
    }
    if (subscription.state !== "sign-in") return;
    setPending(subscription.provider);
    if (subscription.signIn === "assistant") setChatgptSignInOpen(true);
    else setClaudeSignInOpen(true);
  };

  return (
    <div className={cn("flex flex-col gap-2", props.className)} data-testid="assistant-power">
      {props.heading ? <div className="text-sm font-semibold">{props.heading}</div> : null}
      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="What powers Uno">
        <PowerCardButton
          id="uno"
          title="Uno AI"
          line="Included in your plan · nothing to set up"
          selected={current === "uno"}
          busy={picking === "uno"}
          onPick={() => void switchTo("uno")}
        />
        {(subscriptions ?? []).map((subscription) => (
          <PowerCardButton
            key={subscription.provider}
            id={subscription.provider}
            title={`Your ${AI_PROVIDER_LABELS[subscription.provider]} plan`}
            line={subscriptionLine(subscription)}
            badge={subscription.provider === "claude" ? "Beta" : undefined}
            selected={current === subscription.provider}
            busy={picking === subscription.provider || pending === subscription.provider}
            disabled={subscription.state === "needs-hermes" || subscription.state === "unavailable"}
            onPick={() => pickSubscription(subscription)}
            action={
              subscription.state === "sign-in" && pending !== subscription.provider ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => pickSubscription(subscription)}
                  data-testid={`assistant-power-${subscription.provider}-sign-in`}
                >
                  <SparklesIcon className="size-3" />
                  Sign in to {AI_PROVIDER_LABELS[subscription.provider]}
                </Button>
              ) : undefined
            }
          />
        ))}
        <PowerCardButton
          id="key"
          title="Your own key"
          line={
            firstKey
              ? `${AI_PROVIDER_LABELS[firstKey]} key on this computer · billed by ${AI_PROVIDER_LABELS[firstKey]}`
              : "xAI, OpenRouter, OpenAI or any OpenAI-compatible API"
          }
          selected={current === "key"}
          busy={picking === "key"}
          onPick={() => void switchTo("key")}
          action={
            firstKey ? undefined : (
              <Button
                size="xs"
                variant="outline"
                onClick={() => void navigate({ to: "/settings/ai" })}
              >
                <KeyRoundIcon className="size-3" /> Add a key
              </Button>
            )
          }
        />
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">
        One choice for every assistant chat on this computer. Change the model with the chip in
        Uno's chat.
      </p>

      {claudeSignInOpen ? (
        <HarnessSignInDialog
          open
          onOpenChange={(open) => {
            setClaudeSignInOpen(open);
            if (!open && pending === "claude") setPending(null);
          }}
          driver="claudeAgent"
          label="Claude"
          job={setup.authJobs.claudeAgent}
          onStart={({ method, apiKey, restart }) =>
            void setup.startAuth({
              driver: "claudeAgent",
              method,
              ...(apiKey ? { apiKey } : {}),
              ...(restart ? { restart } : {}),
            })
          }
          onCancel={() => void setup.cancelAuth("claudeAgent")}
          onSubmitCode={(code) => void setup.submitAuthCode({ driver: "claudeAgent", code })}
          onReset={() => setup.clearAuth("claudeAgent")}
        />
      ) : null}
      {chatgptSignInOpen ? (
        <ChatgptSignInDialog
          environmentId={environmentId}
          onOpenChange={(open) => {
            setChatgptSignInOpen(open);
            if (!open && pending === "chatgpt") setPending(null);
          }}
          onSignedIn={() => void refresh()}
        />
      ) : null}
    </div>
  );
}
