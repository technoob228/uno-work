import { createFileRoute } from "@tanstack/react-router";

import { SharedChatView } from "../components/team/SharedChatView";

/** T51: a chat a colleague shared with me, read live from the Uno cloud. */
export const Route = createFileRoute("/_chat/shared/$chatId")({
  component: SharedChatRoute,
});

function SharedChatRoute() {
  const { chatId } = Route.useParams();
  return <SharedChatView key={chatId} chatId={Number(chatId)} />;
}
