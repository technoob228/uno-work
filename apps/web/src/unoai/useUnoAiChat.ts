/**
 * One Uno AI chat: load it, send a message, follow the server's turn by
 * polling until it ends. The turn keeps running on the server if this page
 * goes away; coming back shows where it got to.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  accountErrorInfo,
  aiChatLive,
  sendAiTurn,
  type AiChatMessage,
  type AiLive,
  type AiSite,
  type AiStop,
} from "./unoAiApi";

export const unoAiKeys = {
  chats: ["workspace", "unoAi", "chats"] as const,
  meter: ["workspace", "unoAi", "meter"] as const,
};

const POLL_MS = 700;

export interface UnoAiChatState {
  readonly loaded: boolean;
  readonly messages: ReadonlyArray<AiChatMessage>;
  readonly sites: ReadonlyArray<AiSite>;
  readonly title: string;
  readonly running: boolean;
  readonly live: AiLive["live"];
  readonly stop: AiStop | null;
  readonly sendError: string | null;
}

const EMPTY: UnoAiChatState = {
  loaded: false,
  messages: [],
  sites: [],
  title: "",
  running: false,
  live: null,
  stop: null,
  sendError: null,
};

export function useUnoAiChat(chatId: string) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<UnoAiChatState>(EMPTY);
  const count = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const idRef = useRef(chatId);
  /** Something was sent in this chat since it opened: the first load must not wipe it. */
  const touched = useRef(false);

  const apply = useCallback((live: AiLive, append: boolean) => {
    setState((prev) => {
      const messages = append ? [...prev.messages, ...live.messages] : [...live.messages];
      count.current = messages.length;
      return {
        loaded: true,
        messages,
        sites: live.sites ?? prev.sites,
        title: live.title ?? prev.title,
        running: live.running,
        live: live.live,
        stop: live.running ? null : live.stop,
        sendError: null,
      };
    });
  }, []);

  const poll = useCallback(
    (id: string) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(async () => {
        if (!alive.current || idRef.current !== id) return;
        try {
          const live = await aiChatLive(id, count.current);
          if (!alive.current || idRef.current !== id) return;
          if (live) {
            // The server may have fewer messages than we think (another tab
            // deleted…): reload whole.
            if (live.message_count < count.current) {
              const full = await aiChatLive(id, 0);
              if (full) apply(full, false);
            } else {
              apply(live, true);
            }
            if (live.running) {
              poll(id);
            } else {
              void queryClient.invalidateQueries({ queryKey: unoAiKeys.chats });
              void queryClient.invalidateQueries({ queryKey: unoAiKeys.meter });
            }
            return;
          }
        } catch {
          // a network blip: keep polling a little slower
        }
        if (alive.current && idRef.current === id) poll(id);
      }, POLL_MS);
    },
    [apply, queryClient],
  );

  useEffect(() => {
    alive.current = true;
    idRef.current = chatId;
    count.current = 0;
    touched.current = false;
    setState(EMPTY);
    let cancelled = false;
    void (async () => {
      try {
        const live = await aiChatLive(chatId, 0);
        if (cancelled || touched.current) return;
        if (!live) {
          setState({ ...EMPTY, loaded: true });
          return;
        }
        apply(live, false);
        if (live.running) poll(chatId);
      } catch (error) {
        if (!cancelled) {
          setState({
            ...EMPTY,
            loaded: true,
            sendError: accountErrorInfo(error).detail || "Could not open this chat.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [apply, chatId, poll]);

  const start = useCallback(
    async (input: { message?: string; resume?: boolean }) => {
      const id = chatId;
      const text = input.message?.trim() ?? "";
      touched.current = true;
      setState((prev) => ({
        ...prev,
        loaded: true,
        running: true,
        stop: null,
        sendError: null,
        live: { text: "", tool: "", chars: 0, elapsed_s: 0 },
        messages: text ? [...prev.messages, { role: "user", content: text }] : prev.messages,
        title: prev.title || text,
      }));
      if (text) count.current += 1;
      try {
        const started = await sendAiTurn(id, input);
        count.current = started.message_count;
        poll(id);
      } catch (error) {
        const info = accountErrorInfo(error);
        if (info.code === "CHAT_BUSY") {
          // Uno is still on the previous message: follow that turn.
          if (text) {
            count.current -= 1;
            setState((prev) => ({ ...prev, messages: prev.messages.slice(0, -1) }));
          }
          poll(id);
          return;
        }
        if (text) count.current -= 1;
        setState((prev) => ({
          ...prev,
          running: false,
          live: null,
          messages: text ? prev.messages.slice(0, -1) : prev.messages,
          sendError:
            info.status === 401
              ? "Sign in again to keep chatting."
              : info.detail || "Could not send. Check your connection and try again.",
        }));
        return text;
      }
      void queryClient.invalidateQueries({ queryKey: unoAiKeys.chats });
      return null;
    },
    [chatId, poll, queryClient],
  );

  const send = useCallback((message: string) => start({ message }), [start]);
  const resume = useCallback(() => start({ resume: true }), [start]);

  return { state, send, resume };
}
