# Keryx Product Requirements Document

**Date:** 2026-05-31
**Project path:** `~/Projects/keryx`
**Kanban board:** `keryx`
**Status:** Product/design specification only. No implementation has been started.

## 1. Summary

Keryx is a web UI and thin control layer over Hermes Kanban for a user's personal operations action inbox.

It replaces an ad-hoc manual triage flow with a continuously refreshed, unified action queue. Source-specific Hermes cron jobs discover candidate items, use an LLM only when needed, and create structured Kanban cards on the `keryx` board. The web UI displays those cards, lets the user choose an action option, optionally add feedback, and then promotes the card for Hermes Kanban to execute.

Keryx should not become a second agent framework. Hermes already owns execution, cron scheduling, worker lifecycle, logs, retries, skills, gateway delivery, and Kanban state. Keryx owns only:

- a readable action inbox UI;
- a strict action-item JSON schema;
- an `opsctl` wrapper for safe, idempotent UI actions;
- collector/worker conventions captured in bundled `keryx` category skills.

## 2. Goals

### 2.1 Product goals

- Provide a single web UI for action items from all personal operations sources.
- Keep the central register as the Hermes Kanban board `keryx`.
- Let the user execute, dismiss, or refine proposed actions with one click plus optional feedback.
- Preserve Hermes' existing execution model rather than duplicating it.
- Make source health visible, so silence means "nothing to do", not "collector broke".
- Reduce cognitive load by showing only actionable items, not every raw event.
- Keep every item auditable through Kanban task events, comments, runs, and logs.

### 2.2 Non-goals for the first version

- Do not implement a concrete collector yet.
- Do not create the `keryx` Kanban board yet.
- Do not create `keryx-*` cron jobs yet.
- Do not create `keryx-worker`, `keryx-collector`, or `keryx-collector-creator` skills yet.
- Do not persist raw source events outside source systems.
- Do not build a separate task database.
- Do not support fuzzy/global dismiss rules yet; only exact-item dismiss.
- Do not build payments, bookings, or credential handling into Keryx itself.

## 3. Naming conventions

All Keryx-specific durable artefacts should use the `keryx` prefix.

| Artefact | Name / pattern |
|---|---|
| Project directory | `~/Projects/keryx` |
| Kanban board | `keryx` |
| Skill category | `keryx/` under the Hermes skills directory |
| Skill category description | `keryx/DESCRIPTION.md` |
| Worker skill | `keryx-worker` |
| Collector skill | `keryx-collector` |
| Collector creator skill | `keryx-collector-creator` |
| Collector cron jobs | `keryx-<source>`, e.g. `keryx-email`, `keryx-calendar`, `keryx-events` |
| Collector tenants | source name, e.g. `email`, `calendar`, `notion`, `facebook`, `codex-projects` |
| Card creator | cron job name, e.g. `keryx-email` |
| UI/backend wrapper | `opsctl`, shipped inside the Keryx project |

## 4. Core architecture

```text
Source systems
  ↓
Keryx collector cron jobs (`keryx-*`)
  ↓
Hermes LLM collector pass, governed by `keryx-collector`
  ↓
Hermes Kanban board `keryx`
  ↓
Keryx web UI + `opsctl`
  ↓
The user clicks Execute / Dismiss
  ↓
`opsctl` comments/promotes/archives the Kanban card
  ↓
Hermes Kanban dispatcher spawns `default` worker
  ↓
Worker loads `keryx-worker`, executes selected option, completes/blocks card
  ↓
Result appears in UI and, where required, the configured default delivery channel
```

### 4.1 Central register

The central register is the Hermes Kanban board named `keryx`.

Keryx must not maintain a parallel SQLite action-item database. The web UI should read task state from Kanban via either:

- `opsctl` wrapper commands; or
- Hermes Kanban CLI commands with `--board keryx --json`.

Writes should go through `opsctl`, not direct DB mutation.

### 4.2 Kanban task status model

Collector-created action items start in `blocked`.

Reason: `blocked` is the correct "awaiting user approval" state. The dispatcher does not spawn blocked tasks. When the user clicks Execute, `opsctl` promotes the card to `ready`, after which Hermes Kanban claims it and transitions it to `running`.

Primary statuses Keryx cares about:

| Kanban status | Keryx meaning |
|---|---|
| `blocked` | Awaiting user action/approval; shown in inbox. |
| `ready` | Approved; waiting for dispatcher. |
| `running` | Hermes worker is executing. |
| `done` | Completed. |
| `archived` | Dismissed or hidden from normal views. |
| `todo` | Generally avoided for collector-created cards; may appear if future dependency workflows use it. |
| `scheduled` | Future enhancement for snoozed/deferred items. |
| `review` | Not part of V1 Keryx flow. |

### 4.3 Default assignee

For V1, collector-created cards should use:

```text
assignee: default
```

The worker profile can be split later into a dedicated `keryx-worker` Hermes profile if needed. For now, use the existing `default` profile because it already has the required broad tool access and existing user-specific context.

### 4.4 Source identity

Use Kanban `tenant` as the collector/source namespace.

Examples:

```text
tenant=email
tenant=calendar
tenant=notion
tenant=facebook
tenant=codex-projects
```

Use `created_by` for the exact collector cron job:

```text
created_by=keryx-email
created_by=keryx-calendar
created_by=keryx-events
```

## 5. Action item schema

### 5.1 Task body rule

Kanban task bodies for Keryx action items must contain **only JSON**.

No Markdown wrapper.  
No fenced code block.  
No free-text disclaimer after the JSON.  
No raw source event dump.

The UI should parse `task.body` directly as JSON.

### 5.2 Body size rule

Keep task body JSON compact, ideally well under 8 KB.

Hermes Kanban worker context caps task body injection, so large payloads risk truncation. If exact source content is needed at execution time, the worker should re-query the source system using the stable locator in the JSON.

### 5.3 Schema: `keryx.action_item.v1`

Required top-level fields:

