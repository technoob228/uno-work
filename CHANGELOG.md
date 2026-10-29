# Uno Work — Changelog

История релизов Uno Work desktop-приложения. Артефакты — на странице
[Releases](https://github.com/technoob228/uno-work/releases).

> Mac: auto-update на ad-hoc-signed билдах не работает. После апгрейда —
> вручную качать `Uno-Work.dmg` и перетаскивать в `/Applications`.

---

## v0.0.164 — 2026-10-29

- Claude Code no longer dies in the middle of a long task: when Claude moves a slow command (over 2 minutes) to the background, Uno Work now counts it as work in progress and keeps Claude running until the command finishes and Claude reports the result.

---

## v0.0.163 — 2026-10-29

- Slow or unstable internet no longer drops you out of Work every few seconds: the connection waits out 30-40 s of silence instead of 5 s, coming back to the window doesn't reconnect a working link, and a saved computer that can't be reached anymore (address gone, key changed) stops retrying and says so until you press Reconnect.
- Reconnecting is much faster on a long chat: Work fetches only what you missed instead of the whole history again. On the first load you see "Loading chat…" instead of an empty pane.
- A message you send while the computer is unreachable is no longer lost: it shows in the chat as "waiting to send" and goes out by itself when the link is back (Retry or Discard if the computer refuses it).
- The agent's "open this page" and browser commands sent during a short disconnect are not lost: they arrive after the reconnect.
- Automations: a turn where the assistant paused for a moment is no longer reported as "stopped before finishing" when it did answer. Opening Automations by a direct link or after a reload no longer jumps to Home.
- Join my calls: a sleeping computer now wakes up a few minutes before the call so the notetaker joins it; "next call" skips a call the notetaker is already done with.

---

## v0.0.162 — 2026-10-29

- Apps you or your agent run on the cloud computer show their real data inside Uno Work: Work's page tools now go only into real pages, not into an app's data answers (a counter showed "Count: …" instead of the number).
- Claude Code sign-in: a wrong code now says "That code didn't work. Open the sign-in page again and paste the new code." with "Get a new link"; technical details are under "Details". The sign-in window opens by itself once per computer, also after Work moves to the computer's own address.
- Uno AI Smart and Fast stay first in the OpenCode model picker, even when OpenCode started before it got the Uno AI model list.

---

## v0.0.161 — 2026-10-29

- Loom Work + Notetaker: a screen recording ("Show the agent") also lands in Notetaker, next to your calls, when Notetaker is installed on the computer — the video, what you said and what was on screen line by line, notes and action items with "Ask Uno to do it". The recording card says "Also in Notetaker". Needs Notetaker 0.6.0 (reinstall it from the App Store to update).

---

## v0.0.160 — 2026-10-29

- Uno (the pinned assistant chat) now runs on GLM-5.3 Flash by default: about a second to the first word instead of 5-10 s on Smart. Smart, Fast and the rest stay in the picker; a model you picked yourself is kept.
- Uno's instructions 2026-10-29.1 (accounts with the assistants update): anything that touches a project goes straight to its own chat, with one short line back, so Uno stays free for the next message.
- Home: "Write to Uno in Telegram" disappears once Uno's Telegram is on for this computer.

---

## v0.0.159 — 2026-10-29

- Assistants D + Automations — only for accounts with the assistants update (console ASSISTANTS_MVP / AUTOMATIONS): icons on top of the sidebar, a gallery of three roles, Permission level (Autonomous / Cautious), "What should it do?" as a multi-select, a computer of its own right in the wizard, Uno as the orchestrator, chats on other computers, Telegram for Uno, Join my calls, Automations.
- Everyone else sees Work as in 0.0.158.

---

## v0.0.158 — 2026-10-28

- **Show the agent: record your screen and the agent does it.** A Record button in the chat box and "Show the agent" on Home: share a screen, window or tab, your camera in a corner and your voice. The recording goes to Uno Drive (up to 60 minutes), the agent gets a second-by-second timeline of what you said and where the cursor was, key frames at your clicks and at "here / this", and can look at any moment frame by frame. Your words go into the message box.
- **A recording link opens a player.** Shared recordings play in the browser with a Download button; Safari and iPhone get an MP4 copy.
- **Add a project, where you can see it.** On a new computer with no projects the sidebar shows a full-width "Add a project" button; it goes away after the first project.
- **Browser fixes.** Developer tools are off by default; the ⋯ menu holds everything, with zoom − 100% +.

## v0.0.157 — 2026-10-28

- **Your computer's apps and widgets open inside Uno Work.** An app the agent builds on your cloud computer opens in the panel and in its own window right inside Work, not in the agent's browser stream; its widget appears on Home by itself. The agent registers the app and opens it for you in one step.
- **Claude by default after you sign in, once.** With a Claude plan, Home and New chat start on Claude, and Home shows the model and reasoning. One sign-in to Claude anywhere is enough: new chats and the Uno assistant switch to your Claude plan.
- **Claude Code asks before it spends Uno credits.** Not signed in to Claude Code? You get "Sign in" or "Use Uno credits" before the first message; Settings → Agents has the switch. Computers where Claude Code already ran on Uno credits keep working as before.
- **Submitting the Claude sign-in code shows progress** ("Checking the code with Claude…") and says when the code didn't work, instead of silence.
- **No more "Runtime warning" noise** from Claude Code's service messages.
- **Panel:** closing the panel ends full screen and brings the chat back; the mini chat at the bottom shows formatted text. Apps & sites shows Uno Drive, Terminal and the App Store first.
- No browser permission windows over the first screen (notifications are offered with a line while Uno works); the secret field no longer offers a saved password; a short first message like "Hi" stays the chat's title.

## v0.0.156 — 2026-10-28

- **Big sites publish without timing out, and a password protects them from the first second.** site_publish sends the password (or an IP allowlist) with the upload and waits while Uno finishes publishing in the background.
- **New chat starts on your agent.** If you picked only OpenCode before Work, New chat opens on OpenCode · Smart, like Home.
- **Reconnect for an expired connector finishes.** Gmail, Notion, Drive or GitHub with expired access: Reconnect now waits for the new sign-in, and the agent's "Connect" card no longer says it's connected.

## v0.0.155 — 2026-10-28

- **A long task tells you when it's done.** If a task you started runs 2+ minutes and Uno Work isn't open, Uno sends you a note in Telegram — or by email if Telegram isn't linked: "Your agent finished … Open Uno Work to see the result".
- **You see the agent thinking.** When the model thinks for a long time, the chat shows one quiet line "Thinking it through — …" with its latest words instead of only "Thinking · 5m". Big tasks start with a short 1–3 line plan.
- **"Answered by Smart: no Premium credit" in OpenCode too.** A premium model picked on Uno AI with no premium credit left now says so in OpenCode, with "Add credit" when there's nothing to continue from.
- **Agent names under the picker icons**; in OpenCode the Uno AI models come first, Smart on top.
- **Home starts on your agent.** If you came to Uno for your own agent, Home's box starts on it (or OpenCode · Smart). Picked OpenCode before Work — Home no longer asks you to sign in to Claude Code.

## v0.0.154 — 2026-10-28

- **A long task keeps going when Uno AI hiccups.** If the model doesn't answer in time or is busy, Uno Work tries the turn again by itself (up to 2 times; after "didn't answer" in 15 s, then 45 s) and continues where it stopped, with a line in the chat. You don't need the tab open; the chat shows "working" while it retries.
- **The panel on a phone.** On a narrow screen the agent no longer opens the panel over your chat: you get a chip "Opened … View", and the panel opens as a full-screen sheet with "Back to chat". A page the agent opened no longer puts the panel into "You're in control".
- The agent no longer offers Plus to someone who is already on Plus when the computer sleeps.

## v0.0.153 — 2026-10-23

- **One project across your computers.** The same repository on your laptop and a cloud computer is now one project in the sidebar, with its chats from both, instead of a row per computer. A project is recognised by its own GitHub `origin` (a fork is no longer named after the repository it was forked from) or by its Uno cloud name once it syncs through Uno. Two folders of one repository stay two projects. Devices that kept the old sidebar's "separate" grouping move to this once.

## v0.0.152 — 2026-10-21

- **Rename a project from the sidebar.** Right-click a project, or its ⋯ button, for Rename project and Copy path; double-click the name to rename it. Only the name in the sidebar changes, the folder keeps its own.
- **Private GitHub repositories in New project.** A private repository asks "Continue with GitHub" (the Uno GitHub App), then clones by itself; on a cloud computer git signs in with a token for that one repository, valid one hour, never written to disk.
- **Skills step:** found skills first, your own by link, file or folder; a checkbox turns each on or off.
- **Folder upload** is about 14× faster, shows progress by bytes, keeps going in the background and resumes (also after a reload); it warns at 20,000 files and says what didn't fit.
- Inbox rows show their actions on hover instead of the chip and status; Files columns fit a narrow panel; a long bot name no longer spills out of the Telegram card.

## v0.0.151 — 2026-10-19

- Security: the assistant's scheduled turn answers only from inside the computer (loopback, no forwarded headers), like the manager MCP. The assistant's `.mcp.json` is owner-only (0600), and Claude chats no longer show the uno-work token or MCP addresses in `ps` (passed via env).
- Agents' brief: deploying to Uno / uno.place goes through the uno-work tools or uno.place/llms.txt; never ask the person to sign in in the browser.
- A new chat in a project no longer opens on "Sign in to Codex" when Codex isn't signed in here; projects' untouched Codex default moves to the computer's working model.

## v0.0.150 — 2026-10-19

- **Files from a chat start in the chat's folder.** New tab → Files, or Files in the sidebar while you're in a chat, opens the chat's project folder (not your home folder), and the tab stays with that chat. Each chat keeps its own place. Outside a chat nothing changes.
- A new chat never starts on an agent you aren't signed in to on this computer (no more "Sign in to Codex" in a fresh chat).

## v0.0.149 — 2026-10-19

- **Comment works on your own sites in the web panel.** Open one of your Uno Sites (or your computer's app address) in the panel of Uno Work on the web, and Comment picks any part of the page for the chat, with Debug showing the page's console and network. Other people's sites stay as they were. Where your account doesn't have it yet, nothing changes.
- **Files from a chat open on the right.** Files in a chat is now a tab of the panel, and its button makes it full screen.
- The chat header never clips: at any width, what doesn't fit folds into ⋯.

## v0.0.148 — 2026-10-18

- **Your site from a cloud computer opens right in your browser.** When the agent starts a site on the computer (localhost:5173 and the like) and shows it to you, the panel loads it in your own browser from your Work address instead of streaming the computer's browser: scrolling and clicks are instant, live reload works, and Comment picks any part of it for the chat. The address bar still says localhost. The agent's own clicks on the page still happen in the computer's browser. Where your account doesn't have it yet, nothing changes.
- **The agent knows Uno Spark.** It can deploy a small serverless app to Spark, list, read logs and delete them; streaming answers work, and an app can call a model without a key (`env.AI.chat`, paid from your AI balance).
- When the computer can't be reached for a moment, the update banner says "Couldn't reach this computer just now" instead of showing a proxy's error page.

## v0.0.147 — 2026-10-18

- **The panel follows you between chats.** A tab kept for the project (or everywhere) that you were looking at stays open when you move to another chat of the project (or any chat), even where the panel was hidden. Close the panel on such a tab and it stays closed in those chats too. A chat's own tabs stay in their chat; and if that chat's agent showed you something while you were away, the panel opens with it.
- **Device sizes fit the panel, like DevTools.** Desktop 1280 × 800 (and Mobile, Tablet) in a narrow panel renders at its real size and the picture shrinks to fit, with the zoom next to the size: "1280 × 800 · 62%". Pick Fit, 100%, 75% or 50%; clicks, scrolling and Comment land where you point.

## v0.0.146 — 2026-10-17

- **Tab groups, quieter.** A group's label is just its icon; its name shows when you hover it. "Everywhere" is a house now, so it no longer looks like a browser tab. Empty groups stay hidden and appear only while you drag a tab, so you can drop it there. Tabs no longer carry a group letter.
- **Two browsers in "+".** "Browser · local" comes first: the page opens right in the panel, on the web too, with Comment and Debug as on the Mac. "Browser · agent's computer" is last. On the web, a site at the computer's own address (localhost) still opens in the computer's browser.

## v0.0.145 — 2026-10-17

- **Apps & sites back in order.** An app from the App Store with a brand logo (Notetaker) blew its icon up into a huge white box that broke the list and the app's top bar. The logo now keeps its size everywhere.
- **On the web, a tab in the panel shows the page right there**, through your computer's browser: click, type, scroll, Comment. Sign-ins you make stay on the computer. "Open in my browser" opens it in a tab of yours; the browser extension is one folded line under Advanced. On the Mac nothing changes.
- **Tab groups you can see.** In a chat every group is always there; an empty one is a small dashed slot to drop a tab on. Each tab carries its group's letter (C / P / E), and hovering it says at once where it stays pinned.
- Apps with "Sign in with Uno" open inside Uno Work, already signed in, where Uno supports it.
- Projects move between your cloud computers: `uno project sync` and `uno project get`, through your Uno cloud.
- Security: the file with this computer's key is readable by you only.

## v0.0.144 — 2026-10-17

- **Comment everywhere, like Codex.** In the agent's browser too, on the Mac and on the web: point at a part of the page, click, write a note. It goes to the chat with the element and a screenshot. On the web, your site at the computer's own address (localhost) opens in the computer's browser in the panel, so you can comment on it there.
- Your browser comes first in the panel; the agent's browser is last and quieter. The web version no longer asks you to install an extension: a site opens in a new tab of your browser.
- Tabs: drag a tab into any group, including an empty one. Each tab shows its group (chat, project, everywhere), and hovering says where it stays pinned.
- Files with the panel open: a click opens the file on the right as a tab, and the empty middle column is gone. In a chat, files and pictures open on the right and the chat stays where it is.
- A new document opens right away as "Untitled 1, 2…": click its name to rename it. "Copy path" in a file's actions.
- Share: "Copy link and password" appears once the link is made.
- Files and previews open faster, and big folders show at once.
- Apps can open by their own private https address with Uno sign-in, where your account has it: instantly and from any device, only you get in.

## v0.0.143 — 2026-10-17

- The agent knows what its computer has: it warns when the disk or memory is nearly full and says what to do, and it can free space by clearing caches (never your files or the trash).
- Documents the agent saves to Cloud storage keep their earlier versions.
- The `uno` command in every agent's terminal: status, cleanup, Cloud storage (put, get, list, link), guide.
- When memory runs out, the heaviest build is stopped instead of the whole computer.

## v0.0.142 — 2026-10-17

- The model picker is T3's again: your harnesses in a column on the left — **Uno Hermes** first, then Uno Code, Claude, Codex and the rest — with search and the models on the right. The button shows the harness's icon and the model.
- Apps look clean: no dots or badges on the icons. Under the name it says Stopped or Didn't start when that's so, and 🌐 when it's on the internet.
- An app you showed on the internet opens in Uno Work again (it used to stay blank). Its settings now say plainly what "Show on the internet" does: anyone with the address can open it, with no sign-in and no encryption — you don't need it to use the app yourself.
- A notification from an app on a cloud computer opens the app.
- Files and the Disk view stay quick on a full disk: measuring folders no longer holds the disk up, and Disk shows the last measurement at once.

## v0.0.141 — 2026-10-17

- A click on an app opens it, like on a computer. An app with a web page opens in its window inside Uno Work — on a cloud computer, apps that answer only inside it open in the computer's own browser. A Telegram bot opens in Telegram.
- A stopped app starts when you click it: its window says "Starting…" and shows the app when it answers.
- Settings are behind ⚙ — on the app (when you point at it), on a right-click, and in the app's window: address, show on the internet, start/stop, remove. An app with nothing to open (a script) opens its settings.
- On for everyone now (each can be switched off in Settings → Labs):
  - Two browsers in the panel: **Your site** (first, the default) and the **Agent's browser**, where you take control to sign in for it; a card in the chat says when the agent needs you there. Apps is always in the launcher; the terminal stays on Ctrl+`.
  - Desktop app: **Comment** on your site — point at parts of the page and leave notes for the agent; the page's console and network show below, and errors go to the chat.
  - A tab on the whole screen keeps the chat as one compact block that folds into a mini window; answers pop up as a hint.
  - Tab groups like in Chrome: This chat → Project → Everywhere. Drag a tab within a group or into another one; click a group's label to fold it. New tabs go to the chat's group.
  - The sidebar's title picks the view (projects, one list, inbox, by computer) and filters by project; a folded project keeps only the chat you're in.
  - ↗ on a file in the panel: open it in your editor, or share it with a link.

## v0.0.140 — 2026-10-16

- Putting your AI agent on a server: arriving from the console with Claude Code or Codex, its own sign-in opens by itself (subscription first, API key below). Once signed in, new chats start on it.
- Next step leads you through the rest: a project (folder, .zip or GitHub), skills, tools, Telegram or Slack, then the first task.
- "Sign in to Claude" instead of a false "You were signed out of Claude" on a computer where you never signed in. In Telegram's in-app browser the sign-in tells you to open the link in Safari or Chrome.
- Settings → Assistants & phone: Slack is there too.

## v0.0.139 — 2026-10-16

- Sharing a file with a password (Files → Share): **Generate** fills in a readable random password, **Copy** copies it, and **Copy link and password** copies both at once.
- Security: a computer started from a memory snapshot gets its own assistant tokens (old ones stop working), and agent-only routes answer only from inside the computer. On the first start of 0.0.139 every computer renews its assistant tokens once.
- Wording: the model picker and the chat header say "Uno AI" instead of "Uno gateway"; clearer permission descriptions when connecting tools; your MCP servers show as "name · your MCP server" with the address shortened.
- For the stage channel only (Misha's stage computer and the "Uno Work Stage" desktop app), behind Labs flags that are off and hidden everywhere else: two browsers in the panel (your site and the agent's browser), Comment and Debug in the desktop browser, a compact chat on a full-screen tab, tab groups like Chrome (This chat → Project → Everywhere, drag to move, click a label to collapse), the sidebar's view menu and a folded project that keeps only the open chat, Uno's chats in the sidebar, and ↗ on a file (open in your editor or share with a link).

## v0.0.138 — 2026-10-16

- A chat you move from Uno AI to your new computer (or with Continue on this computer) now waits for Uno's engine and starts on Uno, instead of opening on Claude Code that is not signed in («Not logged in»). The Continue button waits until Uno is ready.

## v0.0.137 — 2026-10-15

- Attach any file to a chat — documents, spreadsheets, slides, archives, code — by the paperclip, paste or drag & drop, in a chat or on Home. The file goes straight to ~/Uploads/<year-month> on your computer (never made executable), and the model is told where it is. Pictures work as before.
- Download on every file open in the right panel: pictures, PDF, Word/Excel/PowerPoint, Markdown, code, CSV, web pages, attachments. Files on your computer download whole, without the old 25 MB limit.
- New chat is back at the top of the sidebar, next to Add a project.

## v0.0.136 — 2026-10-15

- ⌘J (Ctrl+J on Windows and Linux) opens and closes the panel. The terminal moved to Ctrl+` (as in VS Code), also from inside the terminal. If you never changed these keys, Work moves them for you; keys you set yourself stay as they are.

## v0.0.135 — 2026-10-15

- One "Panel" button in the chat header instead of the folder, globe and panel icons. The dot still says something new is in the panel.
- An empty panel (and "+" in its tab strip) shows big tiles: Browser, Files, Terminal, Changes, Apps, Sites — press the letter to open. Tiles that make no sense here are hidden, not greyed out.
- Browser opens a tab right away. On a cloud computer it is the computer's browser: live picture, Take control / Hand back. If the browser can't start, the tab says why with "Try again" instead of nothing happening.
- In the desktop app, the browser tab's address bar has "Opens in": this app or the computer's browser, with "Use by default".

## v0.0.134 — 2026-10-15

- Files works like an editor: Tree is the default, a file opens on the right and you edit it in place; "Recent" shows files you opened and files agents changed (All / Opened / By agents). In the narrow tree column List / Tree / Recent are icons, so nothing spills over the open file.
- A file opened from a chat opens beside the chat; Download button on a file in the right panel; Tasks / Plan opens as a tab in the right panel.
- Needs you: approvals get Allow / Decline / View, questions get Open chat / Skip for now.
- Chat attachments are saved to ~/Uploads/<year-month> and the model is told where they are; the assistant brief says where your files are, and Drive files can be brought onto the disk.
- The assistant and your chats see each other: the assistant can find and read the chats it started and you started.
- Settings → AI → Assistant: choose what Uno thinks with — Uno AI, your Claude plan, your ChatGPT plan or your own key. The Claude plan sets itself up on first pick; Hermes updates in place (~200 MB) instead of a 2.5 GB installer.
- Sidebar: each group shows five chats, the rest behind "Show N more".
- Fewer stuck chats: OpenCode reconnects its event stream and finishes a turn that ended while it was disconnected; subagent approvals reach the main chat; full access approves OpenCode permission prompts by itself; Hermes no longer hangs on a cancel it ignores.

## v0.0.133 — 2026-10-15

- Settings → AI: "New chats start on" — keep "The last one I picked" or choose one model every new chat starts on (Home, New chat, ⌘N, a new chat in a folder). Picking another model inside a chat changes only that chat.
- Codex signed in with ChatGPT no longer shows "You were signed out of Codex": newer Codex versions answer the sign-in check differently, Work now reads it right.
- "Work in" lists the folders you worked in last, newest chat first (a folder used every day could fall off the list).
- "Your Uno computers" shows only computers you can open, "on" first, three at a time; archived ones stay in the Uno console.
- The sidebar header no longer has a second New chat icon (Home right below does the same); the account name gets the room.
- Read keeps a chat where it is; Read, Snooze and Done on chat rows and in the right-click menu.
- Files: Tree view next to List, back / forward / up arrows.
- A pinned app or document opens beside the chat, with "Open full screen".
- Settings → AI: the assistant's AI moved here; Agents list (Claude, ChatGPT, OpenCode, Cursor) with a sign-in that survives a closed tab, custom harnesses, AI provider keys.

## v0.0.132 — 2026-10-13

- Home hints: instead of "Next step for «title»", a small model reads the end of your last chats and suggests concrete follow-ups (an open item, a failing check, a promised step) in the language of the chat. Needs Uno AI; without it, no hints from chats. Cached for a few hours.
- The chat status "Your turn" is now called "Ready".
- Home no longer flashes the blue next-step card (for example "Connect Telegram") for a step you already put off with "Not now".

## v0.0.131 — 2026-10-13

- Home: pictures can be attached to the first message — paste a screenshot, drop it on the box or use the paperclip. Effort (and the other traits) can be picked next to the model.
- Home: a dropped file is no longer taken for a project; only a folder or a `.zip` is. Pictures are attached.
- Home: a Terminal button next to the computer.
- No more "Image support is unknown" for Claude and Codex.

## v0.0.130 — 2026-10-12

- "I have a project": a GitHub link pasted without `https://` (`github.com/owner/repo`) is taken as it is.
- Markdown editor: the Bold tool no longer lights up just because the caret stands in a heading.

## v0.0.129 — 2026-10-12

- Markdown editor: formatting tools above the document — Text and Heading 1–3, bold, italic, strikethrough, code, link, bulleted, numbered and to-do lists, quote. A press never drops your selection, and the tools light up for what the caret stands in.
- Markdown editor: type markdown and it becomes the block — `# `, `## `, `### `, `- `, `1. `, `> `, `[] ` at the start of a line. Shortcuts: ⌘B, ⌘I, ⌘⇧X, ⌘E, ⌘K, ⌘⌥1–3 and ⌘⌥0, ⌘⇧7/8/9; Tab and Shift+Tab move a list item a level in and out. To-do boxes can be ticked right in the document.
- "I have a project" takes a project any way it comes: a folder, a .zip, a few separate files, a GitHub link — or only a few words about it, with no folder at all. What you write under "Tell Uno about it" becomes the first message of the project's chat.

## v0.0.128 — 2026-10-11

- Home: the hints under the box come from your own work — the chats you had, app notifications, documents and sites — and no longer guess from what merely sits on the computer ("Add a login page to…", "Tidy up…" are gone). With fewer than two projects the row starts with what helps to get on board: "Learn Uno Work" and "Uno cloud services".
- Home: "Customize" is now "Customize widgets" and sits above the widgets it changes.
- Cloud storage and Uno Drive say what the used space is when it isn't files: "3.6 GB of it is backups of your computers". Backups count toward the plan but were invisible next to an empty file list.

## v0.0.127 — 2026-10-11

- Files: a markdown file now edits as the document it reads as — click into the text and type, no markup in sight. "Code" in the editor's toolbar switches to the source with its live preview, "Document" switches back; the editor opens the way you used it last.
- Saving from the document touches only what you changed: every heading, paragraph, list or table you didn't edit is written back exactly as it was in the file, with its own style of markup. Tables, task lists, footnotes and code blocks stay what they were.
- The right panel's "Edit" on a markdown file saves the same careful way (it used to rewrite the whole file and could flatten tables).

## v0.0.126 — 2026-10-11

- Chats: "Read". A chat that finished and waits for you can be marked as read — the Read button next to Done in the chat's header, or "Mark as read" in the chat's menu. It stops asking for "Your turn" and stays in its place in the list; the next finished answer asks again, and "Mark unread" brings it back. The mark is kept in this browser.
- Home: the quiet line under the box now reads "Give this computer to your local agent".

## v0.0.125 — 2026-10-11

- Uno Work in the browser: "Continue on another machine" is gone from the chat header and the chat's menu. It stays in the desktop app, where you have several computers at hand.

## v0.0.124 — 2026-10-11

- The sidebar has two modes. Classic, the default: every project you added is always in the sidebar with its chats, then Recents. Inbox: chats grouped by status — Needs you, Your turn, Failed, Working, Idle, Snoozed.
- Switch in Settings → General → "Inbox sidebar". The grouping menu on the "Chats" line is gone; "Add a project" stays there.
- Snoozed chats have their own place again: a "Snoozed" shelf above Done in classic, a "Snoozed" section in the inbox.

## v0.0.123 — 2026-10-11

- Apps that open in their own tab: the page that says so now tells you what the app is, in the app's own words.
- After the first time, a click on such an app opens its tab right away.

## v0.0.122 — 2026-10-11

- Sidebar: the folder icon on the "Chats" line is now "Add a project". It asks where the project comes from: your laptop, a folder on this computer, Cloud storage, GitHub, or an empty folder.
- New: a project from Cloud storage. Pick a folder in your Uno cloud; a copy goes to ~/projects and opens as a project. The cloud copy stays.
- From GitHub: the card now says you can paste a repository link.

## v0.0.121 — 2026-10-11

- Home: the "Uno Work is updated" notice can be closed. It used to stay on Home for a day with no way to hide it.
- Sidebar: the "Group chats by" menu closes once you pick.

## v0.0.120 — 2026-10-11

- Sidebar: group your chats by project or by status. The new control sits on the "Chats" line. By status, what waits for you comes first: Needs you, Your turn, Failed, Working, Idle.
- Sidebar: "Upload a folder as a project" — one click on the "Chats" line brings a folder or a .zip from your laptop to this computer as a project. While you have no projects yet, the same button is a row in the list.

## v0.0.119 — 2026-10-09

- A new cloud computer works right away: Files, New project, new chats and Update no longer fail with "Environment API not found" until the computer restarts.
- Telegram and Slack: every message gets its own real answer, quoted as a reply to it, however long the work takes. No more "still working, check the app". Long answers arrive in full, in parts. While Uno works you see "typing" (Slack: an hourglass reaction) and a short note at 3 and 15 minutes. If Uno Work restarts mid-task, the task runs again and the answer still comes.

## v0.0.118 — 2026-10-09

- Files of any size go to the Uno cloud: Copy to Cloud, Uno Drive, project materials, Office saves and app storage no longer skip files bigger than 256 MB. Big files upload in parts; the limit is your cloud storage plan.

## v0.0.117 — 2026-10-09

- Switching computers in the browser always shows the interface of the computer you switch to. If it runs another Uno Work version, the page opens it in its own version (Uno remembers your choice: app.uno4.work opens that computer next time too).
- "A new version of Uno Work is ready · Reload" appears on every screen when the computer you use runs a newer Uno Work than the page — not only inside a chat.
- After an update, a tab that still runs the previous version reloads by itself instead of breaking on a missing file.

## v0.0.116 — 2026-10-08

- Home is one click away again: a "Home" row on top of the sidebar (and a house on the folded rail) opens the start screen from any chat, file or app. The web version without a computer has the same "Home" row.
- Home: "In progress" can be hidden — "Hide" next to its title (Undo in the toast). It stays hidden on this device; Customize → Add widget → "In progress" brings it back.
- Sidebar: "Needs you" shows only when an approval or a question really waits for you, with their number — no more "Needs you" with nothing in it.
- New computers start warm: the image keeps OpenCode's plugin files, so the first chat doesn't wait for a download.

## v0.0.115 — 2026-10-08

- Agents can write into any free chat, also one you wrote in — "Hand back to agent" is gone. To keep agents out of a chat: right-click it → "Don't let agents write here" (or the strip above the input); agents then get "The person closed this chat to agents". The same button lets them back.
- New chat: the folder chip ("Home folder ▾") also makes folders — "New folder…", "Upload a folder…", "Clone from GitHub…". The new folder goes to ~/projects and the chat moves into it with what you typed. A folder or a .zip dropped on a new chat does the same as "Upload a folder…"; pictures and videos stay attachments. "Empty project" and "From GitHub" also put the folder in ~/projects now. A fresh computer's empty sidebar says "No chats yet" with New chat and Add a project.
- Update: after Uno Work updates itself, Security gets the line "You updated Uno Work to … (was …)" — the computer now waits for the update to finish before telling the console.
- Computers started from a memory snapshot (the fast start) keep their own sign-in key on disk: restarting or updating Uno Work no longer signs the person out, and every such computer has its own environment id. Saving keys on such a computer works again.

## v0.0.114 — 2026-10-08

- Right panel: when a chat is marked Done or archived (or deleted), everything open in that chat's panel closes — browser tabs, site previews, files, apps. On the desktop app their pages are unloaded too. Tabs pinned to the project or "everywhere" stay. A chat brought back from Done or the archive starts with an empty panel.
- Sidebar (legacy, with projects): Done chats fold into one "Done · N" row under each project, like Snoozed; click to unfold. Archived chats never show in the sidebar (Settings → Archived chats, as before). The standard sidebar already folded them; in Dev mode its shelf now says "Done" instead of "Settled".

## v0.0.113 — 2026-10-08

- Uno Work updates itself on a cloud computer: "A new version of Uno Work is ready · Update" (above the chat, on Home, in My Uno). The owner presses Update, the computer downloads the release from the Uno console over HTTPS, checks it against the console's checksum list, installs it and restarts Uno Work once (about two minutes); if the new version doesn't start, the computer goes back to the previous one by itself. Chats and files are not touched. Only an owner session can start it; agents have no tool for it. The update shows up in Security ("You updated Uno Work to …"). Computers get the button with 0.0.113 — older ones need one last manual update.
- Chat: "AI is busy" and "the model didn't answer" are calm lines with "Try again" (it sends your last message again); "busy" counts down and retries once by itself. Other failed turns get "Try again" too. "AI time is used up" says the date and keeps addresses in the buttons.
- My Uno → Plan & billing matches the console: a cancelled plan says "Ends on …, no more charges" with "Keep my plan" (opens the console in a new tab); the Always on tile shows memory only, so cores read the same as on the computer.
- Home: "Describe your site / bot" opens the chat where you already described it, not a new one. "Connect with SSH" is no longer the first advice unless you picked the server goal or use Dev mode — it sits under the card as "For developers".
- Light chat: when Uno didn't finish in one go the button says "Continue". The agent asks "open to everyone or by password?" before publishing a personal page and gives the link to form entries after publishing a site with a form.
- Files: one line says what "This computer" and "Cloud storage" are (the computer's files go with it; Cloud storage stays and keeps copies of computers); project and app folders carry a small tag.
- Economy: a command your agent left running (a build, a script under nohup, a background shell) keeps the computer awake until it ends; the computer's status names it ("python3 is still running").
- Computer menu: the Economy switch explains itself in one line. Browser panel: "The agent is using this browser" goes away when the agent's turn ends. Phone (390): the chips under Home's input no longer run past its edge.

## v0.0.112 — 2026-10-07

- Smart paused after the AI time (plans with unlimited Fast, console flag `AI_SMART_STOP`): a strip above the composer of Uno Code / Hermes chats says "Smart is paused until you add AI time. Fast keeps working." with "Add AI time — +15 h for $10" (the pack checkout in the console, new tab); Home and My Uno say the same; the premium line steps aside (Fast answers premium then too).
- AI time used up: the billing banner and the light chat's stop card lead with "Add AI time" — straight to the pack checkout.
- Light Uno Work: "Start free — 3 days" only while the console has free trial places; otherwise "Get Plus — $20/mo" and "Free trials are paused right now."
- Sites: "Entries" at every site (chat card, site panel, Apps & sites, My Uno) opens the site's form entries in the console; "Manage in console" from a chat goes to that site's page (a bot chat → Home), not to Uno AI.
- Links in chats: your own sites, apps and previews open in the right panel; the console and other web links open in a new tab (the system browser on desktop).
- Sidebar: grey rows while the computer's chats load, instead of a flash of "No chats yet".

## v0.0.111 — 2026-10-07

- The console sees what is built on a Uno Work computer: the computer reports its apps (name, port, running or not — no commands, paths or env) to the console, where they show up in the computer's Apps tab under "Built on this computer". Sent when the list changes or every 10 minutes; a computer cloned from a memory snapshot sends it at once.
- My Uno → Plan & billing says "AI time" instead of "hours" ("Smart uses your AI time", "after your AI time runs out").

## v0.0.110 — 2026-10-06

- Free Telegram bot in the Uno AI chat: when Uno saves the bot (bot_setup), a card with Open @BotFather and a safe field for the token appears right in the chat; a pasted token never goes into the chat; "Live" tile in the light sidebar with the bot's answers and "Keep it on".
- My Uno → Plan & billing for "Always on + boosts" plans: Always on, boosts and AI time instead of RAM hours; Add computer over the plan explains running on boosts.
- "AI time" is the Uno AI unit everywhere (no more visible "AI hours").
- Assistant quiz in the light Work: on a plan that already has cloud Uno Work, "Set it up" opens Uno Work with the answers right away, without the plan step.

## v0.0.109 — 2026-10-05

- Personal assistant lives in the person's own Telegram bot: a "Create your assistant's bot" card (Open @BotFather, three steps, token check), greeting in the person's language; service notifications from the computer go through Uno's bot under "💻 From your Uno computer".
- Asking for a bot or an assistant: the token is the first step, before any work; a bot token card with Open @BotFather; skipping the token is a grey line, not a bubble.
- Uno suggests the assistant it already has instead of building a new bot; "Changed N files" folded under an answer, paths with `~`; agent rules for saving context (subagents, ranged reads).
- Connection status said quietly in the computer chip and menu, no reconnect toasts.
- Light mode sidebar matches the full app (Uno Work ▾, ✎, chats, account menu).
- Assistant quiz on Home and in light Uno AI; "Skip for now" carries the brief into the chat.
- Client side of a per-account Uno Work address (`<label>.uno4.work`), off until the backend flag.
- Hermes retries 3 times (the Uno AI gateway retries on a fallback model itself).

## v0.0.28 — 2026-05-23

Веб-поиск в Uno-харнессе, инлайн-редактор в preview-панели, синхронизация
fullscreen-состояния окна с фронтом и обновлённый маркетинговый лендинг.

### Feature 1 — Brave-powered web search через bundled MCP-мост

Uno-харнесс получает tool `web_search(query, count?, country?, freshness?)`,
который проксирует запрос на `POST api.getuno.xyz/v1/search` (Brave Search
под капотом, биллинг через `users.llm_balance`). Ключ Brave хранится только
на Gateway — десктоп его не видит.

- `apps/desktop/resources/mcp/uno-search.mjs` — stdio MCP-сервер без
  внешних зависимостей (≈200 строк, line-delimited JSON-RPC 2.0).
- `apps/desktop/src/main.ts` — `backendChildEnv()` пробрасывает
  `UNO_MCP_SEARCH_SCRIPT` + `UNO_MCP_NODE_BIN` (Electron в режиме
  `ELECTRON_RUN_AS_NODE=1` работает как Node-интерпретатор).
- `apps/server/src/provider/Drivers/UnoDriver.ts` — при наличии
  `serverSettings.uno.apiKey` и bundled-скрипта в `OPENCODE_CONFIG_CONTENT`
  добавляется секция `mcp["uno-search"]` типа `local`.
- `apps/web/src/components/settings/SettingsPanels.tsx` — в Uno account
  секции появилась строка **Web search** с бейджем Active/Inactive.

Активируется автоматически когда в Settings привязан Uno API-ключ. Без
ключа индикатор «Inactive», MCP-секция в конфиге uno-code не появляется.

### Feature 2 — инлайн-редактор в preview-панели

Preview-панель умеет редактировать markdown-документы прямо в overlay-
панели: кнопка «карандаш» переключает между ReactMarkdown-выводом и
текстовым редактором, изменения сохраняются через `turndown` обратно в
исходный файл.

- `apps/web/src/components/preview/PreviewPane.tsx` — режим редактора,
  `detectFileKind`-экспорт, EnvironmentId-скоупинг для multi-environment
  set-ups.
- `apps/web/package.json` — добавлены `turndown` + `@types/turndown`.

### Feature 3 — синхронизация fullscreen-состояния окна с рендером

Renderer получает события `desktop:window-fullscreen-state` и проставляет
класс `is-fullscreen` на `<html>`. Используется для корректного отступа
под traffic-light кнопки и для адаптации chrome в полноэкранном режиме.

- `apps/desktop/src/main.ts` + `apps/desktop/src/preload.ts` — IPC-каналы
  `desktop:window-fullscreen-state` и `desktop:window-fullscreen-get-state`.
- `apps/web/src/lib/windowFullscreen.ts` — `syncDocumentFullscreenClass()`
  с теплым стартом и подпиской.
- `apps/web/src/main.tsx`, `apps/web/src/index.css` — подключение в
  bootstrap + базовые стили.
- `packages/contracts/src/ipc.ts` — `getWindowFullscreenState` и
  `onWindowFullscreenChange` в типах `DesktopBridge`.

### Feature 4 — refresh Uno snapshot после установки uno-code

После того как silent-installer допроливает `uno-code`, Uno-провайдер
автоматически перечитывает модели — больше не нужно дёргать ручной
«Re-detect».

- `apps/web/src/lib/desktopUnoCodeReactQuery.ts` — отслеживает переход
  `pending → installed`, инвалидирует Uno-snapshot ровно один раз.

### Feature 5 — рефакторинг ProviderPresentation

`OpenCodeProvider` экспортирует `ProviderPresentation` — общий интерфейс
(displayName, binaryCommand, minimumVersion, showInteractionModeToggle)
для `OpenCodeDriver` и `UnoDriver`. Раньше Uno-driver дублировал константы
руками; теперь обе ветки используют один источник истины.

- `apps/server/src/provider/Layers/OpenCodeProvider.ts` — вытащен
  `ProviderPresentation` и сделан параметром
  `checkOpenCodeProviderStatus`/`makePendingOpenCodeProvider`.
- `apps/server/src/provider/Drivers/UnoDriver.ts` — переключён на новый
  параметр; константа `UNO_PRESENTATION` живёт рядом с драйвером.

### Fix — ClaudeAdapter: providerRefs после завершения turn

После того как turn завершался, `context.turnState` сбрасывался в
`undefined` и `providerRefs.turnId` пропадал — UI терял возможность
сослаться на последний turn. Сохраняем `lastCompletedTurnId` и
возвращаем его в `providerRefs`, пока новый turn не стартовал.

- `apps/server/src/provider/Layers/ClaudeAdapter.ts` — добавлено поле
  `lastCompletedTurnId` в `ClaudeSessionContext`.

### Marketing — обновлённый лендинг и CI

- `apps/marketing/src/pages/index.astro`, `apps/marketing/src/pages/download.astro`,
  `apps/marketing/src/layouts/Layout.astro` — освежены копирайт и блоки.
- `apps/marketing/public/favicon.svg`, `apps/marketing/public/logos/*`,
  `apple-touch-icon.png`, `favicon-*.png`, `favicon.ico`, `icon.png` —
  единый набор бренд-ассетов.
- `.github/workflows/marketing-storage.yml` — workflow публикации
  `apps/marketing` в UNO Storage по push в main.

### Docs — roadmap

`UNO_ROADMAP.md`: добавлен блок **Claude Billing Profiles And Fallback**
(подписка/Agent SDK/API/Bedrock/Vertex/Uno Gateway, безопасный restart +
resume, «Continue with …» recovery action).

---

## v0.0.27 — 2026-05-22

Фикс каскада из 5 багов, ломавших онбординг на чистом маке после v0.0.26.

### Bug A — codex как дефолтный text-gen провайдер

На чистой установке UI первым делом показывал ошибку
_"Codex provider status: Codex CLI not installed"_: schema по умолчанию
устанавливала `textGenerationModelSelection.instanceId = codex`, хотя продукт
называется Uno Work. Пользователь видел «у вас ничего не работает» вместо
«выберите провайдер».

- `packages/contracts/src/settings.ts` — дефолт `textGenerationModelSelection`
  переключён с `codex` на `uno`.

Существующие пользователи с уже сохранённым `codex` остаются на `codex`
(`withDecodingDefault` не перезаписывает значения). Новые ставят `uno`.

### Bug B — установщик встроенного харнесса Uno Code

#### B-i: релизы

В репо `technoob228/uno-code` не было ни одного релиза, инсталлер ловил 404
от `releases/latest` и крашился с `release-fetch-failed`.

Опубликован релиз `uno-v1.14.48-uno.1`: darwin-arm64, linux-x64, linux-arm64,
windows-x64. Intel Mac не публикуется (macos-13 free-tier runners висят в
очереди > 24ч) — фоллбэк через graceful-баннер из B-ii.

- `~/uno-project/uno-code/.github/workflows/uno-release.yml` — убрана
  `macos-13` из матрицы, добавлен комментарий с обоснованием.

#### B-ii: graceful 404

Если для текущей платформы релиза нет — раньше падало с криптическим
`GitHub API returned 404 ...`. Теперь — `release-not-published` /
`asset-missing` с человекочитаемым описанием и ссылкой на Settings → Uno →
custom binary path.

- `apps/desktop/src/unoCodeInstaller.ts` — отдельный код ошибки
  `release-not-published`, расширены сообщения для `asset-missing`.
- `apps/web/src/components/onboarding/steps/HarnessesStep.tsx` —
  non-blocking amber-баннер вместо блокирующей ошибки, варианты строк
  `bundled-installing` / `bundled-failed`, кнопка **Retry** через
  `desktopBridge.retryUnoCodeInstall()`.

### Bug C — UnoSettings schema + driver

В model picker'е Uno-провайдер показывал тултип _"OpenCode CLI (`opencode`)
is not installed"_ потому что:

- В schema под ключом `providers.uno` лежал `OpenCodeSettings` (binaryPath
  по умолчанию = `opencode`).
- После установки Uno Code путь писался в `providers.opencode.binaryPath`,
  а не в `providers.uno`.
- `UnoDriver` хардкодил `~/.unowork/uno-code/bin/uno-code` и игнорировал
  config.binaryPath, так что custom binary path из Settings никуда не
  доходил.

Все три ниточки чиним:

- `packages/contracts/src/settings.ts` — новый
  `UnoProviderSettings` (зеркало `OpenCodeSettings`, но
  `binaryPath` default = `uno-code`). `providers.uno` теперь использует его.
- `apps/desktop/src/main.ts` — `writeOpenCodeBinaryPathToSettings`
  переименован в `writeUnoBinaryPathToSettings`, целевой slot —
  `providers.uno.binaryPath`.
- `apps/server/src/provider/Drivers/UnoDriver.ts` —
  `binaryPath: config.binaryPath?.trim() || UNO_BINARY_PATH`. Status banner
  перестаёт врать, юзер может указать кастомный бинарь через Settings
  (важно для bring-your-own-binary сценария из B-ii).

Миграция не нужна: все поля используют `withDecodingDefault`, on-disk
`{ binaryPath: "opencode" }` валиден и просто перезапишется на следующее
обновление.

### Bug D — Uno API key терялся после рестарта

Пользователь вводил Uno key → Connect → видел Connected → после рестарта
поле пустое.

Корень: `useUpdateSettings` делал fire-and-forget RPC и optimistic UI
update без `await`. Если онбординг закрывался раньше, чем долетал ответ
сервера — запись на диск не успевала.

- `apps/web/src/hooks/useSettings.ts` — `updateSettings` теперь
  `await`-ит RPC, возвращает `Promise<void>`, на ошибку показывает
  toast. Убран guard `if (currentServerConfig)`, который молча скипал
  optimistic apply.
- `apps/web/src/routes/onboarding.tsx` — `beforeLoad` ждёт
  `startServerStateSync()` перед рендером.
- `apps/web/src/components/onboarding/steps/UnoLlmStep.tsx` — `handleConnect`
  стал `async`, кнопка показывает inline loading state, на ошибку
  оставляет draft в поле.

### Bug E — Welcome копирайт

Старое: _"Local-first, with optional remote power when you need it"_ — не
объясняло, что именно делать в приложении.

- `apps/web/src/components/onboarding/steps/WelcomeStep.tsx` — теперь:
  _"work on code, text files, tables, with all context of your data,
  stored locally"_.

---

## v0.0.26 — 2026-05-20

Major feature release. Подробности — в
[memory snapshot v0.0.26](https://github.com/technoob228/uno-work/releases/tag/v0.0.26).

- Full-screen 7-step онбординг-визард (заменил старый API-key диалог).
- Uno LLM Gateway driver (отдельный provider kind).
- Uno Code auto-install при первом запуске (macOS + Windows).
- Marketing landing page редизайн.
- Env-switching фикс (помним последний thread в env).
- Preview pane scoped по проекту.
- Брендинг «OpenCode» → «Uno Code».
- README переписан под Uno Work.
