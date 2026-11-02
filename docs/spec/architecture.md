# Architecture

Status: **draft, awaiting review**. Decided: ADR-0001…0007 (see [§13](#13-decisions-and-open-items)); remaining open items are listed there. Related: [data-model.md](data-model.md), [ui-ux.md](ui-ux.md).

Labels used below: **Fixed** = YAW setup or project concept, **Recommendation** = proposed, needs review, **Assumption** = not yet confirmed, **Open** = unresolved.

## 1. Purpose

TagApe: a Chrome extension that captures Adobe Analytics and Google Analytics tracking requests in the background and shows their decoded meaning and sequence in a persistent Side Panel, without DevTools.

Core rule: **capture runs in the background; the Side Panel only views and controls captured data and is never a prerequisite for capture.**

Not a reporting tool: it shows observed requests, not Adobe Workspace data.

## 2. Users

- One technical analytics practitioner, local Chrome profile, solo use.
- Main jobs: validate implementations, follow journeys across tabs, spot missing or unexpected events.

## 3. Scope

In scope (concept §5): MV3 extension, Side Panel, background capture, AppMeasurement, Web SDK, GA4 and Universal Analytics decoding, GET/POST inspection within API limits, cross-tab recording sessions, timeline, filters and watchlists, journey view, raw request view, local storage, JSON/CSV export. GA and Adobe requests fired by GTM are included; a GTM container script load is not a tracking hit.

Non-goals: Workspace replacement, reports from the Reporting API, Adobe Developer Console, A/B statistics, cloud sync, multi-user, server-side collection, MITM/TLS interception, certificates, required external services.

Optional exception (**ADR-0010**): a pasted Workspace curl lets the user load dimension/metric **names** from Adobe's API on demand; the token lives in `chrome.storage.session` only.

## 4. Boundaries and components

```
 Web pages (all tabs)                         Chrome
 ─────────────────────                        ──────────────────────────────────────────
  AppMeasurement / Web SDK  ── network ──▶    chrome.webRequest (observe only)
                                                        │
                                                        ▼
                                         ┌─ background service worker ──────────────┐
                                         │ capture → detect → parse → mask → store  │
                                         │ session state, tab tracking, dedup       │
                                         └───────────┬──────────────────────────────┘
                                                     │ IndexedDB (events, sessions)
                                                     │ chrome.storage.local (settings)
                                                     ▼
                                         Side Panel (sidepanel.html)
                                         reads storage, sends commands, renders views
```

| Component | Responsibility | Files (planned) |
|---|---|---|
| Service worker | Registers listeners at top level, owns recording state, detection, parsing, dedup, persistence | `extension/background.js` + modules |
| Detector | Matches request URLs against built-in and configured patterns | `extension/lib/parse.js` |
| Parsers | AppMeasurement (first), Web SDK (later), unknown fallback | `extension/lib/parse-*.js` |
| Store | IndexedDB access shared by worker and panel | `extension/lib/store.js` |
| Side Panel | Live, Journey, Funnel, Sessions views; inspector; filters; export | `extension/sidepanel.*` |

The existing template popup (`extension/popup.*`) is replaced by the Side Panel. **Recommendation:** the toolbar action opens the panel (`chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`).

## 5. Stack

- **Fixed:** Chrome Manifest V3, plain HTML, CSS and JavaScript (ES modules), sources in `extension/`. No framework, no bundler, no build step for development.
- **Fixed:** library strategy prefers built-in browser APIs. No runtime dependencies planned. Any future dependency needs a written justification.
- **Decided (ADR-0008, supersedes ADR-0002):** Chrome is the only target. The manifest keeps `background.scripts` and a `gecko` block only so `web-ext lint` passes; use `just dev chromium`.
- Browser APIs used: `chrome.webRequest`, `chrome.webNavigation`, `chrome.sidePanel`, `chrome.tabs`, `chrome.permissions`, `chrome.storage`, IndexedDB, `Blob` + object URL for export.

## 6. Capture engine

### 6.1 Primary method: `chrome.webRequest` (observe only)

- Non-blocking listeners only. MV3 does not allow blocking `webRequest` for normal extensions, which also guarantees requests are never modified, blocked or delayed.
- `onBeforeRequest` with `extraInfoSpec: ["requestBody"]`: URL, method, type, `requestId`, `tabId`, `frameId`, `documentId`, `initiator`, `timeStamp`, request body (`formData` or `raw` bytes).
- `onSendHeaders` with `["requestHeaders"]`: headers Chrome exposes. **Recommendation:** do not request `extraHeaders`, so `Cookie` and similar credential headers are never seen.
- Response bodies are **not** available through `webRequest`. Web SDK response handles (ECID, decisions) are therefore out of scope for the primary method.
- `onCompleted` / `onErrorOccurred` (optional): record whether the hit reached the server (status code or network error).

**Assumption, to verify in the feasibility spike:** request bodies of `navigator.sendBeacon()` and `fetch(..., { keepalive: true })` requests (`type: "ping"` / `"xmlhttprequest"`) are exposed in `requestBody.raw`. If not, the hit is still captured from its URL and marked `partial`.

### 6.2 Optional methods (not in MVP)

| Method | When | Cost |
|---|---|---|
| MAIN-world instrumentation (`sendBeacon`, `fetch`, `XMLHttpRequest`, `Image.src`) via `chrome.scripting` | Only if `webRequest` misses bodies that matter | Must wrap native functions transparently; risk of page interference; needs dedup against `webRequest` |
| `chrome.debugger` (CDP) | Only if a demonstrated gap remains. Gains: every request body, **response bodies** (Edge `interact` responses: ECID, Target propositions, Edge errors/warnings), exact timings | `debugger` permission (strong install warning), must attach per tab (new tabs need re-attach), Chrome shows a "started debugging this browser" bar while attached, no access to `chrome://` or Web Store pages; **Open** (concept Q6) |

### 6.3 Detection

Detection is pattern-based, not domain-based, because first-party tracking servers are common.

| Source | Built-in match | Notes |
|---|---|---|
| AppMeasurement | path contains `/b/ss/` | `/b/ss/{rsid[,rsid…]}/{version}/{codeVersion}/s{random}`, e.g. `dbsystelentities.d3.sc.omtrdc.net/b/ss/dbsedbagkp/1/JS-2.27.0-LGU4/s7583…` (GET image) |
| Web SDK | path matches `/ee/(…/)?v\d+/(interact\|collect)` | e.g. `edge.adobedc.net/ee/v1/interact`, first-party `smetrics.aida.de/ee/irl1/v1/interact?configId=…`; `collect` is used for beacons; usually `POST` via `xmlhttprequest` with a JSON body |
| GA4 | `/g/collect`, `v=2`, `tid=G-…`; or `/mp/collect` with `measurement_id=G-…` | Google tag hits on Google or first-party hosts; Measurement Protocol JSON batches when sent from a browser tab |
| Universal Analytics | `/collect`, `/r/collect`, `/j/collect`, `v=1`, `tid=UA-…` | legacy collection hits on Google or first-party hosts |
| Custom | user-configured URL patterns (`URLPattern` syntax) | parsed with best-matching parser or kept as `unknown` |

Other requests such as Adobe ID sync, Launch libraries and GTM container scripts are **not** hits and are ignored unless a custom pattern matches. Arbitrary vendor tags fired by GTM require custom patterns; they are shown as `unknown` with generic parameters.

### 6.4 Navigations (SPA)

**Decided (ADR-0006):** `chrome.webNavigation` creates navigation boundaries: `onCommitted` (document load), `onHistoryStateUpdated` (SPA `pushState`/`replaceState`), `onReferenceFragmentUpdated` (hash routes). Main frame only.

### 6.5 Which tabs are recorded

**Assumption / Recommendation:** while a session is `recording`, all normal tabs in the profile are observed (`tabId >= 0`). Background requests without a tab (`tabId = -1`, e.g. service workers of the site) are captured and shown as "no tab". Incognito only if the user allows the extension there. Narrowing to selected tabs is a filter, not a capture rule.

### 6.6 Service-worker lifecycle (MV3)

- All listeners are registered synchronously at the top level of `background.js`, so a `webRequest` event wakes the worker and is delivered.
- Recording state (`activeSessionId`, `status`) lives in `chrome.storage.local`, never only in memory. On each event the worker reads it (cached after first read per worker lifetime, refreshed on `storage.onChanged`).
- Events are written to IndexedDB before they are announced to the panel. The panel always renders from the store, so a missed message never loses data.
- Dedup: a deterministic key per observation (see [data-model.md §4.3](data-model.md#43-capturedrequest)) with a unique index; a repeated write is a no-op.
- On worker start a `worker_started` marker is written to the active session so the UI can show restarts.
- Requests that arrive while the session is `paused` or `stopped` are intentionally discarded (not loss). Detection, parse or storage failures are counted per session and surfaced in the UI (no silent loss).

## 7. Parsing

Normalization rules and field mapping are in [data-model.md §5](data-model.md#5-parsing-contracts). **Decided (ADR-0007):** AppMeasurement and Web SDK are both MVP sources. **ADR-0012** adds GA4 and Universal Analytics. Order of delivery: AppMeasurement GET → Web SDK `interact` POST → AppMeasurement POST/beacon.

## 8. Persistence

- **Decided (ADR-0001, browser-only):** IndexedDB for sessions, tabs, captured requests and events; `chrome.storage.local` for settings, filter profiles and funnel definitions. Request `unlimitedStorage` so long sessions do not hit the default quota.
- Why IndexedDB over `chrome.storage.local` for events: indexed queries by session/time and append-only writes without rewriting large arrays.
- **Option B** (local Python/FastAPI + SQLite) is not planned. It conflicts with the fixed plain-HTML/JS stack and adds a runtime, lifecycle and a localhost security boundary. Revisit only if a demonstrated limitation appears.
- Schema versioning and migrations: [data-model.md §7](data-model.md#7-lifecycle-and-migrations).

## 9. Deployment and distribution

- Development: load unpacked from `extension/` in `chrome://extensions` (Developer mode), or `just dev chromium`.
- Package: `just build` → `dist/<name>-<version>.zip`.
- Docker: **not applicable.** A browser extension has no server runtime; no container is planned.
- Command wrapper: **Fixed off.** No application CLI. Native commands only (Chrome UI, `just` recipes provided by YAW for checks and packaging).

## 10. Permissions (planned)

| Permission | Why |
|---|---|
| `webRequest` | observe tracking requests |
| `<all_urls>` in `host_permissions` | tracking servers can be any first-party domain; also lets `chrome.tabs` read tab URL/title. **Decided (ADR-0009, supersedes ADR-0004):** declared at install, because runtime-granted access did not wake the stopped worker for `webRequest` events |
| `webNavigation` | SPA and document navigation boundaries (ADR-0006); install warning "Read your browsing history" |
| `sidePanel` | persistent UI |
| `storage`, `unlimitedStorage` | settings and recording storage |
| content script `content.js` (all sites, via host permission) | reports clicks/key presses only while recording with Screenshot on; the worker then calls `tabs.captureVisibleTab` (max ~1 per 600 ms). Reads no page content |
| `scripting`, `debugger` | **not requested** until an optional method is approved |


## 11. Security and privacy

- Local-only: no network calls by the extension except the user-triggered Adobe name lookup (ADR-0010), no remote code, no telemetry.
- No credential collection: no `extraHeaders`; `Authorization`, `Cookie`, `Set-Cookie`, `Proxy-Authorization` are dropped if ever present.
- Masking: configurable rules (parameter name or path, e.g. `email`, `v12`, `xdm.identityMap.*`) applied **before** persisting, so masked values never hit storage. Masked values are shown as `[masked]`, not removed. **Decided (ADR-0003):** the user-editable list starts empty. GA4 Measurement Protocol `api_secret` is always masked.
- Raw retention: **on by default (ADR-0003)**, toggle in Settings; when off, only normalized values and the URL without query are stored.
- Session deletion removes all rows of that session in one transaction.
- Input validation: all captured URLs and bodies are untrusted. Parsers are defensive (size limit per body, try/catch per hit, no `eval`, no `innerHTML` with captured values — render with `textContent`). Imported settings JSON is validated against the schema.
- Console logs: structured, prefixed `[aajr]`, never log full payloads or masked values.

## 12. Errors, logging, documentation, testing

- Errors: short, actionable, visible in the panel header or affected view (catalogue in [ui-ux.md §6](ui-ux.md#6-empty-error-and-recovery-states)). Stack traces only in the console.
- Logging: console only (**Fixed**). Destination: the worker's and panel's DevTools console. Retention: none beyond Chrome's console buffer; nothing persisted.
- Documentation (**Fixed** essential only): `README.md` covers install, load unpacked, permissions, operation, capture limitations, troubleshooting, check/build commands. Specs here describe current behavior.
- Testing: unit-test suite not required (**Fixed**). Validation via `just check` (web-ext lint, html-validate, stylelint, manifest check) plus scripted browser walkthroughs against real and fixture pages: GET hit, beacon hit, Web SDK hit, tab switch, panel closed while recording, worker restart (`chrome://serviceworker-internals` → Stop), storage failure, masked value. Parsers may get small fixture-based checks run with `node` if useful; optional.

## 13. Decisions and open items

| # | Topic | Status |
|---|---|---|
| 1 | Persistence | Browser-only, IndexedDB (ADR-0001) |
| 2 | Target browser | Chrome only (ADR-0002) |
| 3 | Raw retention, session retention, masking defaults | Raw on, keep until deleted, no default rules (ADR-0003) |
| 4 | Host permission | `<all_urls>` in `host_permissions` (ADR-0009) |
| 5 | Funnel scope | Global definitions, evaluated per session (ADR-0005) |
| 6 | SPA navigations | `webNavigation` (ADR-0006) |
| 7 | Sources | AppMeasurement + Web SDK, first-party Edge domains (ADR-0007) |
| 8 | `chrome.debugger` (concept Q6) | **Open.** Not in MVP; trade-offs in §6.2 |
| 9 | Request bodies of `sendBeacon` / `keepalive` fetch in `webRequest` | **Open**, verify in the feasibility spike |
