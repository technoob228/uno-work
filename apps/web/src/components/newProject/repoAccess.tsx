/**
 * Cloning a repository for a new project, private ones included (Misha 20.10:
 * "a private repo — sign in with GitHub, like the console does").
 *
 * - A public repository clones as before.
 * - A private one on an Uno cloud computer: git asks `git-credential-uno`
 *   (daemon, `setupTools/gitCredentialHelper.ts`), which gets a one-repository,
 *   one-hour token from the console for the account's GitHub (the Uno GitHub
 *   App). No token passes through this screen, the address or `.git/config`.
 * - When GitHub isn't connected to the account yet, or Uno wasn't given this
 *   repository on GitHub, the clone is refused and the notice offers the one
 *   step that fixes it — "Continue with GitHub" / "Give Uno access to this
 *   repository" — then clones by itself once the person is back.
 * - Off a cloud computer (the account's GitHub can't sign git in there) the
 *   fallback is the chat where Uno connects this computer with an SSH key.
 *
 * git's own error text is never shown (cloneFailureMessage).
 *
 * @module newProject/repoAccess
 */
import type { EnvironmentId, SourceControlCloneRepositoryResult } from "@t3tools/contracts";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { ensureEnvironmentApi } from "../../environmentApi";
import {
  connectGithubAccount,
  getGithubAccount,
  openAuthWindow,
  type GithubAccountState,
} from "../../lib/setupApi";
import { GitHubIcon } from "../Icons";
import { Button } from "../ui/button";
import {
  cloneFailureMessage,
  githubHttpsRemote,
  githubRepoSlug,
  isRepoAccessError,
  repoAccessOffer,
  type RepoAccessOffer,
} from "./newProject.logic";

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause ?? "");
}

/** How long to wait for the person on github.com before giving the button back. */
const WAIT_FOR_GITHUB_MS = 180_000;
const POLL_MS = 3000;

/**
 * Resolves true when it is time to clone again:
 * - `check` (GitHub not connected yet): as soon as the account shows it;
 * - no `check` (Uno is connected, the person adds a repository): when our
 *   window closed or, for a page opened in the system browser, when the
 *   person comes back to Uno Work.
 * False: cancelled, or nothing happened within the wait.
 */
function waitForGithub(input: {
  readonly external: boolean;
  readonly check: (() => Promise<boolean>) | null;
  readonly cancelled: () => boolean;
}): Promise<boolean> {
  // Our popup closed by itself (the console's page reports back) or by the
  // person: without a check there is nothing more to wait for.
  if (!input.external && input.check === null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const deadline = Date.now() + (input.external ? WAIT_FOR_GITHUB_MS : 30_000);
    let done = false;
    let checking = false;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      resolve(value);
    };
    const tick = async () => {
      if (done || checking) return;
      if (input.cancelled()) return finish(false);
      if (Date.now() > deadline) return finish(false);
      if (input.check === null) return;
      checking = true;
      try {
        if (await input.check()) finish(true);
      } finally {
        checking = false;
      }
    };
    const onFocus = () => {
      if (input.check === null) finish(true);
      else void tick();
    };
    const timer = window.setInterval(() => void tick(), POLL_MS);
    if (input.external) window.addEventListener("focus", onFocus);
    void tick();
  });
}

export interface RepoClone {
  /** What the notice offers after a refused clone; null — nothing was refused. */
  readonly offer: RepoAccessOffer | null;
  readonly github: GithubAccountState | null;
  /** The person is on github.com. */
  readonly waiting: boolean;
  /** Came back from GitHub and the repository is still closed to Uno. */
  readonly stillClosed: boolean;
  /**
   * Clones. Null — refused for access (`offer` says what to do). Throws an
   * Error with a sentence for people for anything else.
   */
  readonly clone: (input: {
    readonly remoteUrl: string;
    readonly destinationPath: string;
  }) => Promise<SourceControlCloneRepositoryResult | null>;
  /** Opens GitHub for `offer` connect / add-repo; calls `retry` once the person is back. */
  readonly openGithub: (retry: () => Promise<void>) => Promise<void>;
  /** Another address was typed: forget the refusal. */
  readonly reset: () => void;
}