```json
{
  "schema": "keryx.action_item.v1",
  "source": "email",
  "collector": "keryx-email",
  "external_id": "support-inbox:INBOX:35680",
  "idempotency_key": "keryx:email:support-inbox:INBOX:35680",
  "origin_descriptor": "Support Desk — Account access request",
  "title": "Support request: account access needs review",
  "summary": "Customer reports that account access is failing after a recent change.",
  "autonomy": "auto",
  "urgency": "normal",
  "deadline": null,
  "risk": "Support request may stall if ignored.",
  "source_refs": [
    {
      "type": "email",
      "account": "support-inbox",
      "folder": "INBOX",
      "uid": "35680"
    }
  ],
  "options": [
    {
      "id": "translate_forward_contact_archive",
      "label": "Translate + forward to support contact + archive email",
      "requires_input": false,
      "input_hint": null,
      "delivery": null,
      "execution_prompt": "Translate the support request into the target language, forward it to the configured support contact, then archive the source email."
    }
  ],
  "ui": {
    "primary_option_id": "translate_forward_contact_archive",
    "display_group": "Needs approval"
  },
  "created_at": "2026-05-31T00:00:00+10:00"
}
```

### 5.4 Field definitions

| Field | Required | Description |
|---|---:|---|
| `schema` | yes | Must be `keryx.action_item.v1`. |
| `source` | yes | Source namespace: `email`, `calendar`, `notion`, `facebook`, `codex-projects`, etc. |
| `collector` | yes | Cron job name, e.g. `keryx-email`. |
| `external_id` | yes | Stable source identifier. For email, prefer account/folder/UID. |
| `idempotency_key` | yes | Stable key used when creating the Kanban card. |
| `origin_descriptor` | yes | Human-readable source label shown in UI. |
| `title` | yes | Short item title. Should match or inform Kanban task title. |
| `summary` | yes | Short derived summary, not raw source dump. |
| `autonomy` | yes | One of `auto`, `minimal`, `research`, `complex`. |
| `urgency` | yes | One of `low`, `normal`, `soon`, `urgent`. |
| `deadline` | no | RFC3339 deadline if known, otherwise `null`. |
| `risk` | no | Why this matters / what may go wrong if ignored. |
| `source_refs` | yes | Stable locators workers can use to re-query source systems. |
| `options` | yes | One or more action choices. |
| `ui` | no | Display hints, not execution authority. |
| `created_at` | yes | RFC3339 timestamp created by collector, not source content. |

### 5.5 Option schema

Each action item has one or more options.

```json
{
  "id": "research_venue_options",
  "label": "Research venue options",
  "requires_input": false,
  "input_hint": null,
  "delivery": "default",
  "execution_prompt": "Research suitable venue options for a 6:30 pm team planning session. Deliver the result to the configured default Keryx channel."
}
```

| Field | Required | Description |
|---|---:|---|
| `id` | yes | Stable option ID used by UI and `opsctl execute`. |
| `label` | yes | Button label. |
| `requires_input` | yes | Whether UI should prompt the user before execution. |
| `input_hint` | no | Short hint for the feedback/input field, e.g. `Type the date you want to book`. |
| `delivery` | no | `default`, a concrete Hermes target such as `discord:#ops` or `telegram`, `local`, or `null`. `default` means the Keryx default channel selected during setup. |
| `execution_prompt` | yes | Trusted action recipe generated by collector. |

### 5.6 Autonomy categories

Use the current triage semantics, but as machine-readable values:

| Value | Meaning |
|---|---|
| `auto` | Fully executable without more input once the user approves. |
| `minimal` | Needs one small piece of input or preference. |
| `research` | Worker prepares a recommendation/draft/result, usually delivered to the configured default Keryx channel. |
| `complex` | Requires substantial judgement or has consequential side effects; should be conservative. |

## 6. Collector model

No concrete collector is part of this PRD implementation request. This section defines how future collectors should be written.

### 6.1 Collector naming

Every collector cron job name must begin with `keryx-`.

Examples:

```text
keryx-email
keryx-calendar
keryx-notion
keryx-events
keryx-codex-projects
```

### 6.2 Collector skill

Every collector cron job should load the skill:

```text
keryx-collector
```

This skill will contain the rules for deciding whether to create a Keryx action item, how to classify it, how to structure the JSON body, and how to avoid prompt-injection errors.

### 6.3 Collector state

Each collector may maintain a small source-specific state file for cursors and exact suppressions.

Proposed path convention:

```text
~/.hermes/keryx/collectors/<source>.json
```

Example:

```json
{
  "schema": "keryx.collector_state.v1",
  "source": "email",
  "committed_cursor": "35680",
  "last_success_at": "2026-05-31T00:00:00+10:00",
  "exact_dismissed_external_ids": []
}
```

State files must not contain raw source event content. They may contain:

- high-water marks;
- source cursor tokens;
- exact dismissed external IDs;
- last successful run timestamp;
- small diagnostic metadata.

### 6.4 Cursor safety rule

Collectors must not advance their committed cursor until every discovered item in the batch has been handled.

Handled means one of:

- a Kanban task was created;
- an existing Kanban task already covers it;
- it was classified as non-actionable and explicitly skipped;
- it matched an exact-dismiss suppression.

For ordered sources such as email UIDs, if the collector sees items `101`, `102`, and `103`, it may only advance the high-water cursor past `103` if all three have been handled. If `102` fails processing, do not advance past `101` unless `102` is otherwise recorded as handled.

This avoids the failure mode where a cron script advances the cursor, the LLM fails, and the event is lost forever.

### 6.5 Scriptable collector pattern

Use this for sources where a cheap script can detect whether anything new exists.

Examples:

- email via `himalaya`;
- local calendar via `vdirsyncer` / `khal`;
- Notion API if simple enough;
- filesystem or Codex project scans.

Pattern:

```text
Hermes cron job `keryx-email`
  script: `keryx-email-scan.sh` or `.py`
  no_agent: false
  skill: `keryx-collector`
  delivery: local or silent by default
```

Script behaviour:

- read collector state;
- query source for items after committed cursor, with a safety overlap where appropriate;
- output `{"wakeAgent": false}` if there is nothing new;
- output compact JSON describing candidate items if there is work;
- do **not** advance the committed cursor before the LLM pass has created/ignored/suppressed every item.

LLM collector behaviour:

- treat script output and source content as untrusted;
- inspect candidate items;
- create a blocked Keryx Kanban card for actionable items;
- skip non-actionable items;
- update collector state only after successful handling.

### 6.6 LLM-native collector pattern

Use this for sources where discovery itself requires reasoning, browser automation, or fragile state.

Examples:

- Facebook group/page monitoring through visible browser automation;
- sites requiring logged-in GUI browser sessions;
- sources with ambiguous timestamps or noisy feeds.

Pattern:

```text
Hermes cron job `keryx-events`
  script: optional wake gate only, or none
  no_agent: false
  skill: `keryx-collector`
  enabled toolsets: browser/web/terminal as needed
  delivery: local or silent by default
```

