---
name: handoff
description: Close out the current work so a fresh session can continue. Log the resume point in the task ledger and record this session in the registry. Use before /clear, when the topic changes, or when the user says handoff.
---

# Handoff

1. If a task is active (`TASKS.md`, `just task list`), log one journal line with the resume point:
   `just task log <id> "<what changed, one line>" --resume "<the next step, one line>"`.
   Skip this step when the tasks module is not installed or no task is active.
2. Record the session: `just sessions handoff --title "<id> <short title>"`.
   If it says there is no current session, repeat it with `--agent claude|codex|copilot`.
3. Tell the user in one line: the session id and that `/clear` is safe. After `/clear` the active task comes back by itself.

Rules: one line per field; no code, no diffs, no secrets, no summary of the conversation.
