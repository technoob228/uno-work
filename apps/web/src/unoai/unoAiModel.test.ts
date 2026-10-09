import { describe, expect, it } from "vitest";

import type { AiChatMessage } from "./unoAiApi";
import {
  describeUnoAiHandoff,
  handoffPrompt,
  HANDOFF_TTL_MS,
  isUnoAiHandoff,
  rememberHandoff,
  readHandoff,
  clearHandoff,
} from "./unoAiHandoff";
import {
  askQuestions,
  chatLanguage,
  latestBotKey,
  latestSite,
  liveActivity,
  pendingQuestion,
  standardAnswers,
  transcriptItems,
} from "./unoAiModel";
import { consoleManageLink, isSameSite, meterLine } from "./UnoAiView";

const call = (id: string, name: string, args: unknown) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const tool = (id: string, result: unknown): AiChatMessage => ({
  role: "tool",
  tool_call_id: id,
  content: JSON.stringify(result),
});

const transcript: AiChatMessage[] = [
  { role: "user", content: "I teach yoga and want a booking site" },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      call("a1", "ask_user", {
        think: "THINK-SECRET",
        question: "Group classes or private?",
        options: ["Group", "Private", "Both"],
        recommended: "Both",
      }),
      call("a2", "ask_user", { question: "Second?", options: ["x", "y"] }),
    ],
  },
  tool("a1", { ok: true }),
  tool("a2", { ok: false, error: "Not shown: one question at a time." }),
  { role: "user", content: "Both" },
  {
    role: "assistant",
    content: "Got it.",
    tool_calls: [
      call("p1", "show_plan", { title: "Booking site for Maya Yoga", steps: ["Hero", "Form"] }),
      call("w1", "write_file", { path: "index.html", content: "<html>" }),
    ],
  },
  tool("p1", { ok: true }),
  tool("w1", { ok: true, path: "index.html", chars: 6000 }),
  {
    role: "assistant",
    content: null,
    tool_calls: [call("w2", "write_file", { path: "index.html", content: "x", append: true })],
  },
  tool("w2", { ok: true, path: "index.html", chars: 11800 }),
  {
    role: "assistant",
    content: null,
    tool_calls: [call("s1", "publish_site", { slug: "maya-yoga", title: "Maya Yoga" })],
  },
  tool("s1", { ok: true, slug: "maya-yoga", url: "https://maya-yoga.sites.uno4.dev/" }),
  {
    role: "assistant",
    content: "It's live — open on the right.",
    tool_calls: [
      call("n1", "suggest_next", {
        action: "computer",
        reason: "A real bot lives on your computer.",
      }),
    ],
  },
  tool("n1", { ok: true }),
];

describe("transcriptItems", () => {
  const items = transcriptItems(transcript);
  it("shows what a person sees, in order, without refused calls", () => {
    expect(items.map((i) => i.kind)).toEqual([
      "user",
      "ask",
      "user",
      "text",
      "plan",
      "building",
      "site",
      "text",
      "suggest",
    ]);
  });
  it("merges the parts of the file into one line", () => {
    const b = items.find((i) => i.kind === "building");
    expect(b && b.kind === "building" && b.chars).toBe(11800);
  });
  it("knows answered questions and the current offer", () => {
    const ask = items.find((i) => i.kind === "ask");
    expect(ask && ask.kind === "ask" && ask.answered).toBe(true);
    const s = items.at(-1);
    expect(s?.kind === "suggest" && s.current).toBe(true);
    expect(pendingQuestion(items)).toBeNull();
  });
  it("reads plan steps sent as objects", () => {
    const plan = transcriptItems([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          call("x", "show_plan", {
            title: "T",
            steps: [{ step: "Hero" }, { title: "Form", detail: "to Telegram" }, "FAQ"],
          }),
        ],
      },
    ]);
    expect(plan[0]?.kind === "plan" && plan[0].steps).toEqual([
      "Hero",
      "Form — to Telegram",
      "FAQ",
    ]);
  });
  it("finds the latest site", () => {
    expect(latestSite(items, null)?.url).toBe("https://maya-yoga.sites.uno4.dev/");
    expect(latestSite([], [{ slug: "a", url: "https://a" }])?.url).toBe("https://a");
  });
  it("offers the pending question with its default", () => {
    const q = pendingQuestion(transcriptItems(transcript.slice(0, 4)));
    expect(q).toEqual({
      question: "Group classes or private?",
      options: ["Group", "Private", "Both"],
      recommended: "Both",
    });
  });
});