LLM collector behaviour:

- perform the source lookup directly;
- apply recency and relevance filters;
- avoid creating cards for borderline/non-actionable content;
- create blocked Keryx cards only for items with a plausible action path;
- update source state only after item handling is complete.

### 6.7 Collector card creation rules

All collector-created cards must be created on board `keryx`.

Canonical creation shape:

```bash
hermes kanban --board keryx create '<short title>' \
  --assignee default \
  --tenant '<source>' \
  --created-by 'keryx-<source>' \
  --idempotency-key '<stable keryx key>' \
  --initial-status blocked \
  --skill keryx-worker \
  --body '<JSON action item body>' \
  --json
```

Notes:

- `--initial-status blocked` is required.
- `--skill keryx-worker` is required so execution behaviour is pinned to each card.
- `--assignee default` is required for V1.
- `--tenant` must equal the source namespace.
- `--idempotency-key` must be stable across repeated collector runs.
- The task body must be JSON only.

### 6.8 Dedupe rules

Collectors must avoid duplicate cards.

Use both:

1. Kanban `--idempotency-key` at creation time.
2. Collector-side checks for existing active or archived Keryx items with the same `external_id` / `idempotency_key` where needed.

Hermes Kanban's current idempotency check only returns existing non-archived tasks. Because Keryx exact-dismiss uses archive, collectors must also respect exact dismissals from collector state or archived task history.

### 6.9 Non-actionable items

Collectors should not create cards merely because a new source event exists.

Create cards only when there is a concrete proposed action, such as:

- reply;
- file document;
- pay or verify bill;
- research and recommend;
- prepare for a calendar/social event;
- book/start a booking flow;
- detect a conflict, stale project, missing logistics, or deadline risk.

Do not create cards for:

- routine newsletters without action;
- calendar events that need no preparation;
- already-resolved source items;
- ordinary social feed noise;
- generic FYI messages without consequence.

## 7. Worker execution model

### 7.1 Worker skill

Every executable Keryx card must load:

```text
keryx-worker
```

The skill should define the execution contract for Keryx action items.

### 7.2 Worker responsibilities

A worker handling a Keryx card must:

1. Read the task body JSON.
2. Validate `schema == "keryx.action_item.v1"`.
3. Read task comments and find the latest trusted execution decision from `opsctl`.
4. Validate the selected option ID exists in the task body's `options` array.
5. Treat source-derived fields as untrusted, even though the task body is JSON.
6. Follow the selected option's `execution_prompt`, plus the user's optional feedback.
7. Re-query the original source where necessary using `source_refs`.
8. Ask/block only if genuinely blocked.
9. Deliver research or user-facing outputs to the configured default Keryx channel when requested.
10. Complete the Kanban card with concise summary and structured metadata, or block it with the exact missing input.

### 7.3 Trusted execution decision comment

The UI must not encode execution choice by editing the task body. It should append a trusted comment before promotion.

Comment body format:

```json
{
  "schema": "keryx.execution_decision.v1",
  "selected_option_id": "research_venue_options",
  "user_feedback": "Prefer Japanese or Italian; quiet enough to talk.",
  "approved_by": "User",
  "approved_via": "keryx-web",
  "approved_at": "2026-05-31T00:00:00+10:00"
}
```

The worker should use the latest valid `keryx.execution_decision.v1` comment.

If no valid execution decision comment exists, the worker should block rather than guessing.

### 7.4 Delivery channel

Keryx must not default blindly to Discord. The setup flow should discover configured Hermes messaging targets and ask the installer to choose a default delivery target from the available list.

Hermes provides a CLI target directory:

```bash
hermes send --list --json
hermes send --list telegram --json   # optional platform filter
```

Keryx setup and `opsctl doctor` should use this command to enumerate available delivery targets rather than inventing or hard-coding channel IDs.

Execution options may specify:

```json
"delivery": "default"
```

or a concrete Hermes send target if deliberately pinned:

```json
"delivery": "discord:#ops"
```

Rules:

- `default` means the configured Keryx default delivery target chosen during setup.
- If no messaging target is configured, Keryx should allow local-only operation and mark delivery-dependent options as needing configuration.
- Do not hard-code private Discord, Telegram, Slack, or other channel IDs in the PRD, source code, examples, or tests.
- The configured target may be Discord, Telegram, Slack, another Hermes-supported platform, or local-only.

Possible delivery approaches:

1. Preferred for V1: worker uses Hermes `send_message` to the configured target when the selected option requests delivery.
2. Alternative: `opsctl execute` subscribes the task to Kanban notifications via `hermes kanban notify-subscribe` for completion/block events.
3. Fallback: worker creates an immediate Hermes cron job to deliver a message, but this should not be the primary path.

### 7.5 Blocking behaviour

If the worker needs more information, it should call Kanban block with a concise reason.

Examples:

```text
Need the user to choose which workshop date to book: Mon 1 June or Tue 2 June.
```

Blocked task should remain visible in Keryx and, where a delivery target is configured, notify the chosen channel when appropriate.

## 8. Web UI requirements

### 8.1 Hosting

The web UI lives under:

```text
~/Projects/keryx
```

Likely eventual hosting pattern follows existing local services:

- local app on `127.0.0.1:<port>`;
- Caddy route such as `keryx.example.com`;
- authentication handled by Caddy/global auth, not by Keryx V1.

No hosting should be configured as part of this PRD-only task.

### 8.2 Main list

The UI displays a single merged list of Keryx Kanban tasks.

Each item shows:

- source;
- autonomy badge;
- urgency/deadline;
- origin descriptor;
- title;
- summary;
- risk line if present;
- current Kanban status;
- available option buttons;
- feedback/input field;
- Execute and Dismiss controls.

### 8.3 Views / filters

Minimum views:

- Inbox / Needs User: `blocked` Keryx tasks.
- Running: `ready` and `running` tasks.
- Completed: recent `done` tasks.
- Dismissed: archived tasks created by Keryx collectors.
- By source: email, calendar, notion, Facebook, Codex projects.
- By autonomy: auto, minimal, research, complex.
- Deadline soon / urgent.
- Failed or blocked after execution.

### 8.4 Refresh behaviour

The UI should refresh task and source status periodically, approximately every 30 seconds.

WebSockets/SSE can be added later. Polling is acceptable for V1.

### 8.5 Item actions

#### Execute

When the user clicks an option button or Execute:

