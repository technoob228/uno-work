# Usage data in Uno Work

Uno Work sends a small set of usage events to **Uno**, so we can see how many people use it and which
features and models work for them. Nothing goes to anyone else.

- Events go only to the Uno console (`/api/v1/work/telemetry`), sent with your computer's Uno sign-in.
- A computer that is not signed in to an Uno account sends nothing.
- Your prompts, the agents' replies, files, file names, paths, project names, keys and tokens are never
  sent.
- It is on by default. One setting turns it off: see [Turn it off](#turn-it-off).

## What is sent

Every request carries:

| Field         | Example                         | What it is                                         |
| ------------- | ------------------------------- | -------------------------------------------------- |
| `install_id`  | `3f9c…-…`                       | A random id made once for this installation        |
| `version`     | `0.0.194`                       | Uno Work version                                   |
| `platform`    | `darwin`, `linux`, `win32`      | Operating system                                   |
| `arch`        | `arm64`, `x64`                  | Processor type                                     |
| `client_type` | `desktop-app`, `cli-web-client` | The desktop app, or the server on a cloud computer |

The console links the events to your Uno account (and to the cloud computer, when they come from one).
It does not store your IP address with them.

The events:

| Event                               | When                           | Details sent                                                                                                                  |
| ----------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `server.boot.heartbeat`             | Uno Work starts                | Number of chats and projects                                                                                                  |
| `provider.session.started`          | An agent starts in a chat      | Agent (Claude Code, Codex, Uno…), access mode, and yes/no: resumed, has a folder, has a model                                 |
| `provider.session.recovered`        | A chat reconnects to its agent | Agent, how it reconnected                                                                                                     |
| `provider.session.stopped`          | An agent stops                 | Agent                                                                                                                         |
| `provider.sessions.stopped_all`     | Uno Work shuts down            | Number of running agents                                                                                                      |
| `provider.turn.sent`                | You send a message             | Agent, model name as chosen (including a custom model's name), chat mode, number of attachments, yes/no: the message has text |
| `provider.turn.interrupted`         | You stop an agent              | Agent                                                                                                                         |
| `provider.request.responded`        | You answer an agent's request  | Agent, your answer (allow once, allow for the session, deny, cancel)                                                          |
| `provider.conversation.rolled_back` | You roll a chat back           | Agent, number of turns rolled back                                                                                            |

The code: `apps/server/src/telemetry/` (sending), and the `analytics.record(...)` calls (what each event
holds).

## Turn it off

Set `UNO_WORK_TELEMETRY_ENABLED=false` where Uno Work runs, then restart it. Nothing is sent and no
install id is created after that. `DO_NOT_TRACK=1` works too.

**Mac or Linux, desktop app.** Add this line to `~/.zshrc` (or `~/.bashrc`), then quit Uno Work and open
it again:

```bash
export UNO_WORK_TELEMETRY_ENABLED=false
```

**Windows, desktop app.** In PowerShell, then quit Uno Work and open it again:

```powershell
setx UNO_WORK_TELEMETRY_ENABLED false
```

**Cloud computer or your own server** (Uno Work installed with `install.sh`):

```bash
echo 'UNO_WORK_TELEMETRY_ENABLED=false' | sudo tee -a /etc/uno-work/uno-work.env
sudo systemctl restart uno-work
```

**Running the server yourself:** start it with `UNO_WORK_TELEMETRY_ENABLED=false` in its environment.

## Other connections Uno Work makes

These are part of how the app works, not usage data:

- **The agents and models you use.** Claude Code, Codex, OpenCode, Hermes and Uno AI talk to their own
  providers (Anthropic, OpenAI, Uno AI, the endpoint you set). Each agent follows its own provider's
  rules, including its own usage data.
- **Uno services you use:** the console, Uno Drive, sites, Spark, and Telegram when your assistant is connected to it.
- **Updates:** GitHub Releases for the desktop app, the npm registry for agent updates.
- **Look of the app:** the DM Sans font from Google Fonts and file icons from the jsDelivr CDN.
- **The browser panel:** `one.one.one.one/cdn-cgi/trace` (Cloudflare) to show the address and country
  sites see.
