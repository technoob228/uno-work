import { isElectron } from "./env";

/**
 * True for the hosted browser build: the same web app, but served by a remote
 * daemon (a managed Uno box or the user's own VM) instead of the desktop shell.
 *
 * The distinction matters for onboarding: the desktop flow talks about granting
 * macOS permissions and installing harness CLIs on *your* machine, while the
 * browser flow runs against a machine that is already provisioned.
 */
export const isWebApp = !isElectron;
