# Custom harnesses — bring your own agent into Uno Work

Uno Work can run **your own agent** in its chat, next to the built-in ones (Uno, Claude, Codex, OpenCode, Hermes…): an agent you wrote, or a third-party CLI such as Gemini CLI, `opencode`, Goose, Kimi Code — anything installed on the machine that speaks the **Agent Client Protocol (ACP)**.

You get the same chat UI as the built-in agents: streaming answers, tool calls with diffs, plans, Approve / Deny cards, the model picker, per-chat sessions, stop/resume.

This page is the contract. It is written for people **and** for AI agents: an agent on the machine can add a harness for the person by writing one JSON file (see [Register a harness](#register-a-harness)).

---

## 1. Protocol: ACP over stdio

A harness is a program Uno Work starts as a child process. They talk **JSON-RPC 2.0, one JSON object per line** (UTF-8, `\n`-delimited) over the program's **stdin/stdout** — this is the [Agent Client Protocol](https://agentclientprotocol.com), protocol version **1**. The program's **stderr** is free-form logs: Uno Work keeps the last few KB and shows them when something fails.

Uno Work is the ACP _client_; your program is the ACP _agent_.

### Lifecycle

One process per chat (thread). For each chat Uno Work:

1. **spawns** `command args…` (no shell), with the working directory and environment described below;
2. sends **`initialize`** `{protocolVersion: 1, clientCapabilities: {fs: {readTextFile: false, writeTextFile: false}, terminal: false}, clientInfo: {name: "uno-work", version}}`;
3. sends **`authenticate`** `{methodId}` — only if the harness has an `authMethod` configured;
4. sends **`session/new`** `{cwd, mcpServers}` — or **`session/load`** `{sessionId, cwd, mcpServers}` when a chat that was already running is resumed (after a restart or an idle stop). If `session/load` fails, a new session is created;
5. for every message the person sends: **`session/prompt`** `{sessionId, prompt: ContentBlock[]}`, and renders your **`session/update`** notifications until your prompt response `{stopReason}` arrives. Prompts of one chat are sent one at a time — the next `session/prompt` is sent only after the previous one returned;
6. **`session/cancel`** `{sessionId}` (a notification) when the person presses Stop — answer the running prompt with `{stopReason: "cancelled"}` as soon as you can;
7. when the chat is closed, the harness is switched off, or the chat has been idle long enough for Uno Work's session reaper, the process is **terminated** (stdin closed, then signals). Keep your state on disk if you want `session/load` to work.

### What Uno Work requires from your agent

| Method / notification                    | Required           | Notes                                                                                                                                                   |
| ---------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize`                             | **yes**            | Answer `{protocolVersion: 1, agentCapabilities, agentInfo?, authMethods?}`.                                                                             |
| `session/new`                            | **yes**            | Answer `{sessionId}`. Optional `models` / `configOptions` / `modes` — see below.                                                                        |
| `session/prompt`                         | **yes**            | Stream `session/update`s, then answer `{stopReason: "end_turn" \| "cancelled" \| "max_tokens" \| "refusal" \| …}`.                                      |
| `session/update` → `agent_message_chunk` | **yes**            | Text you want the person to read (`content: {type: "text", text}`); chunks are concatenated.                                                            |
| `session/cancel`                         | should             | Stop the running prompt.                                                                                                                                |
| `authenticate`                           | only if configured | Called with your `authMethod` id. Omit `authMethod` if your agent needs no ACP auth (most read their own API key from the environment).                 |
| `session/load`                           | optional           | Advertise `agentCapabilities.loadSession: true` and replay nothing you don't need — Uno Work already has the history and **discards** replayed updates. |

### What Uno Work understands (optional, recommended)

| You send                                                                                                                        | Uno Work shows                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session/update` `tool_call` / `tool_call_update` (`toolCallId`, `title`, `kind`, `status`, `content`, `locations`, `rawInput`) | A tool row in the chat. `kind: "execute"` → command, `edit`/`delete`/`move` → file change (with `content: [{type: "diff", path, oldText, newText}]` shown as a diff), `search`/`fetch` → web/search, anything else → generic tool. `status`: `pending` → `in_progress` → `completed` / `failed`. |
| `session/update` `plan` (`entries: [{content, priority, status}]`)                                                              | The plan/todo panel of the turn.                                                                                                                                                                                                                                                                 |
| `session/request_permission` (a request)                                                                                        | An **Approve / Approve for session / Deny** card — see [Permissions](#permissions).                                                                                                                                                                                                              |
| `session/update` `current_mode_update`                                                                                          | Tracked; not shown.                                                                                                                                                                                                                                                                              |
| `session/new` → `configOptions` with `category: "model"`, or `models: {availableModels, currentModelId}`                        | The harness's models in the model picker (when the harness config lists none). The person's pick is applied with `session/set_config_option` (config option) or `session/set_model` (models state).                                                                                              |
| `agent_thought_chunk`, `user_message_chunk`, `available_commands_update`                                                        | Ignored for now.                                                                                                                                                                                                                                                                                 |

### What Uno Work does _not_ provide

- **No `fs/*` and no `terminal/*` client methods** — Uno Work advertises `fs.readTextFile: false`, `fs.writeTextFile: false`, `terminal: false`. Your agent reads and writes files and runs commands **itself** (it runs on the same machine, in the chat's folder) and reports them as `tool_call`s.
- **No elicitation / free-form questions** — ask the person in your message text instead.
- **Images** are sent as `{type: "image", data, mimeType}` blocks only if you advertise `agentCapabilities.promptCapabilities.image: true`; otherwise a text note says they were left out.

### Permissions

When your agent wants to do something the person should approve, send a `session/request_permission` **request** with the tool call and your options:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "session/request_permission",
  "params": {
    "sessionId": "…",
    "toolCall": {
      "toolCallId": "w1",
      "title": "Write notes.txt",
      "kind": "edit",
      "status": "pending"
    },
    "options": [
      { "optionId": "yes", "name": "Allow", "kind": "allow_once" },
      { "optionId": "always", "name": "Always allow", "kind": "allow_always" },
      { "optionId": "no", "name": "Reject", "kind": "reject_once" }
    ]
  }
}
```

Uno Work matches options by their standard **`kind`**, never by id:

| The person…              | Uno Work answers                                 |
| ------------------------ | ------------------------------------------------ |
| Approve                  | your `allow_once` option (else `allow_always`)   |
| Approve for this session | your `allow_always` option (else `allow_once`)   |
| Deny                     | your `reject_once` option (else `reject_always`) |
| Stop / chat closed       | `{"outcome": {"outcome": "cancelled"}}`          |

The chat's **access mode** answers without asking: _Full access_ approves every request, _Auto-accept edits_ approves requests whose `toolCall.kind` is `edit`, `delete` or `move`, _Ask_ shows every request. The answer is `{"outcome": {"outcome": "selected", "optionId": "…"}}`.

Permission requests are the only thing Uno Work can enforce: an agent that edits files without asking is not stopped by Uno Work. Ask before anything destructive.

### MCP servers

`session/new` / `session/load` carry `mcpServers`: the servers of the chat folder's project-level **`.mcp.json`** (Claude Code format — e.g. the Uno assistant's manager tools in its workspace), converted to ACP entries. **stdio** servers are always passed; **`http`/`sse`** servers only if you advertise `agentCapabilities.mcpCapabilities.http` / `.sse`. Connect to them like any ACP agent would.

---

## 2. What the process gets

**Working directory** — `session/new.cwd` and the process's cwd:

- `"project"` (default) — the chat's project folder;
- `"home"` — the home folder;
- an absolute folder (`"/srv/agent"`, `"~/agents/kimi"`) — always that folder.

**Environment** — the daemon's environment with Uno's own secrets removed, plus:

| Variable                                         | Value                                                                                                                                                                                               |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| your `env` / Settings variables                  | as configured (secret ones from Uno Work's secret store)                                                                                                                                            |
| `UNO_WORK=1`                                     | you are running inside Uno Work                                                                                                                                                                     |
| `UNO_WORK_THREAD_ID`                             | the chat's id                                                                                                                                                                                       |
| `UNO_WORK_PROJECT_DIR`                           | the chat's project folder (even if the session runs elsewhere)                                                                                                                                      |
| `UNO_WORK_HARNESS_ID`                            | the harness instance id (`harness-<id>` for files)                                                                                                                                                  |
| `UNO_WORK_BRIEF_FILE`                            | a Markdown file with what every Uno Work agent is told about this machine (apps, browser, plugins). ACP has no system-prompt field — include it in your agent's instructions if you want it.        |
| `UNO_WORK_HARNESS_GUIDE`                         | this document on disk (`~/.uno/docs/custom-harness.md`)                                                                                                                                             |
| `UNO_WORK_BRIDGE_URL`, `UNO_WORK_BRIDGE_TOKEN`   | the built-in browser bridge, scoped to this chat (when the browser pane is available)                                                                                                               |
| `PATH`                                           | the daemon's `PATH` + `~/.local/bin`                                                                                                                                                                |
| `UNO_GATEWAY_API_KEY`, `UNO_GATEWAY_BASE_URL`    | **only with `"shareUnoGateway": true`** — the Uno account's OpenAI-compatible AI gateway (`https://api.getuno.xyz/v1`), billed to the account. Point your agent's OpenAI-compatible provider at it. |
| `UNO_AGENT_API_KEY`, `UNO_API_URL`, `UNO_BOX_ID` | **only with `"shareUnoAccount": true`** — this machine's Uno identity (manage computers in the account, with the rights set in Settings → Computer access).                                         |

---

## 3. Register a harness

Two equivalent ways. Either way the harness shows up in the **model picker** (with its models, or one "Default" entry) and in **Settings → Harnesses**, where **Test connection** checks it end to end.

### a) Settings → Harnesses → Add custom harness

Name, icon, command line, environment variables (mark API keys _secret_ — they go to the secret store, not to settings.json), working folder, optional install / detect commands and models. Test connection works before saving.

### b) A file: `~/.uno/harnesses/<id>.json`

Write one file; Uno Work picks it up within a few seconds (no restart). `<id>` = the file name: lowercase letters, digits, `-`, `_` (e.g. `kimi.json`). The harness appears as instance `harness-<id>`.

```json
{
  "name": "Gemini CLI",
  "icon": "✨",
  "description": "Google's Gemini CLI over ACP",
  "command": "gemini",
  "args": ["--acp"],
  "env": { "GEMINI_MODEL_LOG": "warn" },
  "secretEnv": ["GEMINI_API_KEY"],
  "workingDirectory": "project",
  "install": ["npm", "install", "-g", "@google/gemini-cli"],
  "detect": ["gemini", "--version"],
  "models": [],
  "authMethod": "",
  "enabled": true,
  "shareUnoGateway": false,
  "shareUnoAccount": false
}
```

| Field                                | Required | Meaning                                                                                                                                                                                            |
| ------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`                            | **yes**  | The executable: an absolute path (`/usr/local/bin/agent`), `~/…`, or a program name on `PATH` (`gemini`). Not a relative path, not a shell line.                                                   |
| `args`                               | no       | List of arguments, passed as-is.                                                                                                                                                                   |
| `name`, `icon`, `description`        | no       | Shown in the picker/settings. `icon`: one emoji or two letters.                                                                                                                                    |
| `env`                                | no       | `{"NAME": "value"}` — plain (non-secret) variables.                                                                                                                                                |
| `secretEnv`                          | no       | Names of secret variables (API keys). **Never put secret values in the file**: the person enters them in Settings → Harnesses → the harness → _Set_, and they are kept in Uno Work's secret store. |
| `workingDirectory`                   | no       | `"project"` (default), `"home"`, or an absolute folder.                                                                                                                                            |
| `install`                            | no       | Command that installs the agent; runs only when the person presses **Install** (argv list, or one line without shell operators).                                                                   |
| `detect`                             | no       | Command whose exit code 0 means "installed"; the first line of its output is shown as the version (e.g. `["gemini", "--version"]`).                                                                |
| `models`                             | no       | `["id", …]` or `[{"id": "…", "name": "…"}]` for the picker. Empty → the models your agent advertises in `session/new`, or one "Default".                                                           |
| `authMethod`                         | no       | ACP `authenticate` method id to call after `initialize`.                                                                                                                                           |
| `enabled`                            | no       | `false` hides it without deleting the file.                                                                                                                                                        |
| `shareUnoGateway`, `shareUnoAccount` | no       | See the environment table. Default `false`.                                                                                                                                                        |

Rules Uno Work enforces (the file is treated as untrusted input): commands are argument lists and are **never run through a shell** — no `$VARS`, `~` only at the start of a path, no pipes/redirects (put those in a script and point `command` at it); files larger than 32 KB, symlinks and invalid files are skipped and listed under _Invalid files_ in Settings → Harnesses with the reason. A Settings harness with the same instance id wins over a file.

Delete the file to remove the harness.

---

## 4. Test connection

Settings → Harnesses → **Test connection** runs the whole handshake in a throw-away folder: spawn → `initialize` → `authenticate` (if configured) → `session/new` → `session/prompt` "Reply with OK" → shows the agent's reply, its name/version, capabilities, advertised models and the tail of stderr. Permission requests during the test are answered with _Deny_. A test is limited to 60 seconds.

---

## 5. Examples

### Minimal agent (Node, no dependencies)

[`examples/acp-echo-harness/echo-harness.mjs`](../examples/acp-echo-harness/echo-harness.mjs) — also on every machine at `~/.uno/docs/examples/acp-echo-harness.mjs`. It echoes each prompt; a prompt containing "plan" produces a plan, one containing "write" asks for permission first.

```json
{
  "name": "Echo",
  "icon": "🔁",
  "command": "node",
  "args": ["/home/me/.uno/docs/examples/acp-echo-harness.mjs"]
}
```

### Existing agents that speak ACP

Check your tool's own documentation for its ACP mode — flags change between versions. Verified on 2026-09-24:

| Tool              | Command                                      | Checked with                               |
| ----------------- | -------------------------------------------- | ------------------------------------------ |
| Gemini CLI 0.61.0 | `gemini --acp` (older: `--experimental-acp`) | `gemini --help`                            |
| OpenCode          | `opencode acp`                               | `opencode --help`                          |
| Hermes Agent      | `hermes acp`                                 | `hermes --help` (also built into Uno Work) |

For other tools (Kimi Code, Goose, Devin CLI, …) check the tool's docs for "ACP" / "Agent Client Protocol" support.

### Tools that don't speak ACP

A plain CLI agent (e.g. Aider) needs an **ACP shim** — a small program that speaks ACP on stdio and drives the CLI. Some ship as npm packages, e.g. `@zed-industries/claude-code-acp` (binary `claude-code-acp`) and `@zed-industries/codex-acp` (binary `codex-acp`), published by Zed for Claude Code and Codex. For anything else, write one — the echo example above is the skeleton: replace the echo with a call to your tool and report its actions as `tool_call`s.

---

## 6. Security

A harness is **a program the person chose to run** with their own rights: on a laptop it runs as the person; on an Uno cloud computer it runs as the same service user and in the same sandbox as the built-in agents. Uno Work does not sandbox it further. Therefore:

- only register agents you trust — a harness file is as powerful as a line in your shell profile;
- keep API keys in `secretEnv` / Settings secrets, never in the file or in `args`;
- `shareUnoGateway` / `shareUnoAccount` hand the agent credentials that spend the account's AI budget / act on the account's computers — enable them only for agents you trust with that.