export function useRepoClone(environmentId: EnvironmentId): RepoClone {
  const [offer, setOffer] = useState<RepoAccessOffer | null>(null);
  const [github, setGithub] = useState<GithubAccountState | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [stillClosed, setStillClosed] = useState(false);
  const mounted = useRef(true);
  // Bumped to drop a wait for GitHub that is no longer wanted.
  const generation = useRef(0);
  // Set while a clone runs right after the person came back from GitHub.
  const afterGithub = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);

  const readGithub = useCallback(
    () => getGithubAccount({ environmentId }).catch((): GithubAccountState | null => null),
    [environmentId],
  );

  const reset = useCallback(() => {
    generation.current += 1;
    setOffer(null);
    setStillClosed(false);
    setWaiting(false);
  }, []);

  const clone: RepoClone["clone"] = async ({ remoteUrl, destinationPath }) => {
    const api = ensureEnvironmentApi(environmentId).sourceControl;
    const https = githubHttpsRemote(remoteUrl);
    const attempt = async (url: string) => {
      try {
        return { result: await api.cloneRepository({ remoteUrl: url, destinationPath }) };
      } catch (cause) {
        const message = messageOf(cause);
        if (isRepoAccessError(message)) return { result: null };
        throw new Error(cloneFailureMessage(message), { cause });
      }
    };
    // With the account's GitHub connected, a GitHub repository goes over
    // https: that is where the account signs git in.
    const first = github?.connected ? https : remoteUrl;
    let outcome = await attempt(first);
    if (outcome.result !== null) {
      if (mounted.current) setOffer(null);
      return outcome.result;
    }
    // Asking also makes sure git on this computer knows where to get its
    // GitHub sign-in (the daemon puts the credential helper in place).
    const state = await readGithub();
    if (state?.connected && first !== https) {
      // An SSH address (no key here) of a repository the account may open.
      outcome = await attempt(https);
      if (outcome.result !== null) {
        if (mounted.current) setOffer(null);
        return outcome.result;
      }
    }
    if (mounted.current) {
      setGithub(state);
      setOffer(repoAccessOffer(remoteUrl, state));
      setStillClosed(afterGithub.current);
    }
    return null;
  };

  const openGithub: RepoClone["openGithub"] = async (retry) => {
    const current = (generation.current += 1);
    const cancelled = () => !mounted.current || generation.current !== current;
    const wasConnected = github?.connected === true;
    setWaiting(true);
    setStillClosed(false);
    try {
      const { authorizeUrl } = await connectGithubAccount({ environmentId });
      const opened = await openAuthWindow(authorizeUrl, "uno-connector");
      const ready = await waitForGithub({
        external: opened.external,
        // Not connected yet: the account shows the connection once the
        // person confirmed it. Connected: GitHub doesn't tell when a
        // repository was added (no redirect on update) — clone again when
        // the person is back.
        check: wasConnected
          ? null
          : async () => {
              const state = await readGithub();
              if (state !== null && !cancelled()) setGithub(state);
              return state?.connected === true;
            },
        cancelled,
      });
      if (cancelled()) return;
      setWaiting(false);
      if (!ready) return;
      afterGithub.current = true;
      try {
        await retry();
      } finally {
        afterGithub.current = false;
      }
    } finally {
      if (!cancelled()) setWaiting(false);
    }
  };

  return { offer, github, waiting, stillClosed, clone, openGithub, reset };
}

/**
 * The notice under the address after a refused clone. `onAskUno` — the SSH
 * key chat, the only way where the account's GitHub can't sign git in.
 */
export function RepoAccessNotice(props: {
  readonly access: RepoClone;
  readonly remoteUrl: string;
  readonly busy: boolean;
  readonly onOpenGithub: () => void;
  readonly onAskUno: () => void;
}) {
  const { access } = props;
  if (access.offer === null) return null;
  const repo = githubRepoSlug(props.remoteUrl) ?? props.remoteUrl;
  const accounts = access.github?.accounts ?? [];
  const waitingLine = (
    <p className="text-xs text-muted-foreground" role="status">
      Finish on GitHub’s page. Uno clones the repository as soon as you’re back.
    </p>
  );
  const shell = (children: ReactNode) => (
    <div
      className="flex flex-col gap-2 rounded-xl border border-border bg-muted/40 p-3 text-sm"
      data-testid="new-project-repo-private"
      data-offer={access.offer}
    >
      {children}
    </div>
  );

  if (access.offer === "connect") {
    return shell(
      <>
        <p>
          <b className="font-medium">This repository is private.</b> Sign in with GitHub and choose
          which repositories Uno can open. It then works on all your computers.
        </p>
        <div>
          <Button
            size="sm"
            disabled={props.busy || access.waiting}
            onClick={props.onOpenGithub}
            data-testid="new-project-connect-github"
          >
            <GitHubIcon />
            {access.waiting ? "Waiting for GitHub…" : "Continue with GitHub"}
          </Button>
        </div>
        {access.waiting ? waitingLine : null}
      </>,
    );
  }

  if (access.offer === "add-repo") {
    return shell(
      <>
        <p>
          <b className="font-medium">Uno can’t open {repo} yet.</b>{" "}
          {access.stillClosed
            ? "GitHub still doesn’t let Uno in. On GitHub’s page, tick this repository (or “All repositories”) and press Save."
            : `GitHub is connected${accounts.length > 0 ? ` (${accounts.join(", ")})` : ""}, but this repository isn’t on Uno’s list. Add it on GitHub: tick it and press Save.`}
        </p>
        <p className="text-xs text-muted-foreground">
          Is the address right? GitHub answers the same way for a repository that doesn’t exist.
        </p>
        <div>
          <Button
            size="sm"
            disabled={props.busy || access.waiting}
            onClick={props.onOpenGithub}
            data-testid="new-project-connect-github"
          >
            <GitHubIcon />
            {access.waiting ? "Waiting for GitHub…" : "Give Uno access to this repository"}
          </Button>
        </div>
        {access.waiting ? waitingLine : null}
      </>,
    );
  }

  return shell(
    <>
      <p>
        <b className="font-medium">This repository is private</b> (or the address has a typo). This
        computer isn’t signed in to GitHub yet.
      </p>
      <p className="text-xs text-muted-foreground">
        Uno makes a key for this computer and shows you where to add it on GitHub — one paste, no
        tokens. Then it clones the repository here.
      </p>
      <div>
        <Button size="sm" disabled={props.busy} onClick={props.onAskUno}>
          <GitHubIcon />
          Let Uno connect GitHub
        </Button>
      </div>
    </>,
  );
}
