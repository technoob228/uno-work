/**
 * Uno Drive ↔ Telegram. Default: the shared Uno bot — one button opens
 * Telegram with a one-time link, Start binds the chat. Advanced: the
 * person's own bot (BotFather token), also answered by the console, so both
 * work while the computer sleeps.
 */
import type { EnvironmentId, FilesDriveState } from "@t3tools/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BotIcon,
  ExternalLinkIcon,
  Loader2Icon,
  SendIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { QRCodeSvg } from "../ui/qr-code";
import { toastManager } from "../ui/toast";
import { filesApi } from "../files/filesApi";
import { formatFileSize } from "../files/fileTypes";
import { driveQueryKeys } from "./driveApi";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function DriveTelegramPanel({
  environmentId,
  state,
  onWaitingChange,
}: {
  environmentId: EnvironmentId | null;
  state: FilesDriveState;
  /** While a link is open, the page polls Drive state to notice the new chat. */
  onWaitingChange: (waiting: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });
  const [pending, setPending] = useState<{ url: string; own: boolean } | null>(null);
  const [token, setToken] = useState("");
  const chatsBefore = useRef(state.telegram.chats.length);

  // A new chat showed up while waiting → done.
  useEffect(() => {
    if (pending && state.telegram.chats.length > chatsBefore.current) {
      toastManager.add({ type: "success", title: "Telegram connected to Uno Drive" });
      setPending(null);
      onWaitingChange(false);
    }
    chatsBefore.current = state.telegram.chats.length;
  }, [pending, state.telegram.chats.length, onWaitingChange]);

  const link = useMutation({
    mutationFn: (own: boolean) => filesApi(environmentId).driveTelegramLink({ ownBot: own }),
    onSuccess: (result, own) => {
      chatsBefore.current = state.telegram.chats.length;
      setPending({ url: result.url, own });
      onWaitingChange(true);
      window.open(result.url, "_blank", "noopener");
    },
  });
  const unlink = useMutation({
    mutationFn: (id: number) => filesApi(environmentId).driveTelegramUnlink({ id }),
    onSuccess: refresh,
  });
  const connectBot = useMutation({
    mutationFn: (value: string) => filesApi(environmentId).driveBotConnect({ token: value }),
    onSuccess: (bot) => {
      setToken("");
      toastManager.add({ type: "success", title: `@${bot.username} is connected` });
      refresh();
    },
  });
  const disconnectBot = useMutation({
    mutationFn: () => filesApi(environmentId).driveBotDisconnect(),
    onSuccess: refresh,
  });

  const tg = state.telegram;
  const ownBot = tg.ownBot;
  const botName = (botId: number) =>
    botId === 0
      ? `@${tg.sharedBot}`
      : ownBot && ownBot.id === botId
        ? `@${ownBot.username}`
        : "your bot";

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-5">
      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-sky-500/10">
            <SendIcon className="size-5 text-sky-500" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">Save from Telegram</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Send a file, photo or voice message to the Uno bot — it lands in Uno Drive, in
              Telegram/&lt;month&gt;, and the bot replies with a link. Ask it “/find contract” to
              get a file back. It works even while your computer is asleep.
            </p>
          </div>
        </div>

        {tg.chats.length > 0 ? (
          <ul className="mt-4 flex flex-col gap-1.5">
            {tg.chats.map((chat) => (
              <li
                key={chat.id}
                className="flex items-center gap-3 rounded-xl border border-border px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">
                    {chat.username ? `@${chat.username}` : "Telegram chat"}
                  </span>
                  <span className="text-muted-foreground"> · with {botName(chat.botId)}</span>
                </span>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={unlink.isPending}
                  onClick={() => unlink.mutate(chat.id)}
                >
                  <Trash2Icon />
                  Disconnect
                </Button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            disabled={!tg.sharedBotReady || link.isPending}
            onClick={() => link.mutate(false)}
          >
            {link.isPending && !link.variables ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <SendIcon />
            )}
            {tg.chats.length > 0 ? "Connect another chat" : "Connect Telegram"}
          </Button>
          {!tg.sharedBotReady ? (
            <span className="text-xs text-muted-foreground">
              The Uno bot isn't available right now.
            </span>
          ) : null}
        </div>
        {link.error ? (
          <p className="mt-2 text-sm text-destructive">{errorText(link.error)}</p>
        ) : null}

        {pending ? (
          <div className="mt-4 flex items-center gap-4 rounded-xl bg-muted/50 p-4">
            <QRCodeSvg
              value={pending.url}
              size={112}
              className="shrink-0 rounded-lg bg-white p-2"
            />
            <div className="min-w-0 text-sm">
              <div className="flex items-center gap-2 font-medium">
                <Loader2Icon className="size-4 animate-spin" />
                Waiting for you to press Start in Telegram…
              </div>
              <p className="mt-1 text-muted-foreground">
                Telegram opened in a new tab. On your phone, scan the code. The link works once, for
                15 minutes.
              </p>
              <a
                href={pending.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-sky-600 hover:underline"
              >
                Open Telegram
                <ExternalLinkIcon className="size-3.5" />
              </a>
            </div>
          </div>
        ) : null}

        <ul className="mt-4 flex flex-col gap-1 text-xs text-muted-foreground">
          <li>
            • Telegram gives bots files up to {formatFileSize(tg.downloadLimitBytes)}. For bigger
            ones the bot sends a one-time upload page.
          </li>
          <li className="flex gap-1">
            <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0" />
            Files you send go through Uno's server straight into your Cloud storage. Telegram sees
            them too, as with any chat. Only chats you connected here can reach your files.
          </li>
        </ul>
      </section>

      <details className="group rounded-2xl border border-border bg-card p-5">
        <summary className="flex cursor-pointer list-none items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
            <BotIcon className="size-5 text-muted-foreground" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">Use your own bot</span>
            <span className="block text-xs text-muted-foreground">
              For advanced users: your own name and picture in Telegram instead of the Uno bot.
            </span>
          </span>
        </summary>
        <div className="mt-4 flex flex-col gap-3 text-sm">
          {!tg.ownBotsAvailable ? (
            <p className="text-muted-foreground">
              Own bots aren't available on this Uno console yet.
            </p>
          ) : ownBot ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">@{ownBot.username}</span>
                <span className="text-muted-foreground">is connected.</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={link.isPending}
                  onClick={() => link.mutate(true)}
                >
                  <SendIcon />
                  Connect a chat to @{ownBot.username}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disconnectBot.isPending}
                  onClick={() => disconnectBot.mutate()}
                >
                  <Trash2Icon />
                  Remove bot
                </Button>
              </div>
              {disconnectBot.error ? (
                <p className="text-destructive">{errorText(disconnectBot.error)}</p>
              ) : null}
            </>
          ) : (
            <>
              <ol className="list-inside list-decimal text-muted-foreground">
                <li>
                  In Telegram, open{" "}
                  <a
                    href="https://t.me/BotFather"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sky-600 hover:underline"
                  >
                    @BotFather
                  </a>{" "}
                  and send /newbot.
                </li>
                <li>Pick a name. BotFather replies with a token — paste it here.</li>
              </ol>
              <p className="text-xs text-muted-foreground">
                Use a new bot, not the one your Uno assistant already uses: a bot can only work in
                one place.
              </p>
              <div className="flex gap-2">
                <Input
                  type="password"
                  autoComplete="off"
                  placeholder="123456789:AA…"
                  value={token}
                  onChange={(event) => setToken(event.currentTarget.value)}
                  aria-label="Bot token"
                />
                <Button
                  disabled={token.trim().length < 20 || connectBot.isPending}
                  onClick={() => connectBot.mutate(token.trim())}
                >
                  {connectBot.isPending ? <Loader2Icon className="animate-spin" /> : null}
                  Connect
                </Button>
              </div>
              {connectBot.error ? (
                <p className="text-destructive">{errorText(connectBot.error)}</p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                The token is stored encrypted in your Uno account and never shown again.
              </p>
            </>
          )}
        </div>
      </details>
    </div>
  );
}
