# Keybindings

T3 Code reads keybindings from:

- `~/.t3/keybindings.json`

The file must be a JSON array of rules:

```json
[
  { "key": "mod+g", "command": "terminal.toggle" },
  { "key": "mod+shift+g", "command": "terminal.new", "when": "terminalFocus" }
]
```

See the full schema for more details: [`packages/contracts/src/keybindings.ts`](packages/contracts/src/keybindings.ts)

## Defaults

```json
[
  { "key": "mod+j", "command": "rightPanel.toggle" },
  { "key": "ctrl+`", "command": "terminal.toggle" },
  { "key": "mod+d", "command": "terminal.split", "when": "terminalFocus" },
  { "key": "mod+n", "command": "terminal.new", "when": "terminalFocus" },
  { "key": "mod+w", "command": "terminal.close", "when": "terminalFocus" },
  { "key": "mod+k", "command": "commandPalette.toggle", "when": "!terminalFocus" },
  { "key": "mod+b", "command": "sidebar.toggle", "when": "!terminalFocus" },
  { "key": "mod+n", "command": "chat.new", "when": "!terminalFocus" },
  { "key": "mod+shift+o", "command": "chat.new", "when": "!terminalFocus" },
  { "key": "mod+shift+n", "command": "chat.newLocal", "when": "!terminalFocus" },
  { "key": "mod+o", "command": "editor.openFavorite" },
  { "key": "mod+[", "command": "navigation.back", "when": "!terminalFocus" },
  { "key": "mod+]", "command": "navigation.forward", "when": "!terminalFocus" },
  { "key": "mod+shift+s", "command": "thread.settle", "when": "!terminalFocus" },
  { "key": "mod+shift+p", "command": "thread.pin", "when": "!terminalFocus" },
  { "key": "mod+z", "command": "thread.undo", "when": "!terminalFocus && !editableFocus" },
  {
    "key": "mod+enter",
    "command": "composer.sendBackground",
    "when": "composerFocus && draftThreadRoute"
  },
  {
    "key": "mod+alt+enter",
    "command": "composer.sendBackground",
    "when": "composerFocus && draftThreadRoute"
  },
  {
    "key": "mod+alt+enter",
    "command": "composer.sendAndNewThread",
    "when": "composerFocus && !draftThreadRoute"
  },
  { "key": "mod+s", "command": "composer.stash", "when": "!terminalFocus" }
]
```

For most up to date defaults, see [`DEFAULT_KEYBINDINGS` in `apps/server/src/keybindings.ts`](apps/server/src/keybindings.ts)

## Configuration

### Rule Shape

Each entry supports:

- `key` (required): shortcut string, like `mod+j`, `ctrl+k`, `cmd+shift+d`
- `command` (required): action ID
- `when` (optional): boolean expression controlling when the shortcut is active

Invalid rules are ignored. Invalid config files are ignored. Warnings are logged by the server.

### Available Commands

- `terminal.toggle`: open/close terminal drawer
- `terminal.split`: split terminal (in focused terminal context by default)
- `terminal.new`: create new terminal (in focused terminal context by default)
- `terminal.close`: close/kill the focused terminal (in focused terminal context by default)
- `commandPalette.toggle`: open or close the global command palette
- `sidebar.toggle`: hide or show the sidebar
- `rightPanel.toggle`: open or close the right panel (the Panel button in a chat's header)

Before 0.0.136 `mod+j` was `terminal.toggle`. On start the server moves that untouched old default in your `keybindings.json` to `` ctrl+` `` (in place) and gives `mod+j` to `rightPanel.toggle`. A terminal you bound to another key, an existing `rightPanel.toggle` rule, or `` ctrl+` `` already taken by another rule — the file is left as you wrote it.

- `chat.new`: create a new chat thread preserving the active thread's branch/worktree state
- `chat.newLocal`: create a new chat thread for the active project in a new environment (local/worktree determined by app settings (default `local`))
- `editor.openFavorite`: open current project/worktree in the last-used editor
- `script.{id}.run`: run a project script by id (for example `script.test.run`)
- `navigation.back` / `navigation.forward`: back / forward through the app's screens, like a browser
- `thread.settle`: Done for the open chat (it moves to the Done shelf)
- `thread.pin`: pin or unpin the open chat
- `composer.sendBackground`: on a new chat, send it and stay on a fresh one; the chat works in the background. On Home, send the task and stay on Home
- `composer.sendAndNewThread`: on an open chat, send and start a new chat once the message has gone through
- `composer.stash`: set the typed message aside with its images and files, or bring it back in any chat or on Home when the box is empty
- `thread.undo`: undo the last Done, snooze, unpin or archive (the note at the bottom of the sidebar). In a text field `mod+z` stays the field's own undo, except right after the action

### Key Syntax

Supported modifiers:

- `mod` (`cmd` on macOS, `ctrl` on non-macOS)
- `cmd` / `meta`
- `ctrl` / `control`
- `shift`
- `alt` / `option`

Examples:

- `mod+j`
- `mod+shift+d`
- `ctrl+l`
- `cmd+k`

### `when` Conditions

Currently available context keys:

- `terminalFocus`
- `terminalOpen`

Supported operators:

- `!` (not)
- `&&` (and)
- `||` (or)
- parentheses: `(` `)`

Examples:

- `"when": "terminalFocus"`
- `"when": "terminalOpen && !terminalFocus"`
- `"when": "terminalFocus || terminalOpen"`

Unknown condition keys evaluate to `false`.

### Precedence

- Rules are evaluated in array order.
- For a key event, the last rule where both `key` matches and `when` evaluates to `true` wins.
- That means precedence is across commands, not only within the same command.