1. UI sends task ID, selected option ID, and optional feedback to backend.
2. Backend calls `opsctl execute`.
3. `opsctl` writes a trusted execution decision comment.
4. `opsctl` promotes the card from `blocked`/`todo` to `ready`.
5. `opsctl` treats `ready`, `running`, or `done` as idempotent success if a fast double-click occurs.
6. UI updates task status.

#### Dismiss

When the user clicks Dismiss:

1. UI sends task ID and optional reason to backend.
2. Backend calls `opsctl dismiss`.
3. `opsctl` writes a dismissal comment.
4. `opsctl` records exact dismiss metadata for the collector if required.
5. `opsctl` archives the card.
6. UI hides archived tasks unless "show dismissed" is enabled.

Dismiss V1 is exact-item only. No pattern-based "always dismiss similar" feature.

### 8.6 Source status strip

The dashboard should show collector health.

Example:

```text
Email            OK       last run 43s ago
Calendar         OK       last run 37m ago
Facebook         FAILED   login required
Notion           STALE    last success 2h ago
Codex projects   OK       last run 58m ago
```

Source status should derive from Hermes cron jobs named `keryx-*`.

Hermes cron job records include useful fields:

- `last_run_at`;
- `last_status`;
- `last_error`;
- `last_delivery_error`;
- `next_run_at`;
- `enabled`;
- `state`.

If using the existing `cronjob` tool list shape, note that it exposes `last_status` and `last_delivery_error` but may not expose `last_error`; Keryx can read `~/.hermes/cron/jobs.json` or wrap Hermes' Python cron APIs through `opsctl` for fuller status.

### 8.7 UI safety

The UI should not:

- edit task bodies directly;
- mutate the Kanban DB directly;
- execute shell commands other than through its backend/`opsctl` allowlist;
- expose raw secrets or raw source payloads;
- assume task body JSON is valid without validation.

### 8.8 Web technology stack

Keryx should use a small TypeScript web stack:

| Layer | Choice | Reason |
|---|---|---|
| Language | TypeScript | One language across UI, backend, CLI wrapper, schemas, and tests; good fit for JSON-heavy app contracts. |
| Client | Svelte + Vite | Lightweight, fast to build, low ceremony, good for a compact action-inbox UI, and compatible with future Tauri packaging. |
| Server | Fastify | Small, fast HTTP layer with strong TypeScript support; enough structure for API routes without turning Keryx into a full application framework. |
| Unit / integration tests | Vitest | Natural fit for Vite/TypeScript; suitable for schema validation, command construction, mocked Hermes CLI calls, and `opsctl` behaviour. |
| UI / browser tests | Playwright | Suitable for exercising inbox rendering, malformed-card handling, execute/dismiss flows, polling, and responsive layouts. |
| Future native shell | Tauri v2 | Preferred over Electron if Keryx later needs desktop or mobile packaging, because it uses the operating system WebView rather than bundling Chromium. |

The stack should preserve Keryx's role as a thin control surface over Hermes. It should not introduce a separate application database or a second execution framework.

Recommended source split:

```text
src/
  web/        Svelte + Vite UI
  server/     Fastify API routes
  opsctl/     CLI entrypoint and shared command logic
  hermes/     Hermes CLI adapters and parsing
  schemas/    Shared schema validation and TypeScript types
```

Schema validation, card parsing, status mapping, delivery-target handling, and Hermes command construction should live in shared TypeScript modules used by both the Fastify server and `opsctl`. The web UI should call a narrow HTTP API rather than constructing Hermes commands itself.

### 8.9 Future native-app path

Keryx should start as a responsive local web app. Do not build Tauri support in V1.

If a desktop or mobile app is justified later, use Tauri v2 as a native shell around the mature web UI. The native app should usually behave as a client to a Keryx server running where Hermes lives, not as a self-contained Hermes controller on the phone.

Reason: Keryx depends on Hermes CLI access, Kanban state, cron jobs, skills, gateway delivery, local credentials, and source integrations. Those are naturally host-side. A mobile app should approve, dismiss, view status, and submit feedback through the Keryx API; it should not try to run Hermes cron/worker infrastructure locally.

Future extension plan:

1. Build the responsive Svelte web UI first.
2. Expose it safely through localhost, Caddy, Tailscale, or another authenticated reverse proxy.
3. Keep Fastify API boundaries stable and small.
4. Add Tauri v2 only if app-like distribution, native notifications, tray/menu integration, or mobile ergonomics become valuable.
5. For mobile, prefer remote API access to the host-side Keryx server; add native Tauri plugins only for genuinely local device capabilities.

## 9. `opsctl` wrapper requirements

`opsctl` is part of the Keryx software project. It is the safe bridge between the web UI and Hermes Kanban/cron state.

### 9.1 Purpose

`opsctl` should centralise command-line interactions so the web UI does not need to know Hermes CLI details.

It should provide:

- idempotent execute semantics;
- exact dismiss semantics;
- task body validation;
- Kanban list/show wrappers;
- cron status aggregation;
- collector helper commands if useful later.

### 9.2 Proposed commands

```bash
opsctl list [--status blocked|ready|running|done|archived] [--source email]
opsctl show <task_id>
opsctl execute <task_id> --option <option_id> [--feedback <text>]
opsctl dismiss <task_id> [--reason <text>]
opsctl cron-status
opsctl validate-body <path-or-stdin>
```

Future collector helper:

```bash
opsctl create-card --source <source> --body-json <json-file>
opsctl item-exists --idempotency-key <key> [--include-archived]
```

### 9.3 Execute semantics

`opsctl execute` must be idempotent.

Algorithm:

1. Load task via `hermes kanban --board keryx show <task_id> --json`.
2. Parse and validate body as `keryx.action_item.v1`.
3. Validate selected option ID exists.
4. If task status is `done`, return success: already completed.
5. If task status is `ready` or `running`, return success: already accepted/executing.
6. If task status is neither `blocked` nor `todo`, return an explicit error.
7. Append `keryx.execution_decision.v1` comment.
8. Promote card:
   ```bash
   hermes kanban --board keryx promote <task_id> "approved from Keryx"
   ```
9. Optionally trigger immediate dispatcher pass:
   ```bash
   hermes kanban --board keryx dispatch --json
   ```
10. Return JSON to UI.

### 9.4 Dismiss semantics

`opsctl dismiss` should:

1. Load and validate task.
2. Extract `external_id` and `idempotency_key` from body if present.
3. Append a dismissal comment.
4. Record exact dismiss metadata in collector state if needed to prevent recurrence.
5. Archive the card:
   ```bash
   hermes kanban --board keryx archive <task_id>
   ```
