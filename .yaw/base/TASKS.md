# Tasks

## How to work with this file

1. **Track:** `just task start <id>` moves an item to Active as "in progress". Log each step with `just task log <id> "what changed" --resume "next step"`, so a fresh session can resume from the Resume point.
2. **Finish:** when the item is implemented and `just check` is green, run `just task done <id>`; it moves to the Done history (TASKS.archive.md). Then take the next backlog item unless the user asked you to stop.
3. **Model and effort:** every item names a suggested model tier and reasoning effort: the line `  model: sonnet · effort: medium` under a backlog item, the "Model / effort" field on an active one. Add it to every new item (`just task new "title" --model sonnet --effort medium`). Use the cheapest tier that fits; a small sub-agent can work through the low-effort items.
4. **Specs and plans:** `docs/spec/` describes the current system and is kept. `docs/plan/` holds temporary plans; delete a plan file and its link here when its work is done. Code comments and `.decisions/` link only to `docs/spec/`.

## Active

## Backlog

## Done → TASKS.archive.md
