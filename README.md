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
- **The topic's name is the chat's name.** The topic always carries the chat's name, whoever named
  the chat: `/rename`, a hook, or the client's automatic title. The hooks module API has no title
  event and says nothing to a module about `/rename`, so the plugin takes the name from two places:
  the classic hook input (`session_title`, on start, on resume and on every prompt typed in the
  terminal) and the session transcript (JSONL) whose path the same input carries
  (`transcript_path`). In the transcript the name is the last `custom-title` record (`/rename`,
  hooks, `/away <name>`) or, without one, the last `ai-title` record (the automatic title). The
  transcript is read on those classic hooks, on turn start and turn end, before `/away`, and every
  5 seconds while the session lives (`$.clock.every`). Whichever source changed last wins; a new
  name goes to the service at once (`/name`), and the service renames the topic. A session without
  any title falls back to the bound topic and `default_topic_name`.

  Cost of the transcript poll: `$.fs.read` returns a file only whole, so the plugin first compares
  the file's size and modification time (`$.fs.stat`) and skips an unchanged transcript; a changed
  one is read whole and only the line holding the last title key is parsed. While a turn runs the
  transcript changes all the time, and the poll reads it whole every 5 seconds. `$.fs.read` refuses
  files over 4 MiB: on such a transcript the transcript source is silent (a line in the debug log)
  and the name comes from `session_title` alone.
- **`/away <name>` renames the chat.** The name goes to `telegram-bridge away on <name> --session
  <id>` as before, and the plugin also takes it as the chat's name: the topic gets it at once
  (`/name`), the chat itself on the next prompt — the nearest classic `UserPromptSubmit` answers
  `sessionTitle: <name>` once (the `command.run` result has no such field). `/away` without a name
  leaves the chat's name as it is; before turning the mode on it reads the transcript, so a chat
  renamed without a prompt gives the topic its fresh name.
- **Session end.** On `session.end` (except `/clear`, which keeps the connection) the plugin says
  `bye` to the service.
- **The channel survives a restart of the service.** `telegram-bridge link` keeps the connection
  itself: when the service stops (an update, `launchctl kickstart -k`, a reboot) the subcommand stays
  in the same process, dials again every second and greets the service with the same session, which
  gets its topic and away mode back. A restart that is over within 30 seconds is silent. A longer
  absence is said once in the terminal (`мост Telegram: службы нет 30 с, жду её и подключусь сам`),
  and the channel coming back is said too (`мост Telegram: канал вернулся`) — once the connection
  has lived 10 seconds, so a service crashing right after the greeting does not flood the terminal.
  Your word handed out before the restart is not submitted twice: the plugin remembers the deliveries
  it accepted and only confirms a repeat. Agent replies written while the service or the subcommand
  is gone wait and reach the topic in order; a reply that cannot be delivered is said in the
  terminal (`мост Telegram: реплик агента не доставлено в тему: …`).
- **A subcommand that died is started again.** If an open connection's `telegram-bridge link` exits
  other than by `bye` or a refusal of the service (it was killed, it crashed), the terminal shows a
  `мост Telegram: канала нет … поднимаю заново` notice and the plugin starts it again after
  5 seconds; a restart that does not open a connection is said too (`мост Telegram: канал не
  поднялся: …`). The pending restart is dropped at session end, and a second subcommand is never
  started beside a running one. A refusal that a new connection cannot cure (another major version of the contract, the
  session's connection taken over by another holder) is said and not retried.
- **`/resume` inside a running client.** The client ends the current session (`session.end` with
  `resume`) and goes on under another session id in the same process; the hooks module gets no new
  `session.start`. The plugin follows the classic `SessionStart` hook with `source: resume`: the old
  session is told `bye`, and a new `telegram-bridge link` holds the resumed session. The end of a
  session the subcommand no longer holds says no `bye`, so the order of the two events does not matter.
  `/clear` keeps the connection under the old id, as before.
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

### The subcommand's local entry

The plugin's short requests to `telegram-bridge link` (`/name`, `/message`, `/turn/start`,
`/turn/end`, `/context`, `/ack`, `/bye`) go where the subcommand's `ready` event points. A hooks
module cannot reach a named pipe (`\\.\pipe\…`: `$.http.fetch` refuses it as a network location),
so on Windows the subcommand names a loopback address and a key: `url`
(`http://127.0.0.1:<port>`) and `token`, and each request carries `Authorization: Bearer <token>`.
On macOS `ready` names `socket` alone, and requests go to the Unix socket (`socketPath`). The plugin
uses whatever the subcommand named on its platform: `url` with `token` when both are there, else
`socket`.