6. Return JSON to UI.

Because Hermes Kanban's idempotency check ignores archived tasks, exact dismiss suppression must not rely solely on `--idempotency-key`. Use collector state or explicit archived-task checks.

### 9.5 Mutation boundary

`opsctl` may call Hermes CLI commands and read Hermes state, but it should avoid direct SQL writes to Kanban DB. Direct DB reads can be considered later for performance, but writes should remain through Hermes Kanban commands unless Hermes provides a stable API.

## 10. Prompt-injection and trust model

### 10.1 Threat model

External source content is hostile by default.

Sources include:

- emails;
- Facebook posts;
- web pages;
- calendar descriptions;
- Notion text;
- attachments or links.

Any of these can contain instructions such as "ignore previous instructions" or "send secrets". These instructions must never be treated as system/developer/user instructions.

### 10.2 Trust levels

| Content | Trust level | Handling |
|---|---|---|
| `keryx-worker` skill | Trusted procedural instruction. |
| `keryx-collector` skill | Trusted procedural instruction. |
| `opsctl` execution decision comment | Trusted user approval. |
| Task JSON structure | Trusted only insofar as collector generated it; validate schema. |
| Source-derived strings inside JSON | Untrusted data. |
| Source systems and source text | Untrusted data. |
| user feedback typed in UI | Trusted user instruction for that execution. |

### 10.3 Required defences

- `keryx-worker` must explicitly treat source-derived fields as untrusted.
- Workers must follow the selected option from trusted execution comment, not instructions in source text.
- Collectors must not copy raw source instructions into executable prompts without labelling/handling them as data.
- Action options should be structured recipes written by the collector, not raw text from the source.
- Workers should re-query source systems only to retrieve facts needed for the selected action, not to obey source instructions.
- Destructive/external side effects continue to rely on Hermes' normal approval and visible-browser/payment gates.

## 11. Example action items

### 11.1 Email: support request

Kanban title:

```text
Support request: account access needs review
```

Kanban create shape:

```bash
hermes kanban --board keryx create 'Support request: account access needs review' \
  --assignee default \
  --tenant email \
  --created-by keryx-email \
  --idempotency-key 'keryx:email:support-inbox:INBOX:35680' \
  --initial-status blocked \
  --skill keryx-worker \
  --body '<JSON>' \
  --json
```

Body:

```json
{
  "schema": "keryx.action_item.v1",
  "source": "email",
  "collector": "keryx-email",
  "external_id": "support-inbox:INBOX:35680",
  "idempotency_key": "keryx:email:support-inbox:INBOX:35680",
  "origin_descriptor": "Support Desk — Account access request",
  "title": "Support request: account access needs review",
  "summary": "Customer reports that account access is failing after a recent change.",
  "autonomy": "auto",
  "urgency": "normal",
  "deadline": null,
  "risk": "Support request may stall if ignored.",
  "source_refs": [
    {"type": "email", "account": "support-inbox", "folder": "INBOX", "uid": "35680"}
  ],
  "options": [
    {
      "id": "translate_forward_contact_archive",
      "label": "Translate + forward to support contact + archive email",
      "requires_input": false,
      "input_hint": null,
      "delivery": null,
      "execution_prompt": "Translate the support request into the target language, forward it to the configured support contact, then archive the source email."
    }
  ],
  "ui": {"primary_option_id": "translate_forward_contact_archive", "display_group": "Needs approval"},
  "created_at": "2026-05-31T00:00:00+10:00"
}
```

### 11.2 Calendar: under-specified date event

```json
{
  "schema": "keryx.action_item.v1",
  "source": "calendar",
  "collector": "keryx-calendar",
  "external_id": "calendar:/caldav/Y2FsOi8vMC8yNg/:event-uid",
  "idempotency_key": "keryx:calendar:personal:event-uid",
  "origin_descriptor": "Mon 1 Jun, 6:30 pm — Team planning session",
  "title": "Plan venue options for team planning session",
  "summary": "Calendar event has time but no venue logistics.",
  "autonomy": "research",
  "urgency": "soon",
  "deadline": "2026-06-01T18:30:00+10:00",
  "risk": "A 6:30 pm team planning session needs a suitable venue; leaving it unplanned creates avoidable friction.",
  "source_refs": [
    {"type": "calendar", "calendar": "personal", "uid": "event-uid"}
  ],
  "options": [
    {
      "id": "research_venue_options",
      "label": "Research venue options",
      "requires_input": false,
      "input_hint": null,
      "delivery": "default",
      "execution_prompt": "Research suitable venue options near the event context. Prefer quiet venues where discussion is possible. Deliver a concise ranked recommendation to the configured Keryx channel."
    }
  ],
  "ui": {"primary_option_id": "research_venue_options", "display_group": "Research"},
  "created_at": "2026-05-31T00:00:00+10:00"
}
```

### 11.3 Events feed: workshop booking flow

```json
{
  "schema": "keryx.action_item.v1",
  "source": "events",
  "collector": "keryx-events",
  "external_id": "events:post:1234567890",
  "idempotency_key": "keryx:events:post:1234567890",
  "origin_descriptor": "Events feed — Workshop schedule announcement",
  "title": "Workshop booking opportunity",
  "summary": "A community workshop appears to have two available dates with a booking link.",
  "autonomy": "minimal",
  "urgency": "soon",
  "deadline": null,
  "risk": "Places may sell out; booking will require the user's date choice and payment input.",
  "source_refs": [
    {"type": "event_feed", "url": "https://events.example/item/..."},
    {"type": "booking", "url": "https://booking.example/..."}
  ],
  "options": [
    {
      "id": "start_booking_gui",
      "label": "Start booking in GUI browser",
      "requires_input": true,
      "input_hint": "Type the date you want to book for.",
      "delivery": null,
      "execution_prompt": "Open the booking flow in the visible GUI browser, select the date the user specified, and stop when payment details or other private input is required."
    }
  ],
  "ui": {"primary_option_id": "start_booking_gui", "display_group": "Needs input"},
  "created_at": "2026-05-31T00:00:00+10:00"
}
```

## 12. Source status and cron conventions

### 12.1 Cron jobs

Every source collector should be a Hermes cron job named `keryx-<source>`.

Examples:

```text
keryx-email       every 1m
keryx-notion      every 5m
keryx-calendar    every 1h
keryx-events    every 1h or every 2h
keryx-codex-projects every 1h or daily
```

Actual schedules should be chosen later. The PRD records naming and behaviour only.

