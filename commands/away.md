---
description: "Away-from-computer mode: this session's questions go to its Telegram topic and answers come back; `/telegram-bridge:away [topic name]`."
argument-hint: "[topic name]"
disable-model-invocation: true
allowed-tools: Bash(telegram-bridge away on *)
---

!`telegram-bridge away on "$ARGUMENTS" --session "$CLAUDE_CODE_SESSION_ID"`
