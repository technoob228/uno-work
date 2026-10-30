import { parsePromptLink } from "@t3tools/shared/promptLinks";
import { createFileRoute, useLocation } from "@tanstack/react-router";
import { useMemo } from "react";

import { NewChatLinkView } from "../components/promptLinks/NewChatLinkView";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";

// The query is read raw: the router's own search parsing turns `prompt=123` into a number.
function NewChatLinkRoute() {
  const search = useLocation({ select: (location) => location.searchStr });
  const parsed = useMemo(() => parsePromptLink(search), [search]);
  if (!parsed.ok) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
        <Empty className="flex-1">
          <EmptyHeader className="max-w-md">
            <EmptyTitle>Couldn't open the link</EmptyTitle>
            <EmptyDescription>{parsed.error}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </SidebarInset>
    );
  }
  return <NewChatLinkView key={search} prompt={parsed.value} />;
}

export const Route = createFileRoute("/_chat/new")({
  component: NewChatLinkRoute,
});