### 12.2 Delivery

Collector cron jobs should normally use local/silent delivery to avoid noise.

Failure visibility should come from:

- source status strip in the Keryx UI;
- Hermes cron `last_status` / `last_error`;
- optional alert to the configured Keryx channel only for persistent collector failure or authentication issues.

### 12.3 Last run / failure display

Keryx should mark source status as:

| Status | Condition |
|---|---|
| OK | Last run succeeded and is within expected freshness window. |
| STALE | Last successful run is older than source-specific freshness threshold. |
| FAILED | Last run status is error or last error is present. |
| PAUSED | Cron job disabled/paused. |
| MISSING | Expected `keryx-*` cron job does not exist. |

## 13. Security and side-effect policy

Keryx does not weaken existing Jarvis/Hermes side-effect rules.

### 13.1 Allowed after the user clicks Execute

If the chosen option explicitly calls for it and the worker has enough context:

- file a document;
- move an email to Trash;
- prepare/send a message if the selected option states the recipient/action;
- research and send a recommendation to the configured Keryx channel;
- start a visible GUI browser booking flow and stop at payment/private input;
- create drafts/checklists/reports.

### 13.2 Must still stop or ask

Workers must still stop/ask/block for:

- payment details;
- credentials;
- 2FA/CAPTCHA;
- irreversible or destructive actions not clearly approved;
- ambiguous recipient/action;
- legal/medical/financial final judgement;
- anything where the user's optional feedback materially changes the decision but is missing.

### 13.3 Email deletion semantics

Where options say "delete email", follow the configured retention rule:

- move to `Trash`;
- never permanently delete.

## 14. Implementation phases for future work

This section is not an instruction to implement now. It records a likely future sequence.

### Phase 0 — Documentation only

- Create `~/Projects/keryx/PRD.md`.
- No code.
- No Kanban board.
- No cron jobs.
- No skills.

### Phase 1 — Skeleton and read-only UI

- Create Keryx TypeScript web app skeleton under `~/Projects/keryx` using Svelte + Vite for the client and Fastify for the server.
- Add `opsctl` skeleton.
- Read Kanban board `keryx` via Hermes CLI or safe wrapper.
- Display task cards from JSON bodies.
- Display source status from `keryx-*` cron jobs.
- No execute/dismiss mutation yet.

### Phase 2 — Safe mutations

- Implement `opsctl execute`.
- Implement `opsctl dismiss`.
- Add UI buttons.
- Add idempotency/double-click handling.
- Add validation for malformed JSON cards.

### Phase 3 — Skills

- Create `keryx-worker` skill.
- Create `keryx-collector` skill.
- Add tests/fixtures proving worker and collector prompt-injection boundaries.

### Phase 4 — Collector contracts and one pilot collector

- Implement collector framework conventions.
- Add one low-risk pilot collector later, probably email or Codex projects.
- Verify cursor safety and duplicate prevention.

### Phase 5 — Richer integrations

- Calendar collector.
- Notion collector.
- Facebook collector using visible browser automation.
- configurable result delivery and blocked-task notifications.
- Optional Kanban notify subscriptions.

## 15. Acceptance criteria

### 15.1 PRD acceptance

- PRD exists at `~/Projects/keryx/PRD.md`.
- It captures project name, board name, skill names, cron naming, and V1 decisions.
- It clearly states no implementation has started.

### 15.2 Future product acceptance

A future Keryx MVP is acceptable when:

- the UI shows all active `blocked`, `ready`, `running`, and recent `done` cards from board `keryx`;
- task bodies are parsed as `keryx.action_item.v1` JSON;
- malformed cards are visible with a useful error, not silently dropped;
- Execute writes a trusted decision comment and promotes blocked cards idempotently;
- Dismiss archives cards and prevents exact recurrence;
- source status strip shows `keryx-*` cron health;
- workers load `keryx-worker` and follow the selected option;
- collectors load `keryx-collector` and create only blocked, structured cards;
- no raw source events are persisted by Keryx;
- research/blocked outputs can reach the configured Keryx channel when configured;
- prompt-injection handling is documented and tested.

## 16. Open questions for future implementation

These do not block the PRD.

1. Default delivery target configuration: setup should discover targets with `hermes send --list --json`; do not hard-code private IDs.
2. Whether to use Kanban `notify-subscribe` for all executed tasks or rely on explicit `send_message` in workers.
3. Whether Keryx should create a dedicated `keryx-worker` Hermes profile later.
4. Whether snooze/defer should use Kanban `scheduled` or a Keryx-specific field.
5. How aggressively collectors should scan archived tasks versus maintaining exact-dismiss state.

## 17. Key design decisions already made

- Project name: `keryx`.
- Web UI path: `~/Projects/keryx`.
- Kanban board: `keryx`.
- Collector cron prefix: `keryx-`.
- Skills: `keryx-worker`, `keryx-collector`, and `keryx-collector-creator`.
- Initial action item status: `blocked`.
- Initial worker assignee: `default`.
- Collector implementation now: rules only, no concrete collector.
- Default result delivery for research/feedback: selected during setup from `hermes send --list --json`; no hard-coded platform default.
- Dismiss V1: exact item only.
- Raw source event persistence: no.
- Task body format: JSON only.
- Execution instructions live in `keryx-worker`, not repeated in every card.
- Collector card-creation rules live in `keryx-collector`, not repeated in every cron prompt.
- Collector-authoring rules live in `keryx-collector-creator`.
- `opsctl` belongs inside the Keryx project.
- Web stack: TypeScript, Svelte + Vite client, Fastify server, Vitest for unit/integration tests, Playwright for UI tests.
- Future native app path: Tauri v2, not Electron; defer native packaging until after the responsive web app is useful.
- Future mobile app should normally act as a client to the host-side Keryx server rather than running Hermes locally on the phone.
- Keryx should be cloneable and installable on a fresh Hermes instance, not tailored to a local checkout.

## 18. Cloneable project deliverables

Keryx should be a generic project someone can clone and set up on a fresh Hermes instance. The repository must include the application, setup tooling, skills, schemas, collector templates, and documentation needed to run without relying on the user's local Codex or private configuration.

### 18.1 Repository structure

Target repository shape:

