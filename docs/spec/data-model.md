# Data model

Status: **draft, awaiting review**. Persistence: browser-only (ADR-0001), see [architecture.md §8](architecture.md#8-persistence). Related: [ui-ux.md](ui-ux.md).

Labels: **Fixed**, **Recommendation**, **Assumption**, **Open** as in [architecture.md](architecture.md).

## 1. Overview

```
RecordingSession 1 ──< Tab 1 ──< Navigation
        │                │
        │                └──< CapturedRequest 1 ──< AnalyticsEvent
        └────────────────────────────────────────────────┘ (event.session_id)

Settings ── FilterProfile[] ── FunnelDefinition[]      (global, not per session)
```

- One `CapturedRequest` yields **0..n** `AnalyticsEvent`s: AppMeasurement 1 hit = 1 event; a Web SDK request can carry several `events[]`.
- Persistence is needed: sessions must survive Side Panel close, worker restarts and browser restarts.

## 2. Storage layout

| Store | Where | Key | Indexes |
|---|---|---|---|
| `sessions` | IndexedDB | `session_id` | `started_at` |
| `tabs` | IndexedDB | `tab_id` | `session_id`, `[session_id, browser_tab_id]` |
| `navigations` | IndexedDB | `navigation_id` | `session_id`, `tab_id` |
| `requests` | IndexedDB | `capture_id` | `session_id`, `dedup_key` (unique) |
| `events` | IndexedDB | `event_id` | `session_id`, `[session_id, timestamp]`, `capture_id` |
| `screenshots` | IndexedDB (v2) | `shot_id` | `session_id`; `{session_id, tab_id, timestamp, image: Blob (JPEG)}`, taken on user interaction when enabled (T-013) |
| `meta` | IndexedDB | `key` | schema version |
| `recordingState`, `settings`, `filterProfiles`, `funnels` | `chrome.storage.local` | fixed keys | - |

IDs are `crypto.randomUUID()`. Timestamps are stored as epoch ms (`number`, from `webRequest.timeStamp`) and rendered/exported as ISO 8601 UTC.

## 3. Access

- **Single writer for recording data:** the service worker writes `sessions`, `tabs`, `navigations`, `requests`, `events`. The Side Panel reads them directly from IndexedDB and sends commands (`start`, `pause`, `resume`, `stop`, `rename`, `delete`) via `chrome.runtime.sendMessage`. Why: one writer avoids races on dedup and counters.
- The panel writes `settings`, `filterProfiles`, `funnels` directly to `chrome.storage.local`; the worker listens to `storage.onChanged`.
- Nothing leaves the browser except a user-triggered export file.

## 4. Entities

`null` means unavailable. Missing values are never fabricated.

### 4.1 RecordingSession

| Field | Type | Notes |
|---|---|---|
| `session_id` | string | |
| `name` | string | default `Recording YYYY-MM-DD HH:mm` |
| `started_at`, `stopped_at` | number / null | |
| `status` | `recording` \| `paused` \| `stopped` | |
| `configuration_snapshot` | object | detection patterns, masking rules, raw retention at start |
| `counters` | object | `requests`, `events`, `parse_partial`, `parse_failed`, `storage_errors`, `dropped_paused`, `worker_restarts` |
| `pauses` | `{from, to}[]` | gaps in coverage, shown in Journey |

Not an Adobe visit.

### 4.2 Tab

| Field | Type | Notes |
|---|---|---|
| `tab_id` | string | internal |
| `session_id` | string | |
| `browser_tab_id` | number | Chrome tab id; `-1` for requests without a tab |
| `initial_url`, `current_url`, `title` | string / null | from `chrome.tabs` |
| `created_at`, `closed_at` | number / null | `created_at` = first observation in the session |

Chrome tab ids are reused only across browser restarts; key is `[session_id, browser_tab_id]` plus `closed_at` (a reused id after close creates a new Tab).

### 4.3 CapturedRequest

| Field | Type | Notes |
|---|---|---|
| `capture_id` | string | |
| `session_id`, `tab_id` | string | |
| `request_id` | string | Chrome `requestId`; not globally unique |
| `dedup_key` | string | `webRequest:{request_id}:{timeStamp}`; unique index |
| `timestamp` | number | |
| `frame_id`, `document_id` | number / string / null | |
| `url` | string | masked; query removed if raw retention is off |
| `method`, `request_type` | string | e.g. `GET`, `image` / `ping` / `xmlhttprequest` |
| `initiator` | string / null | |
| `available_headers` | `{name, value}[]` / null | credential headers dropped |
| `available_body` | `{kind: "formData" \| "raw" \| "unavailable", content_type, data}` / null | `raw` stored as UTF-8 text if decodable, else base64 |
| `capture_method` | `webRequest` \| `main_world` \| `debugger` | MVP: `webRequest` only |
| `result` | `{status_code} \| {error} \| null` | from `onCompleted`/`onErrorOccurred` if observed |
| `detected_as` | `appmeasurement` \| `websdk` \| `ga4` \| `ga4mp` \| `universal` \| `custom` | |

A captured request is not necessarily a decoded event.

### 4.4 Navigation

Needed for "group by page navigation", including SPAs (ADR-0006). Created from `chrome.webNavigation` events in the main frame.

| Field | Type | Notes |
|---|---|---|
| `navigation_id`, `session_id`, `tab_id` | string | |
| `kind` | `document` \| `history` \| `fragment` | `onCommitted` / `onHistoryStateUpdated` / `onReferenceFragmentUpdated` |
| `transition_type` | string / null | `link`, `typed`, `reload`, … (document only) |
| `document_id` | string / null | |
| `url` | string | |
| `started_at` | number | |

An event belongs to the latest navigation of its tab with `started_at <= event.timestamp`.

### 4.5 AnalyticsEvent

Concept §8.4 plus the additions marked ★.

| Field | Type | Notes |
|---|---|---|
| `event_id`, `session_id`, `capture_id` | string | |
| `event_index` ★ | number | position within the request (Web SDK or GA4 Measurement Protocol batches) |
| `timestamp` | number | request timestamp |
| `source` | `appmeasurement` \| `websdk` \| `ga4` \| `universal` \| `unknown` | |
| `request_method` | string | |
| `hit_type` ★ | `page_view` \| `link_custom` \| `link_download` \| `link_exit` \| `websdk_event` \| `ga4_event` \| `ga_event` \| `unknown` | source-specific hit classification |
| `tracking_server` | string | host of the request |
| `rsid` | string[] / null | AppMeasurement path can list several; Web SDK: `null` (set in the datastream, not the payload) |
| `datastream_id` ★ | string / null | Web SDK `configId` query parameter |
| `measurement_id` | string / null | GA4 `G-…` or Universal Analytics `UA-…`; absent on Adobe hits |
| `page_name`, `page_url`, `referrer` | string / null | |
| `link_name` ★ | string / null | `pev2` |
| `events` | `{name, value, serial}[]` | ★ concept shows `string[]`; objects keep `event1=5` and `event2:abc`. CSV/filters use `name` |
| `evars`, `props` | `{ "eVar1": Value }` | keys normalized to `eVarN` / `propN`; `Value` see below |
| `list_vars`, `hierarchies` ★ | object | `l1..l3`, `h1..h5` |
| `context_data` ★ | `{ "a.b": "…" }` | flattened `c.` … `.c` nesting |
| `products` | `Product[]` | see §5.1 |
| `visitor_ids` ★ | object | Adobe IDs, Web SDK `identityMap`, GA4 `cid`/`sid` or Measurement Protocol `client_id`/`user_id`, UA `cid`/`uid` (masked by rules) |
| `other_params` ★ | object | any decoded parameter not mapped above |
| `xdm`, `data` ★ | object / null | Web SDK only, original structure |
| `tab_id`, `frame_id`, `document_id` | | copied from the request |
| `raw_reference` | string | `capture_id` |
| `capture_method` | string | |
| `parse_status` | `complete` \| `partial` \| `failed` | |
| `parse_messages` ★ | string[] | why partial/failed, e.g. `products[2]: price "abc" is not a number` |

`Value`: a plain string, or for dynamic variables `{ raw: "D=v10", ref: "eVar10", resolved: "1793633729749" | null }` (§5.1).

`Product`: `{ category, product, quantity, price, events: {}, evars: {}, raw }`; unparsed parts stay in `raw`.

A request matching a pattern but undecodable produces one event with `source: "unknown"`, `parse_status: "failed"` so it remains visible.

### 4.6 FilterProfile (watchlist)

| Field | Type |
|---|---|
| `profile_id`, `name` | string |
| `include_rules`, `exclude_rules` | `Rule[]` |
| `show_matching_only` | boolean (`false` = highlight) |
| `created_at`, `updated_at` | number |

`Rule`: `{ field, op, value }`; `field` ∈ `event`, `rsid`, `page_name`, `page_url`, `evar:N`, `prop:N`, `tab`, `source`, `parse_status`; `op` ∈ `equals`, `contains`, `exists`, `regex`. Semantics: include = any rule matches (empty = all); exclude = any rule matches removes it.

Concept watchlist `{"include":{"events":[…]}}` maps to `include_rules: [{field:"event", op:"equals", value:"event10"}, …]`.

### 4.7 FunnelDefinition

| Field | Type |
|---|---|
| `funnel_id`, `name` | string |
| `steps` | `{ step_id, name, match: Rule[] }[]` (all rules of a step must match) |
| `configuration` | `{ scope: "session" }` (MVP) |

Global (ADR-0005), evaluated against one selected session. Results (reached, pending, missing, out of order, repeats, step timings) are computed on read and never stored.

### 4.8 Settings

`{ schema_version, detection: { custom_patterns: string[] }, masking: { rules: string[] }, retain_raw: boolean, active_filter_profile_id, active_funnel_id }`.

`recordingState`: `{ active_session_id, status }`; the only state the worker needs after a restart.

## 5. Parsing contracts

### 5.1 AppMeasurement

Input: URL query (GET) or `application/x-www-form-urlencoded` body (POST). Decoded with `URLSearchParams` (handles `+` and `%xx`).

| Param | Field |
|---|---|
| path `/b/ss/{rsids}/…` | `rsid` (split on `,`) |
| `pageName` / `gn` | `page_name` |
| `g`, `r` | `page_url`, `referrer` |
| `events` | `events` (`name[=value][:serial]`, comma-separated) |
| `vN` | `evars.eVarN` |
| `cN` | `props.propN` |
| `lN`, `hN` | `list_vars`, `hierarchies` |
| `products` | `products` (`cat;prod;qty;price;events;evars`, comma-separated) |
| `pe`, `pev2` | `hit_type`, `link_name` |
| `mid`, `aid`, `vid`, `fid` | `visitor_ids` |
| `c.` … `.c` | `context_data` |
| everything else | `other_params` |

Rules:
- Repeated parameter: keep all values in `other_params` as an array, use the first for the mapped field, add a `parse_messages` entry.
- Dynamic variables (`D=v10`, `D=pageName`, `D=mid`): Adobe copies the referenced value server-side. The raw `D=…` is kept; `resolved` is filled only if the referenced parameter is present in the **same** hit, otherwise `null` and shown as "not in hit" (e.g. `v1=D=v0` without `v0`). Never guessed.
- Context data nesting is order-dependent: `c.&apl=4.0&getNewRepeat=3.0&.c` → `context_data.apl`, `context_data.getNewRepeat`; parse the query sequentially (`URLSearchParams` keeps order).
- `t` (client local time, e.g. `2/10/2026 16:35:31 1 -60`) goes to `other_params`; event order uses the observed request timestamp.
- Values are shown as decoded, including upstream encoding errors (e.g. `WarnemÃ¼nde`); never "repaired".
- Malformed segment: field `null` or `raw`, status `partial`.

### 5.2 Web SDK

Input: JSON body of `/ee/…/interact|collect`, usually `POST` from `xmlhttprequest`. Each `events[i]` → one event; `xdm` and `data` stored as-is.

Analytics variables (ADR-0007): if `data.__adobe.analytics` exists it is authoritative and is decoded with the §5.1 rules, by key name instead of query parameter: `pageName`, `pageURL`, `referrer`, `server`, `events` (same string syntax, e.g. `event126=142,prodView`), `products` (same syntax incl. `|`-separated merchandising), `eVarN`, `propN`, `listN`, `D=` references.

XDM: `eventType` → `hit_type` (`web.webpagedetails.pageViews` → `page_view`, `web.webinteraction.linkClicks` → link), `xdm.web.webPageDetails.name/URL` and `xdm.web.webReferrer.URL` fill `page_name/page_url/referrer` only when the analytics block lacks them, `xdm.identityMap` → `visitor_ids`. `xdm.commerce`, `xdm.productListItems` and custom tenant namespaces (e.g. `_aida`) are shown in an XDM section and **not merged** into AA events/products, because the datastream mapping is not observable.

Body unavailable → one event, `partial`, message `body not exposed by browser`.

### 5.3 Google Analytics 4

For Google tag `/g/collect`, `tid` is `measurement_id`, `en` is the event name, `dt`/`dl`/`dr` are page title/location/referrer, and `cid`/`sid` are visitor IDs. `page_view` is a page hit; other names are `ga4_event`. Remaining query or form fields stay in `other_params`, including `ep.*` and `epn.*`. A POST with an unavailable body is partial.

For browser-visible Measurement Protocol `/mp/collect`, each JSON `events[]` item becomes one event. `measurement_id` comes from the URL; `page_title`/`page_location`/`page_referrer` come from event parameters. Other parameters, including `items`, stay in `other_params`. `api_secret` is masked before storage. Server-to-server requests are outside browser observation.

### 5.4 Universal Analytics

`tid` is `measurement_id`; `t=pageview` becomes `page_view`, and other types become `ga_event`. `dt`/`dl`/`dr` are page title/location/referrer. For `t=event`, `ec` and `ea` form the event label; `ev` is its value. Remaining parameters stay in `other_params`.

### 5.5 Unknown

Custom pattern without a matching parser: query and body (if form or JSON) go to `other_params`, `source: "unknown"`, status `partial` (decoded generically) or `failed`.

## 6. Invariants

- Each event belongs to exactly one session; sessions can span many tabs.
- `dedup_key` is unique; a repeated observation writes nothing. Two identical hits with different `requestId`s are two events (real double-firing must stay visible).
- Raw (`requests`, `xdm`, `data`, `raw`) and normalized fields are separate.
- Filters and funnels are read-only views; they never modify or delete records.
- Order = observed `timestamp`, tie-break `capture_id` insertion order. Cross-tab order implies no causality.
- Stopping a session keeps its data. Closing the panel does not change `recordingState`.
- Only one session is `recording` or `paused` at a time.
- Masked values are masked before the first write.

## 7. Lifecycle and migrations

```
start ─▶ recording ⇄ paused
             │          │
             └── stop ──┴─▶ stopped (terminal; data kept until deleted)
```

- Starting a new session while one is active stops the active one first (UI confirms).
- After a browser restart, a `recording` session continues (state is persisted); the restart is visible as a coverage gap.
- Deletion: one IndexedDB transaction over all stores for that `session_id`.
- Retention: keep until deleted (ADR-0003).
- Migrations: `meta.schema_version` (IndexedDB version) and `settings.schema_version`; upgrades run in `onupgradeneeded` / on worker start, forward-only, never drop recording data. Export files carry their own `format_version`.

## 8. Export contracts

- **JSON** (`aajr-session-<name>-<date>.json`): `{ format: "aajr-session", format_version: 1, exported_at, session, tabs, navigations, requests, events }`. `requests` contains only what was retained.
- **CSV** (one row per event, RFC 4180, UTF-8 with BOM for Excel): `timestamp_iso, tab, source, hit_type, rsid, measurement_id, page_name, page_url, link_name, events, evars, props, products, parse_status, capture_id`. Multi-value cells: `events` = names joined by `,`; `evars`/`props`/`products` as compact JSON. Cells starting with `= + - @` are prefixed with `'` (CSV injection).
- **HAR-like**: optional, later; observed fields under standard HAR keys, synthesized metadata under `_aajr`.