describe("bot_setup", () => {
  const args = {
    name: "Crumb Bakery",
    purpose: "Take orders",
    knowledge: "Menu",
    orders: true,
    greeting: "Hi!",
    fallback: "I'll pass it on",
    text_only: true,
  };
  const draft: AiChatMessage[] = [
    { role: "user", content: "A bot for my bakery" },
    {
      role: "assistant",
      content: "Here it is.",
      tool_calls: [call("b1", "bot_setup", args)],
    },
    tool("b1", { ok: true, state: "draft", token_card: true, free_days: 7, note: "…" }),
  ];
  it("becomes the bot card, current until the person writes", () => {
    const items = transcriptItems(draft);
    const bot = items.at(-1);
    expect(bot).toEqual({
      kind: "bot",
      key: "bot_setup:b1",
      name: "Crumb Bakery",
      state: "draft",
      current: true,
      update: false,
      username: null,
      url: null,
      freeUntil: null,
      freeDays: 7,
    });
    const later = transcriptItems([...draft, { role: "user", content: "ok" }]);
    const old = later.find((i) => i.kind === "bot");
    expect(old?.kind === "bot" && old.current).toBe(false);
  });
  it("knows a settings update of a live bot, and the latest card", () => {
    const items = transcriptItems([
      ...draft,
      { role: "user", content: "Change the greeting" },
      { role: "assistant", content: null, tool_calls: [call("b2", "bot_setup", args)] },
      tool("b2", {
        ok: true,
        state: "live",
        keep_on: true,
        bot_username: "@crumb_bakery_bot",
        bot_url: "https://t.me/crumb_bakery_bot",
        free_until: "Oct 12",
        free_days: 7,
      }),
    ]);
    const bots = items.filter((i) => i.kind === "bot");
    expect(bots.map((b) => b.kind === "bot" && b.update)).toEqual([false, true]);
    const last = bots.at(-1);
    expect(last?.kind === "bot" && [last.username, last.url, last.freeUntil]).toEqual([
      "crumb_bakery_bot",
      "https://t.me/crumb_bakery_bot",
      "Oct 12",
    ]);
    expect(latestBotKey(items)).toBe("bot_setup:b2");
    expect(latestBotKey(transcriptItems(transcript))).toBeNull();
  });
  it("shows nothing for a refused call, and a first guess while it runs", () => {
    const refused = transcriptItems([
      { role: "assistant", content: null, tool_calls: [call("b3", "bot_setup", args)] },
      tool("b3", { ok: false, error: "Not now" }),
    ]);
    expect(refused).toEqual([]);
    const running = transcriptItems([
      { role: "assistant", content: null, tool_calls: [call("b4", "bot_setup", args)] },
    ]);
    expect(running[0]?.kind === "bot" && running[0].state).toBe("draft");
  });
  it("says what Uno is doing", () => {
    expect(liveActivity("bot_setup", 0)).toBe("Setting up your bot…");
  });
});

describe("askQuestions", () => {
  it("drops a (recommended) note the model wrote into the option", () => {
    expect(
      askQuestions({
        question: "Как?",
        options: ["Онлайн (рекомендую)", "Оффлайн"],
        recommended: "Онлайн (рекомендую)",
      }),
    ).toEqual([{ question: "Как?", options: ["Онлайн", "Оффлайн"], recommended: "Онлайн" }]);
  });
  it("reads the old three-questions shape and stars", () => {
    expect(
      askQuestions({ questions: [{ question: "Where?", options: ["Telegram ★", "Email"] }] }),
    ).toEqual([{ question: "Where?", options: ["Telegram", "Email"], recommended: "Telegram" }]);
  });
});

describe("chat language", () => {
  it("answers in the question's language", () => {
    expect(chatLanguage("Как называется студия?")).toBe("ru");
    expect(standardAnswers("ru").justBuild).toBe("Хватит вопросов — делай");
    expect(chatLanguage("¿Dónde recibes las reservas?")).toBe("es");
    expect(chatLanguage("Where should bookings go?")).toBe("en");
  });
  it("says what Uno is doing", () => {
    expect(liveActivity("write_file", 4200)).toBe("Writing the site… 4.2k characters");
    expect(liveActivity("", 0)).toBeNull();
  });
});