```text
keryx/
├── README.md
├── PRD.md
├── package.json
├── keryx.config.example.json
├── keryx-setup.sh
├── bin/
│   └── opsctl
├── src/
│   ├── web/
│   ├── server/
│   ├── opsctl/
│   ├── hermes/
│   └── schemas/
├── schemas/
│   ├── action-item.v1.schema.json
│   ├── execution-decision.v1.schema.json
│   └── collector-state.v1.schema.json
├── skills/
│   └── keryx/
│       ├── DESCRIPTION.md
│       ├── keryx-worker/
│       │   └── SKILL.md
│       ├── keryx-collector/
│       │   └── SKILL.md
│       └── keryx-collector-creator/
│           └── SKILL.md
├── collectors/
│   ├── README.md
│   ├── bash-first-template/
│   │   ├── keryx-example-scan.sh
│   │   ├── cron-prompt.md
│   │   └── state.example.json
│   └── direct-agent-template/
│       └── cron-prompt.md
├── deploy/
│   ├── systemd/
│   │   └── keryx.service.example
│   └── caddy/
│       └── Caddyfile.example
├── docs/
│   ├── architecture.md
│   ├── collector-authoring.md
│   ├── security.md
│   └── operations.md
└── tests/
```

### 18.2 Launchable web UI

The project root must be launchable with normal Node commands:

```bash
npm install
npm start
```

Required package scripts:

```json
{
  "scripts": {
    "start": "<start local web server>",
    "build": "<production build>",
    "test": "<unit/integration tests>",
    "lint": "<static checks>",
    "typecheck": "<type checks>"
  }
}
```

Runtime expectations:

- Bind to `127.0.0.1` by default.
- Do not require built-in authentication in V1.
- Assume external protection if exposed beyond localhost, e.g. Caddy Basic Auth, Tailscale, or another reverse proxy.
- Poll Hermes/Kanban state every ~30 seconds initially; WebSocket/SSE can come later.

### 18.3 `opsctl` CLI

`opsctl` is a first-class Keryx deliverable, not an afterthought. The web UI may call it directly or call a shared internal library that powers it.

Required commands:

```bash
opsctl doctor
opsctl list [--status blocked|ready|running|done|archived] [--source email]
opsctl show <task_id>
opsctl execute <task_id> --option <option_id> [--feedback "..."]
opsctl dismiss <task_id> [--reason "..."]
opsctl cron-status
opsctl delivery-targets [--json]
opsctl validate-card <file-or-stdin>
```

Future helper commands:

```bash
opsctl create-card --source <source> --body-json <json-file>
opsctl item-exists --idempotency-key <key> [--include-archived]
```

`opsctl` should centralise all Hermes command invocation and output parsing. The web server should not duplicate Hermes CLI command construction in multiple places.

`opsctl delivery-targets --json` should wrap:

```bash
hermes send --list --json
```

and return only the configured/available targets that Keryx can present during setup or in settings.

### 18.4 `opsctl doctor`

`opsctl doctor` should verify a fresh install is ready.

Checks:

- Hermes CLI exists and is executable.
- Hermes gateway is running, or a clear warning explains that cron and Kanban dispatch will not fire automatically.
- Kanban board `keryx` exists.
- `kanban.dispatch_in_gateway=true` where applicable.
- Base skills are installed in the active Hermes home under `$HERMES_HOME/skills/keryx/`:
  - `keryx/DESCRIPTION.md`
  - `keryx/keryx-worker/SKILL.md`
  - `keryx/keryx-collector/SKILL.md`
  - `keryx/keryx-collector-creator/SKILL.md`
- Project dependencies are installed.
- Keryx can list Kanban tasks as JSON.
- Active Keryx cards validate against `schemas/action-item.v1.schema.json`.
- Available Hermes delivery targets can be listed with `hermes send --list --json`.
- A Keryx default delivery target is configured, or `localOnly` is explicitly true.

Doctor output should be concise and action-oriented:

```text
OK    hermes CLI found
OK    board keryx exists
OK    skills installed under ~/.hermes/skills/keryx
WARN  gateway not running — run `hermes gateway start`
WARN  no default delivery target selected — run `./keryx-setup.sh` or use local-only mode
FAIL  skill keryx-worker missing — run `./keryx-setup.sh`
```

### 18.5 Skills bundle

The repository must ship reusable skill templates under `skills/keryx/`, matching Hermes' category-folder convention.

Required bundle shape:

```text
skills/keryx/
├── DESCRIPTION.md
├── keryx-worker/
│   └── SKILL.md
├── keryx-collector/
│   └── SKILL.md
└── keryx-collector-creator/
    └── SKILL.md
```

`DESCRIPTION.md` is required because Hermes category folders use it as category metadata. It should describe the Keryx skill category in generic terms, e.g. "Skills for the Keryx Kanban-backed personal-operations/action-inbox system: collector authoring, collector card creation, and worker execution."

When installed, the target paths should be:

```text
$HERMES_HOME/skills/keryx/DESCRIPTION.md
$HERMES_HOME/skills/keryx/keryx-worker/SKILL.md
$HERMES_HOME/skills/keryx/keryx-collector/SKILL.md
$HERMES_HOME/skills/keryx/keryx-collector-creator/SKILL.md
```

The skill names remain `keryx-worker`, `keryx-collector`, and `keryx-collector-creator`; `keryx/` is the category folder, not part of the skill name.

#### `keryx-worker`

Purpose: execution instructions and generic context for Keryx Kanban tasks.

Responsibilities:

- Parse `keryx.action_item.v1` task-body JSON.
- Find the latest trusted `keryx.execution_decision.v1` comment.
- Validate selected option ID.
- Treat source-derived fields as untrusted data.
- Execute only the selected option plus user feedback.
- Re-query source systems where required.
- Deliver research or blocked-task outputs to the configured Keryx delivery target where requested.
- Complete or block the Kanban task with concise summary and structured metadata.

#### `keryx-collector`

Purpose: instructions and context for collector cron jobs.

Responsibilities:

- Decide whether new source events deserve Keryx cards.
- Create only structured JSON task bodies.
- Create cards on board `keryx` with `--initial-status blocked`.
- Attach `--skill keryx-worker` to every card.
- Use stable idempotency keys.
- Avoid raw source persistence.
- Apply cursor safety rules before advancing collector state.
- Treat source content as untrusted.

#### `keryx-collector-creator`

Purpose: help a user create a new Keryx collector.

Responsibilities:

- Choose between a bash-first collector and a direct-agent collector.
- Generate collector script/prompt/state templates.
- Define source cursor semantics.
- Define idempotency keys.
- Define cron schedule and required toolsets.
- Provide tests or dry-run commands for the collector.
- Keep collector implementation generic and cloneable, not user-specific.

