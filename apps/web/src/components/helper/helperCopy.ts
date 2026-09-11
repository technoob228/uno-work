/**
 * Plain-language copy for the Helper / Telegram page.
 *
 * Product rule (2026-09-11): outside the "Advanced" section the UI never says
 * "assistant", "connector", "MCP", "proposal" or "orchestration". It says
 * Helper, Telegram, chat, project, permission request. Everything that is
 * shown to a non-technical owner is defined here so the wording lives in one
 * place; a later pass will fold these into the shared plain-language map.
 */
export const helperCopy = {
  pageTitle: "Telegram",
  pageIntro: "Connect a Telegram bot to talk to your projects from your phone.",

  connect: {
    title: "Connect Telegram",
    description: "Your Helper answers in Telegram through a bot that belongs to you.",
    tokenLabel: "Bot token",
    tokenPlaceholder: "123456:ABC-…",
    tokenKeepHint: "Leave empty to keep the current token.",
    howToTitle: "How to get a token",
    howToSteps: [
      "Open @BotFather in Telegram.",
      "Send /newbot and follow the prompts.",
      "Paste the token it gives you here.",
    ],
    save: "Save",
    saving: "Saving…",
    savedNotice: "Telegram saved. Send a message to your bot to try it.",
    pauseLabel: "Pause the bot",
    pauseDescription: "Keep the token, stop answering for now.",
  },

  status: {
    notConnected: "Not connected",
    paused: "Paused",
    connecting: "Connecting…",
    connectedAs: (botUsername: string | null) =>
      botUsername ? `Connected as @${botUsername}` : "Connected",
    needsAttention: (detail: string) => `Needs attention: ${detail}`,
  },

  allowedChats: {
    title: "Who can write to the bot",
    description: "Only these chats get answers. Everyone else is ignored.",
    addChat: "Add chat",
    addHint: "Send /start to your bot, then paste the chat id it replies with.",
    chatIdPlaceholder: "Chat id, e.g. 128841517 or -1001234567890",
    labelPlaceholder: "Label (optional), e.g. Me or Family group",
    remove: "Remove",
    empty: "No chats yet. Add the chat id of your own Telegram account first.",
  },

  routing: {
    title: "What each chat talks to",
    description: "Pick where messages from each chat go.",
    alwaysSent: "Errors and permission requests are always sent.",
    optionHelper: "Helper (decides where the work goes)",
    optionProject: "Project",
    optionThread: "A specific chat",
    pickProject: "Choose a project",
    pickThread: "Choose a chat",
    noProjects: "No projects yet.",
    noThreads: "No open chats in this project.",
    notifyOnComplete: "Tell me when work finishes",
    targetMissing: "This target no longer exists. Pick another one.",
    empty: "Add a chat above to choose where its messages go.",
  },

  brain: {
    title: "Helper's brain",
    modelTitle: "Model",
    modelDescription: "Which model answers you in Telegram.",
    saveModel: "Save",
    instructionsTitle: "What the Helper should know about you and your projects",
    instructionsDescription: "Written in plain text. The Helper reads it before every answer.",
  },

  advanced: {
    title: "Advanced",
    description: "Everything technical lives here. You do not need it to get started.",
    show: "Show advanced settings",
    hide: "Hide advanced settings",
  },
} as const;