describe("meterLine", () => {
  it("shows what pays for Uno AI", () => {
    expect(
      meterLine({
        mode: "free",
        hours: null,
        free: { minutes_left: 52, daily_minutes: 10, verified: true, messages_until_verify: 0 },
        premium: null,
        balance_usd: 0,
      }),
    ).toBe("Free Uno AI · 52 min left");
    expect(
      meterLine({
        mode: "hours",
        hours: { minutes_left: 2280, unlimited: false, renews_at: null },
        premium: { limit: true, left_usd: 12.5, monthly_usd: 30, exhausted: false },
        balance_usd: 0,
      }),
    ).toBe("Uno AI · 38 h left · Premium $13 left");
    expect(meterLine({ mode: "balance", hours: null, premium: null, balance_usd: 0 })).toBeNull();
  });
});

describe("hand-off", () => {
  it("remembers the chat once, and forgets stale ones", () => {
    const mem = new Map<string, string>();
    const s = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    };
    rememberHandoff("w1", 1000, s);
    // Reading leaves it in place until the message reached the computer.
    expect(readHandoff(2000, s)).toEqual({ chatId: "w1", at: 1000 });
    expect(readHandoff(2000, s)).toEqual({ chatId: "w1", at: 1000 });
    // A newer hand-off is not cleared by the older one finishing.
    rememberHandoff("w3", 1500, s);
    clearHandoff("w1", s);
    expect(readHandoff(2000, s)?.chatId).toBe("w3");
    clearHandoff("w3", s);
    expect(readHandoff(2000, s)).toBeNull();
    rememberHandoff("w2", 1000, s);
    expect(readHandoff(1000 + HANDOFF_TTL_MS + 1, s)).toBeNull();
  });
  it("gives the computer's Uno the whole context", () => {
    const p = handoffPrompt({
      title: "yoga",
      messages: transcript,
      sites: [{ slug: "maya-yoga", url: "https://maya-yoga.sites.uno4.dev/", title: "Maya Yoga" }],
    });
    expect(p).toContain("My goal: I teach yoga and want a booking site");
    expect(p).toContain("- Group classes or private? → Both");
    expect(p).toContain("The plan: Booking site for Maya Yoga");
    expect(p).toContain("https://maya-yoga.sites.uno4.dev/");
    expect(p).toContain("Why I need this computer: A real bot lives on your computer.");
    expect(p).not.toContain("THINK-SECRET"); // the model's think never leaves
  });
  it("reads the goal and the live sites back for the chat's card", () => {
    const p = handoffPrompt({
      title: "cafe",
      messages: transcript,
      sites: [
        { slug: "our-cafe-bot", url: "https://our-cafe-bot.uno4.me/", title: "Our Café: orders" },
        { slug: "menu", url: "https://menu.uno4.me/", title: null },
      ] as never,
    });
    expect(isUnoAiHandoff(p)).toBe(true);
    expect(isUnoAiHandoff(`Hi\n${p}`)).toBe(false);
    expect(describeUnoAiHandoff(p)).toEqual({
      goal: "I teach yoga and want a booking site",
      sites: [
        { title: "Our Café: orders", url: "https://our-cafe-bot.uno4.me/" },
        { title: null, url: "https://menu.uno4.me/" },
      ],
    });
  });
});

describe("consoleManageLink", () => {
  it("a chat with a site → that site's page in the console", () => {
    expect(consoleManageLink({ slug: "sun-salute-yoga" }, true)).toEqual({
      href: "https://console.uno.place/sites/sun-salute-yoga",
      label: "Manage site in console",
    });
  });
  it("a bot chat → console Home (the bot's card); otherwise Uno AI", () => {
    expect(consoleManageLink(null, true).href).toBe("https://console.uno.place/");
    expect(consoleManageLink(null, false).href).toBe("https://console.uno.place/ai-usage");
    expect(consoleManageLink({ slug: "" }, false).href).toBe("https://console.uno.place/ai-usage");
  });
});

describe("isSameSite", () => {
  it("a link to the chat's own site (any path) opens on the right", () => {
    const site = "https://sun-salute-yoga.uno4.me/";
    expect(isSameSite("https://sun-salute-yoga.uno4.me/", site)).toBe(true);
    expect(isSameSite("https://SUN-SALUTE-YOGA.uno4.me/#schedule", site)).toBe(true);
    expect(isSameSite("https://other.uno4.me/", site)).toBe(false);
    expect(isSameSite("https://console.uno.place/sites/sun-salute-yoga", site)).toBe(false);
    expect(isSameSite(undefined, site)).toBe(false);
  });
});
