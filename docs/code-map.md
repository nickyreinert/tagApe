---
areas:
  - id: agents
    title: .agents
    paths:
      - .agents/**
  - id: claude
    title: .claude
    paths:
      - .claude/**
  - id: codex
    title: .codex
    paths:
      - .codex/**
  - id: decisions
    title: .decisions
    paths:
      - .decisions/**
  - id: docs
    title: docs
    paths:
      - docs/**
  - id: extension
    title: extension
    paths:
      - extension/**
  - id: just
    title: just
    paths:
      - just/**
  - id: scripts
    title: scripts
    paths:
      - scripts/**
  - id: root
    title: Top-level files
    paths:
      - "*"
---
# Code map

<!-- yaw:map:begin overview -->
| Area | Title | Paths | Entry points | Tests |
|---|---|---|---|---|
| `agents` | .agents | `.agents/**` | - | - |
| `claude` | .claude | `.claude/**` | - | - |
| `codex` | .codex | `.codex/**` | - | - |
| `decisions` | .decisions | `.decisions/**` | - | - |
| `docs` | docs | `docs/**` | - | - |
| `extension` | extension | `extension/**` | - | - |
| `just` | just | `just/**` | - | - |
| `scripts` | scripts | `scripts/**` | - | - |
| `root` | Top-level files | `*` | - | - |
<!-- yaw:map:end overview -->

The text outside the `yaw:map` blocks is yours: `yaw map update` rewrites only the blocks.

## .agents

Describe this area's responsibility.

<!-- yaw:map:begin area-agents -->
- Paths: `.agents/**`
- Entry points: -
- Tests: -
- Relates to: -
- ADRs: -
- Directories:
  - `.agents/`
  - `.agents/skills/`
<!-- yaw:map:end area-agents -->

## .claude

Describe this area's responsibility.

<!-- yaw:map:begin area-claude -->
- Paths: `.claude/**`
- Entry points: -
- Tests: -
- Relates to: -
- ADRs: -
- Directories:
  - `.claude/`
  - `.claude/output-styles/`
  - `.claude/skills/`
<!-- yaw:map:end area-claude -->

## .codex

Describe this area's responsibility.

<!-- yaw:map:begin area-codex -->
- Paths: `.codex/**`
- Entry points: -
- Tests: -
- Relates to: -
- ADRs: -
- Directories:
  - `.codex/`
<!-- yaw:map:end area-codex -->

## .decisions

Describe this area's responsibility.

<!-- yaw:map:begin area-decisions -->
- Paths: `.decisions/**`
- Entry points: -
- Tests: -
- Relates to: -
- ADRs: -
- Directories:
  - `.decisions/`
<!-- yaw:map:end area-decisions -->

## docs

Engineering guidance, system specifications, and README screenshots captured from the Chrome side panel.

<!-- yaw:map:begin area-docs -->
- Paths: `docs/**`
- Entry points: -
- Tests: -
- Relates to: -
- ADRs: -
- Directories:
  - `docs/`
  - `docs/plan/`
  - `docs/screenshots/`
  - `docs/spec/`
<!-- yaw:map:end area-docs -->

## extension

The Chrome MV3 extension. `background.js` is the service worker: webRequest/webNavigation capture, recording state, only writer of IndexedDB. `lib/store.js` IndexedDB schema and access, `lib/parse.js` detection, masking and AppMeasurement/Web SDK/GA4/Universal Analytics decoding, `lib/match.js` filter rules, `lib/icons.js` inline SVG icons, `lib/adobe.js` optional Adobe name lookup from a pasted curl (ADR-0010). `icons/` holds the extension icon (SVG source + PNGs). `content.js` reports user interactions for screenshots. `sidepanel.*` is the UI (Live, Sessions, Settings, inspector).

<!-- yaw:map:begin area-extension -->
- Paths: `extension/**`
- Entry points: -
- Tests: -
- Relates to: -
- ADRs: -
- Directories:
  - `extension/`
  - `extension/icons/`
  - `extension/lib/`
<!-- yaw:map:end area-extension -->

## just

Describe this area's responsibility.

<!-- yaw:map:begin area-just -->
- Paths: `just/**`
- Entry points: -
- Tests: -
- Relates to: -
- ADRs: -
- Directories:
  - `just/`
<!-- yaw:map:end area-just -->

## scripts

Describe this area's responsibility.

<!-- yaw:map:begin area-scripts -->
- Paths: `scripts/**`
- Entry points: -
- Tests: -
- Relates to: -
- ADRs: -
- Directories:
  - `scripts/`
<!-- yaw:map:end area-scripts -->

## Top-level files

Describe this area's responsibility.

<!-- yaw:map:begin area-root -->
- Paths: `*`
- Entry points: -
- Tests: -
- Relates to: -
- ADRs: -
- Directories:
  - `./`
<!-- yaw:map:end area-root -->