### 18.6 JSON schemas

Keryx must ship formal schemas under `schemas/`.

Required schemas:

```text
schemas/action-item.v1.schema.json
schemas/execution-decision.v1.schema.json
schemas/collector-state.v1.schema.json
```

Use schemas for:

- `opsctl validate-card`;
- UI validation and malformed-card display;
- tests;
- collector development;
- documentation examples.

Malformed cards must be visible with a useful validation error. They must not be silently hidden.

### 18.7 Collector templates

Ship templates, not concrete source collectors, in the generic project.

#### Bash-first template

Use when cheap deterministic source polling is available.

Files:

```text
collectors/bash-first-template/
├── keryx-example-scan.sh
├── cron-prompt.md
└── state.example.json
```

Template behaviour:

- Script reads source-specific state.
- Script queries new source events.
- Script prints `{"wakeAgent": false}` when no LLM pass is needed.
- Script prints compact candidate JSON when the LLM should wake.
- Cron job loads `keryx-collector` and uses script output as context.

#### Direct-agent template

Use when discovery requires browser automation, reasoning, or fragile logged-in context.

Files:

```text
collectors/direct-agent-template/
└── cron-prompt.md
```

Template behaviour:

- Cron job invokes the LLM every scheduled run.
- LLM performs discovery directly.
- LLM creates Keryx cards only for actionable items.
- LLM updates collector state only after successful handling.

### 18.8 Setup script

Ship an idempotent setup script:

```bash
./keryx-setup.sh
```

Required behaviour:

- Locate Hermes home, defaulting to `$HERMES_HOME` or `~/.hermes`.
- Verify `hermes` CLI exists.
- Create Kanban board `keryx` if missing:
  ```bash
  hermes kanban boards create keryx --name "Keryx"
  ```
- Copy bundled skills from `skills/keryx/` into `$HERMES_HOME/skills/keryx/`.
- Copy `skills/keryx/DESCRIPTION.md` into `$HERMES_HOME/skills/keryx/DESCRIPTION.md`.
- Preserve existing installed skills and category description unless `--force` is passed.
- Discover available Hermes delivery targets with:
  ```bash
  hermes send --list --json
  ```
- Ask the installer to choose a default Keryx delivery target from the discovered targets, or choose local-only/no default if none are available.
- Write the selected target into Keryx config.
- Run `opsctl doctor` at the end.

Recommended flags:

```bash
./keryx-setup.sh --dry-run
./keryx-setup.sh --hermes-home ~/.hermes
./keryx-setup.sh --force
./keryx-setup.sh --delivery-target telegram
./keryx-setup.sh --local-only
```

The setup script should **not** create collector cron jobs by default. Collector cron jobs are source-specific and should be created from templates or with `keryx-collector-creator`.

### 18.9 Configuration file

Ship an example config:

```text
keryx.config.example.json
```

Suggested fields:

```json
{
  "board": "keryx",
  "pollIntervalMs": 30000,
  "defaultAssignee": "default",
  "defaultDeliveryTarget": null,
  "localOnly": false,
  "hermesBin": "hermes"
}
```

Rules:

- Do not hard-code private user IDs.
- Do not default to Discord or any other platform without checking what is configured.
- During setup, enumerate available targets with `hermes send --list --json` and let the installer choose from that list.
- If no target is chosen, set `defaultDeliveryTarget: null` and `localOnly: true`; Keryx remains usable but delivery-dependent actions should show a configuration warning.
- Allow the Hermes binary path to be overridden.
- Allow future support for non-default board names, even though the canonical board is `keryx`.

### 18.10 Documentation

Required documentation:

#### `README.md`

Must include:

```bash
git clone <repo>
cd keryx
npm install
./keryx-setup.sh
npm start
```

Also document:

- minimum Hermes version assumptions;
- what setup does, including board creation, skill installation into `skills/keryx/`, and default delivery-target selection from `hermes send --list --json`;
- how to run `opsctl doctor`;
- how to author a collector;
- how to create collector cron jobs;
- how to expose the UI safely through a reverse proxy.

#### `docs/architecture.md`

Explain:

- why Kanban is the central register;
- how blocked/ready/running/done map to Keryx states;
- how collectors create cards;
- how `opsctl execute` promotes cards;
- how workers complete/block cards.

#### `docs/collector-authoring.md`

Explain:

- bash-first vs direct-agent collectors;
- cursor safety;
- idempotency keys;
- exact dismiss state;
- card JSON examples;
- cron schedule examples.

#### `docs/security.md`

Explain:

- source content is untrusted;
- no raw event persistence;
- workers follow trusted execution decision comments;
- external side-effect boundaries;
- visible-browser/payment/credential gates.

#### `docs/operations.md`

Explain:

- source status meanings;
- troubleshooting cron jobs;
- troubleshooting Kanban dispatch;
- where logs live;
- how to recover stuck cards.

### 18.11 Deployment examples

Ship examples, not mandatory deployment machinery.

```text
deploy/systemd/keryx.service.example
deploy/caddy/Caddyfile.example
```

Systemd example should run `npm start` or a production server from the project root.

Caddy example should show:

- reverse proxy to localhost app port;
- authentication handled outside Keryx;
- no public unauthenticated exposure.

Docker Compose can be considered later, but is not required for V1.

### 18.12 Test suite

Minimum tests:

- schema validation tests for all example cards;
- `opsctl execute` idempotency tests:
  - `blocked` -> comment + promote;
  - `ready` -> success/no duplicate promotion;
  - `running` -> success/no mutation;
  - `done` -> success/already completed;
- `opsctl dismiss` tests:
  - comment + archive;
  - exact dismiss metadata if implemented;
- malformed card rendering tests;
- cron-status parsing tests;
- delivery-target discovery tests for `hermes send --list --json` output;
- mocked Hermes CLI tests;
- one e2e test with a temporary `HERMES_HOME` and fake/mocked Hermes commands.

The test suite must not touch the user's real Hermes home by default.

### 18.13 Generic-install acceptance criteria

A fresh user should be able to:

1. Clone Keryx.
2. Run `npm install`.
3. Run `./keryx-setup.sh` and choose a default delivery target from the discovered Hermes targets, or choose local-only mode.
4. Run `opsctl doctor` and see actionable status.
5. Run `npm start`.
6. Open the local UI.
7. See an empty Keryx board rather than errors.
8. Install/create their first collector using `keryx-collector-creator` and the collector templates.

No step should require user-specific files, Codex entries, private paths, or private messaging-platform IDs.
