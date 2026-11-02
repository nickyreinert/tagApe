# UI/UX

Status: **draft, awaiting review**. No UI is implemented until the structure below and the clickable mock ([§9](#9-review-before-implementation)) are reviewed. Related: [architecture.md](architecture.md), [data-model.md](data-model.md).

## 1. Users and main tasks

One technical analyst validating tracking while browsing. Ranked tasks:

1. Start a recording and see hits arrive while browsing, across tabs, without DevTools.
2. Open one hit and read its decoded values and the raw request.
3. Narrow the stream to the events and variables that matter (watchlist).
4. Review the whole journey per tab / page.
5. Check a funnel for missing, repeated or out-of-order steps.
6. Find, rename, export or delete past recordings.

## 2. Surface and navigation

- Chrome Side Panel (`sidepanel.html`), global (same panel across tabs). Toolbar icon opens it.
- Target width 320–500 px; layout is single-column, no horizontal scroll except inside the raw request block.
- Structure: global header → tab bar (`Live`, `Sessions`; Journey and Funnel removed by ADR-0011) → view. A hit expands inline under its row, details in collapsible groups.
- Settings (detection patterns, masking, raw retention, filter profiles) in a `Settings` view reached from the header menu.

## 3. Layout example (structural, for review)

Live view, recording, watchlist active:

```
┌──────────────────────────────────────────┐
│ ● REC  Checkout test 1        00:04:12   │  status text + dot (not color only)
│ [ Pause ] [ Stop ]        142 hits  ⚠ 2  │  ⚠ = partial/failed decodes, clickable
├──────────────────────────────────────────┤
│  Live | Journey | Funnel | Sessions   ⋯  │  ⋯ = Settings, Export
├──────────────────────────────────────────┤
│ Filter: [Checkout Monitoring ▾] ☑ only   │
│ 3 of 142 shown                     Clear │
├──────────────────────────────────────────┤
│ 09:35:12.123  T1  AM  page               │
│ Product Detail                           │
│ event10 · event15                        │
├──────────────────────────────────────────┤
│ 09:35:20.481  T2  AM  link   ⚠ partial  │
│ Product Detail – add to cart             │
│ scAdd · event20                          │
├──────────────────────────────────────────┤
│ 09:36:02.010  T2  SDK  page              │
│ Checkout                                 │
│ event25                                  │
└──────────────────────────────────────────┘
  T1/T2 = tab badges; hover/focus shows tab title
  AM = AppMeasurement, SDK = Web SDK (text, not icon only)
```

Event inspector (opens on Enter/click):

```
┌──────────────────────────────────────────┐
│ ← Back       ↑ Prev  ↓ Next              │
│ 09:35:20.481 · T2 · GET · AppMeasurement │
│ ⚠ Partial: products[1] price "1,99" is   │
│   not a number                           │
├──────────────────────────────────────────┤
│ Overview | Events | Variables | Products │
│ | Raw                                    │
├──────────────────────────────────────────┤
│ RSID          exampleprod                │
│ Server        metrics.example.com        │
│ Page name     Product Detail             │
│ Page URL      https://example.com/p/123  │
│ Hit type      link (custom) "add to cart"│
│ Tab           T2 · Example – Product 123 │
│                              [Copy JSON] │
└──────────────────────────────────────────┘
```

## 4. Views

### Global header
- Status text: `Not recording` / `Recording` / `Paused` / `Stopped`, with symbol and text, plus session name and elapsed time.
- Controls by state: none → `Start`; recording → `Pause`, `Stop`; paused → `Resume`, `Stop`. `Stop` asks no confirmation (non-destructive).
- Counters: hits, warnings (partial + failed + storage errors). Warning count links to a filtered list.

### Live
- Newest at the bottom with auto-scroll; auto-scroll pauses when the user scrolls up (`Jump to latest` button appears).
- Row: time (ms), tab badge, source, hit type, page name, event names, parse warning.
- Filter bar: profile select, `only matching` toggle (else highlight), ad-hoc event search, `Clear`.

### Grouping (in Live, ADR-0011)
- Group toggle in the Live toolbar: `Merged` | `By tab` | `By page`. Navigation boundaries as separator rows (`page load` / `SPA route`), pauses and worker restarts as gap rows, time delta to the previous hit per row. Cross-tab order implies no causality.
- Funnels were removed; journey breakpoints (T-012) split a recording into journeys instead.

### Sessions
- List: name, start, duration, hits, tabs, status. Actions per row: Open (read-only view in Live), Rename, Export JSON, Export CSV, Delete (confirm with name and hit count).
- Storage usage line (from `navigator.storage.estimate()`).

### Settings
- Detection: built-in patterns (read-only list) + custom URL patterns (validated on save).
- Privacy: raw retention toggle, masking rules (one per line, validated).
- Filter profiles and funnels: create/edit/delete; import/export as JSON.

## 5. Realistic content

Use realistic Adobe values in fixtures and the wireframe: RSIDs like `exampleprod,exampleglobal`, servers like `metrics.example.com` and `edge.adobedc.net`, events `prodView`, `scAdd`, `scCheckout`, `purchase`, `event10`, long page names (`shop:de:checkout:step2:payment`), products strings with multiple items, URL-encoded umlauts (`%C3%BC`). Long values wrap; very long values (>200 chars) are truncated with `Show all`.

## 6. Empty, error and recovery states

Empty:

| State | Message |
|---|---|
| No recording | "Not recording. Press Start, then browse as usual. Closing this panel does not stop recording." |
| Recording, no hits | "Recording. No analytics requests detected yet. Load a page that uses Adobe Analytics or Google Analytics, or add a custom tracking pattern in Settings." |
| Filter empty | "No events match 'Checkout Monitoring'. 142 events hidden. Clear filter" |
| No sessions | "No saved recordings. Recordings are stored locally in this browser profile until you delete them." |

Errors (concise, actionable; data kept wherever possible):

| Condition | Where | Message / recovery |
|---|---|---|
| Capture failure (listener error) | header ⚠ | "Capture error: some requests may be missing. Details in the console." Counter increments. |
| Unsupported format | row | `unknown` source badge, inspector shows raw request. |
| Partial / failed decode | row + inspector | `⚠ partial` / `✗ failed` with `parse_messages`; raw always available. |
| Storage failure / quota | header banner | "Could not save hits (storage full). Export and delete old recordings." Recording continues; drops are counted. |
| Worker restart | Live gap row | "Extension restarted at 09:41:03. Requests during restart may be missing." |
| Missing permission | panel blocker after Start | Granted at install (ADR-0009); if the user withheld site access, Start requests it. Denied: "Recording needs access to all sites, because tracking servers can be on any domain. Try again". |
| Panel opened during recording | none | Loads from store; no message. |
| Backend disconnected | - | not applicable (no backend planned). |

## 7. Keyboard and accessibility

- Semantic HTML: `header`, `nav` with `role="tablist"`, event list as `<ol>` with buttons per row, inspector as `region` with heading.
- Keys: `Tab` order header → tabs → filter → list. In list: `↑/↓` move, `Enter` opens inspector, `Esc` closes it (focus returns to the row), `j/k` prev/next inside inspector. Tablists use arrow keys.
- Visible `:focus-visible` outline, WCAG AA contrast, `prefers-color-scheme` light/dark.
- State never by color only: text labels and symbols (●, ⚠, ✓, ✗).
- New hits announced via a polite `aria-live` counter, not per row.
- All controls have accessible names; icon buttons get `aria-label`.

## 8. Acceptance criteria (MVP, concept §16)

1. Extension loads unpacked in Chrome without errors.
2. Toolbar icon opens the Side Panel.
3. `Start` creates a session; header shows `Recording`.
4. AppMeasurement, Web SDK, GA4 and Universal Analytics hits on a test site appear in Live within 1 s, without DevTools open.
5. With the panel **closed** for a while, hits from that period appear on reopen.
6. Hits from two tabs appear in one session, in timestamp order, with distinct tab badges.
7. After stopping the service worker (`chrome://serviceworker-internals`), recording continues and the restart is shown.
8. Selecting a hit shows decoded RSID, page name, events, eVars, props, products and the raw request.
9. A watchlist on `event10` shows only matching hits with `only matching` on, and highlights them when off; the recording is unchanged.
10. JSON export downloads a file that matches [data-model.md §8](data-model.md#8-export-contracts).
11. All MVP flows work with keyboard only.
12. A malformed hit is shown as partial/failed with its raw request, never as complete.

## 9. Review before implementation

The clickable mock was accepted on 2026-11-02 and implemented in `extension/sidepanel.*`. The accepted criteria are in [§8](#8-acceptance-criteria-mvp-concept-16).
