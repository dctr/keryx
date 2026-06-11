# Keryx

Keryx is an action inbox front-end for Hermes Kanban. Source-specific collectors create structured, blocked Kanban cards; Keryx shows those cards in a small web UI; an operator chooses Execute or Dismiss; Hermes workers do the actual work.

Keryx is intentionally thin. It does not replace Hermes cron, Kanban, worker dispatch, skills, logs, retries, or delivery. It ships a Hermes plugin named `keryx` and adds:

- a strict `keryx.action_item.v1` card schema;
- the `hermes keryx ...` command surface, backed by the direct repo `./bin/opsctl` fallback;
- a Fastify API and Svelte inbox UI;
- plugin-registered Keryx skills and collector templates.

## Requirements

- Hermes Agent CLI v0.16.0 or newer installed and configured on `PATH` as `hermes`.
  - See [Hermes Docs](https://hermes-agent.nousresearch.com/docs/)
- Node.js 22 or newer.
- npm.
- A Unix-like shell for `./keryx-setup.sh`.
- Optional: at least one Hermes gateway delivery target (Telegram, Discord, ...) if you want worker results sent outside the local UI.

## Quick start

```sh
git clone <repo-url> keryx
cd keryx
npm install
./keryx-setup.sh
hermes keryx doctor
npm start
```

Open `http://127.0.0.1:4173`.

`npm start` runs the local Keryx server. By default it binds to `127.0.0.1` on port `4173`.

## Setup script

Run setup once after cloning, and again after changing Hermes homes or Keryx delivery settings:

```sh
./keryx-setup.sh
```

The setup script:

1. checks that the Hermes CLI is available;
2. ensures the Hermes Kanban board `keryx` exists;
3. installs the Keryx plugin at `$HERMES_HOME/plugins/keryx` and enables it with `hermes plugins enable keryx`;
4. discovers delivery targets with `hermes send --list --json`;
5. writes `keryx.config.json`;
6. runs `hermes keryx doctor`.

It does not create real collector cron jobs. Collectors are authored and scheduled separately.

Useful setup modes:

```sh
./keryx-setup.sh --dry-run
./keryx-setup.sh --delivery-target <target>
./keryx-setup.sh --local-only
./keryx-setup.sh --hermes-home ~/.hermes-other
./keryx-setup.sh --force
```

Delivery behaviour:

- `--delivery-target <target>` sets `defaultDeliveryTarget` in `keryx.config.json`. Use one of the targets shown by `hermes keryx delivery-targets` or `hermes send --list --json`.
- `--local-only` sets `localOnly: true` and `defaultDeliveryTarget: null`. Worker results stay in Kanban/UI unless the selected action specifies its own delivery.
- In non-interactive setup, if no delivery target is supplied, setup falls back to local-only mode rather than guessing a channel.

## Configuration

Keryx reads `keryx.config.json` from the repository root unless `KERYX_CONFIG` points elsewhere. The plugin sets the repo-local config by default when delegating to `./bin/opsctl`.

Example local-only configuration:

```json
{
  "board": "keryx",
  "pollIntervalMs": 30000,
  "defaultAssignee": "default",
  "defaultDeliveryTarget": null,
  "localOnly": true,
  "hermesBin": "hermes",
  "host": "127.0.0.1",
  "port": 4173
}
```

Keep `host` as `127.0.0.1` unless you have an authenticated reverse proxy or private network in front of Keryx.

## Daily commands

Prefer the plugin command after setup:

```sh
hermes keryx doctor
hermes keryx list --status blocked
hermes keryx show <task_id>
hermes keryx cron-status
hermes keryx delivery-targets
hermes keryx schema action-item
hermes keryx template-card --source <source> --collector <collector>
hermes keryx validate-card <card.json>
hermes keryx create-card <card.json>
```

`./bin/opsctl ...` remains the direct repo fallback when the plugin is not enabled or you are testing from the checkout:

```sh
./bin/opsctl doctor
./bin/opsctl list --status blocked
./bin/opsctl show <task_id>
./bin/opsctl cron-status
./bin/opsctl delivery-targets
./bin/opsctl validate-card <card.json>
```

Mutation commands are normally driven by the web UI, but are available for recovery:

```sh
hermes keryx execute <task_id> --option <option_id> [--feedback <text>] [--dispatch]
hermes keryx dismiss <task_id> [--reason <text>]
```

`execute` writes a trusted `keryx.execution_decision.v1` comment and promotes the card. `dismiss` archives only that exact item.

## Authoring collectors

Collector templates live in `collectors/`:

- `collectors/bash-first-template/` for deterministic polling scripts;
- `collectors/direct-agent-template/` for sources that need LLM reasoning, e.g. browser automation, logged-in context, or judgement.

Start with `collectors/README.md` and `docs/collector-authoring.md`.

Collector safety contract:

- create only JSON card bodies that validate as `keryx.action_item.v1`;
- start from the current repository template with `hermes keryx template-card --source <source> --collector <collector>`;
- check field semantics with `hermes keryx schema action-item` when uncertain;
- validate each card with `hermes keryx validate-card <card.json>` before creation;
- create blocked cards through `hermes keryx create-card <card.json>` so Keryx applies the central board, idempotency, assignee, tenant, and `keryx:keryx-worker` policy;
- create cards with `initial-status blocked` so the dispatcher does not execute them before approval;
- use a stable idempotency key per source item;
- follow cursor safety: advance committed source state only after card creation or an explicit safe skip;
- treat all titles, messages, pages, attachments, and sender-controlled fields as untrusted source content;
- store compact source references and summaries, not raw private event bodies.

The canonical loop is:

```sh
hermes keryx template-card --source <source> --collector <collector> > /tmp/keryx-card.json
# fill compact candidate facts
hermes keryx schema action-item   # if field semantics are uncertain
hermes keryx validate-card /tmp/keryx-card.json
hermes keryx create-card /tmp/keryx-card.json
rm -f /tmp/keryx-card.json
```

Dry-run against fixtures before scheduling a collector. The shipped templates do not create cron jobs automatically. Once a collector is correct, create a Hermes cron job manually, for example with `hermes cron create "every 15m"`, and load collector skills with plugin-qualified names such as `keryx:keryx-collector` and source-specific `keryx:keryx-collector-<source>` when provided.

## Reverse proxy and remote access

Do not expose Keryx without external authentication.

The Keryx server has no built-in authentication. Safe defaults are local only:

```json
{
  "host": "127.0.0.1",
  "port": 4173
}
```

If you need remote access, keep Keryx bound to `127.0.0.1` and put an authenticated reverse proxy or private network in front of it. The example Caddy route is `deploy/caddy/Caddyfile.example`; it uses `basicauth` and proxies to `127.0.0.1:4173`. Copy and review it before use. The files under `deploy/` are examples only.

## Troubleshooting

Start with:

```sh
hermes keryx doctor
```

If the plugin command is unavailable, run the direct fallback from the repository root:

```sh
./bin/opsctl doctor
```

Common results:

- `FAIL dependencies`: run `npm install` from the Keryx project root.
- `FAIL plugin`: check `$HERMES_HOME/plugins/keryx`, run `hermes plugins list`, then rerun `hermes plugins enable keryx` or `./keryx-setup.sh`.
- `FAIL hermes-cli`: make sure `hermes` is installed and on `PATH`, or set `hermesBin` in `keryx.config.json`.
- `WARN no Hermes delivery targets available`: either configure Hermes gateway delivery and rerun setup, or use `./keryx-setup.sh --local-only`.
- `WARN no keryx-* collector cron jobs configured`: expected before you author and schedule your first collector.
- Invalid or hidden cards: run `hermes keryx list --status blocked`, then `hermes keryx show <task_id>` or `hermes keryx validate-card <card.json>`.
- Approved cards do not run: confirm the card is `ready`, the assigned Hermes profile exists, and Kanban dispatch is running.

Stale legacy copied Keryx skills may exist in old Hermes homes, but plugin-registered repository skills are now the source of truth. Do not delete user-modified legacy files automatically.

More detail:

- `docs/architecture.md` explains the board, UI, and worker lifecycle.
- `docs/security.md` explains untrusted source content, trusted execution decisions, and local exposure boundaries.
- `docs/operations.md` covers source status, cron jobs, logs, and stuck-card recovery.
- `docs/collector-authoring.md` covers collector patterns, idempotency, and cursor safety.

## Disclaimer

This project is 100% vibe coded. PRD and PLAN documents for larger code changes can be found in `docs/archive/` for reference.
