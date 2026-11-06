# claude-telegram-bridge

A Claude Code plugin that lets you talk to a Claude Code session through Telegram while you are away
from the computer. Each session gets its own topic in a Telegram forum group: the agent's finished
replies go to the topic, and what you write in the topic arrives in the session as a new prompt.

The plugin is only the session-side half. It **does not work on its own**: it talks to a local
service, [`telegram-bridge`](https://github.com/kerbyfc/telegram-bridge), which polls the Telegram
Bot API, keeps the topics, sessions and the owner's message inbox, and serves the thin client and the
session adapters. Without it the plugin loads and stays quiet; `/away` answers with the reason there
is no channel.

## What the plugin does

The plugin is a hooks module (`hooks/register.ts`) running inside the Claude Code process. On
`session.start` it spawns `telegram-bridge link --session <session id>`, which holds the connection
to the service for the lifetime of the session, and then:

- **Your words become prompts.** A message you write in the session's topic is submitted to the
  session as a user prompt, with its provenance on the first lines of the text. A running turn is
  not steered; an idle session is woken with a new turn. The plugin confirms each delivery back to
  the service (`accepted`, or `rejected` with a reason), and the service marks your message:
  🫡 taken by the agent, 😴 held.
- **Commands from the topic run in the session.** A slash command written in the topic (other than
  the ones the service handles itself) is run as if you had typed it in the terminal; the plugin
  waits for the session to be idle instead of holding a turn.
- **Away mode — `/away [topic name]` and `/here`, and they cost no turn.** The mode itself is kept by
  the service. Typed in the session's Telegram topic, the service handles these commands itself; in
  the terminal the module registers the two commands at session start
  (`$.command.register({ name, description, argumentHint, immediate: true })`) and answers them in its
  own `command.run` hook: the hook calls `telegram-bridge away on [topic name] --session <session id>`
  or `telegram-bridge away off --session <session id>` and returns its line as the command's output.
  The answer goes without `next` and without a `context`, so the model is not woken: no request is
  made, no token is spent, and nothing of the command's own is added to the context. `immediate`
  makes the command work in the middle of a running turn too. The registered name is the bare
  `/away` and `/here` — the client adds no plugin prefix, and `/telegram-bridge:away` is not a
  command any more (an unknown slash command becomes a prompt). Without a name, the topic is called
  after the chat (see "The topic's name is the chat's name" below).
- **Agent replies go to the topic.** At the end of each turn step the plugin sends the visible
  answer text, whole, as one message (the service splits long ones at Telegram's limit). Tool
  calls, tool input and thinking never reach the topic. A reply interrupted mid-way (Escape, a
  failed request) is not sent. Sub-agent turns and replies are not sent either.
- **Questions in the topic.** A `PreToolUse` hook on `AskUserQuestion` runs
  `telegram-bridge hook ask`: away mode is on — the question with its options reaches the topic and
  the answer comes back as an ordinary message from you; the mode is off or the service is missing —
  the question stays in the terminal and a line in the error stream names why.
- **Turn boundaries and context usage.** On turn start and turn end the plugin tells the service
  the turn id, so the topic shows "typing…" while the session works, and the share of the context
  window in use, which the service puts into the topic's pinned line. When the client has no number
  for the context window, nothing is reported.
- **The topic's name is the chat's name.** Until you name the topic yourself, the topic is called
  after the chat: the plugin reads the session title the client puts into its classic hook input
  (`session_title`) and tells it to the service as an ordinary name, on start, on resume and on every
  prompt typed in the terminal. A chat renamed later renames its topic on the next such hook — there
  is no title event in the hooks module API, and the plugin does not read the client's transcript.
  A name you type, `/away <name>` in the terminal or `/away <name>` in the topic, wins over the
  chat's name and stays until you give another one. A session without a title falls back to the bound
  topic and `default_topic_name`.
- **Session end.** On `session.end` (except `/clear`, which keeps the connection) the plugin says
  `bye` to the service.
- **The channel survives a restart of the service.** `telegram-bridge link` keeps the connection
  itself: when the service stops (an update, `launchctl kickstart -k`, a reboot) the subcommand stays
  in the same process, dials again every second and greets the service with the same session, which
  gets its topic and away mode back. A restart that is over within 30 seconds is silent. A longer
  absence is said once in the terminal (`мост Telegram: службы нет 30 с, жду её и подключусь сам`),
  and the channel coming back is said too (`мост Telegram: канал вернулся`).
- **A subcommand that died is started again.** If an open connection's `telegram-bridge link` exits
  other than by `bye` or a refusal of the service (it was killed, it crashed), the terminal shows a
  `мост Telegram: канала нет … поднимаю заново` notice and the plugin starts it again after
  5 seconds. A refusal that a new connection cannot cure (another major version of the contract, the
  session's connection taken over by another holder) is said and not retried.
- **Reloading the plugin.** A reload that changes the hooks module stops the old subcommand, which
  says `bye`, and `session.start` of the new module starts a new one at once: the session comes back
  with its topic and away mode (`revived`). `/reload-plugins` with an unchanged module does not touch
  the running subcommand at all.
- **A bridge that is not set up is quiet until asked.** A connection that never opened (no binary, no
  settings, the service refused) shows nothing in a session: the reason goes to the debug log, and
  `/away` answers `режим не включён: <reason>` without turning the mode on.

Notifications about turns, replies and context never block a turn: they are fire-and-forget, and a
failure goes to the debug log.

### What lives in the service, not in this plugin

- **Away mode — `/away [topic name]` and `/here`.** The mode is kept by the service. Typed in the
  session's Telegram topic, the service handles these commands itself; the terminal side is the
  plugin's own `/away` and `/here` commands (see above).
- **`AskUserQuestion` in the topic.** Questions with options reach the topic through the plugin's
  `PreToolUse` hook on `AskUserQuestion`; the answer comes back as an ordinary message from you
  (see above).
- Topic naming, the pinned line, the 👀 "received by the bridge" mark, the inbox that survives
  restarts, and filtering of who may write (only the configured owner) are all done by the service.

## Requirements

- Claude Code with plugin hooks modules (`hooks/hooks.json` → `modules`).
- The `telegram-bridge` binary, found on `PATH`, or its full path in the `DM_TELEGRAM_BRIDGE`
  environment variable.
- `DM_TELEGRAM_CONFIG` in the session's environment: the path to the service's `config.yaml`. The
  plugin does not read it itself; `telegram-bridge link` does.
- A running `telegram-bridge` service and a Telegram bot that administers a forum group (topics).

## Installation

From inside Claude Code:

```text
/plugin marketplace add kerbyfc/claude-telegram-bridge
/plugin install telegram-bridge@claude-telegram-bridge
```

Or from the shell:

```bash
claude plugin marketplace add kerbyfc/claude-telegram-bridge
claude plugin install telegram-bridge@claude-telegram-bridge
```

### For every contributor of a project

Put the marketplace and the plugin into the project's `.claude/settings.json`. Claude Code registers
the marketplace once the folder is trusted and loads the plugin at session start:

```json
{
  "extraKnownMarketplaces": {
    "claude-telegram-bridge": {
      "source": { "source": "github", "repo": "kerbyfc/claude-telegram-bridge" }
    }
  },
  "enabledPlugins": {
    "telegram-bridge@claude-telegram-bridge": true
  }
}
```

Check with `/plugin`: `telegram-bridge` from `claude-telegram-bridge` is listed as enabled.

## Development

```bash
claude plugin validate .     # manifests, the hooks module and its calls
claude plugin test .         # the hooks module's tests (tests/*.test.ts)
node --test tests/hooks.test.mjs  # the declared hooks file (tests/hooks.test.mjs)
claude --plugin-dir .        # a session with the plugin from this checkout
```

`--plugin-dir` overrides an installed plugin of the same name, so an unreleased change can be tried
in any project by pointing `--plugin-dir` at a clone of this repository.

Code comments, test names and the plugin's terminal notices are in Russian.

## Windows

On Windows there is no signal for the child process: Claude Code stops `telegram-bridge link` with
`TerminateProcess`, so `bye` is not sent on exit. The service buries the session after its
reconnect grace period. The service end of the connection is a named pipe; the subcommand dials it
again after a restart of the service exactly as it dials the Unix socket on macOS.
