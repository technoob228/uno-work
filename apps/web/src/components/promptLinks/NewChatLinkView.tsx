/**
 * `/new?prompt=…`: a new chat in the home folder on the computer in use, with
 * the prompt in its box. Waits for the computer while it connects.
 */
import type { LinkedPrompt } from "@t3tools/shared/promptLinks";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { useFolderChats } from "../../hooks/useFolderChats";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { placeLinkedPrompt } from "./linkedPrompt";

const RETRY_MS = 2_000;
const GIVE_UP_MS = 45_000;

export function NewChatLinkView({ prompt }: { readonly prompt: LinkedPrompt }) {
  const router = useRouter();
  const { activeEnvironmentId } = useHandleNewThread();
  const { chatInHomeFolder } = useFolderChats(activeEnvironmentId);
  const [gaveUp, setGaveUp] = useState(false);
  const placed = useRef(false);

  useEffect(() => {
    if (placed.current) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();
    const attempt = () => {
      void chatInHomeFolder({ replaceRoute: true }).then((started) => {
        // Not `cancelled` yet: arriving at the chat is what unmounts this view.
        if (placed.current) return;
        const params = router.state.matches[router.state.matches.length - 1]?.params ?? {};
        const route = resolveThreadRouteTarget(params);
        if (started && route?.kind === "draft") {
          placed.current = true;
          placeLinkedPrompt(route.draftId, prompt);
          return;
        }
        if (cancelled) return;
        if (Date.now() - startedAt >= GIVE_UP_MS) {
          setGaveUp(true);
          return;
        }
        timer = setTimeout(attempt, RETRY_MS);
      });
    };
    attempt();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [chatInHomeFolder, prompt, router]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          {gaveUp ? (
            <>
              <EmptyTitle>Your computer isn't reachable</EmptyTitle>
              <EmptyDescription>Open the link again once it's back.</EmptyDescription>
            </>
          ) : (
            <>
              <Spinner />
              <EmptyDescription>Opening a new chat…</EmptyDescription>
            </>
          )}
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}
