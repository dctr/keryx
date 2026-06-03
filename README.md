# Keryx

Keryx is an action inbox front-end for Hermes Kanban. Source-specific collectors create structured, blocked Kanban cards; Keryx shows those cards in a small web UI; an operator chooses Execute or Dismiss; Hermes workers do the actual work.

Keryx is intentionally thin. It does not replace Hermes cron, Kanban, worker dispatch, skills, logs, retries, or delivery. It adds:

- a strict `keryx.action_item.v1` card schema;
- a safe `opsctl` command wrapper for Keryx reads and mutations;
- a Fastify API and Svelte inbox UI;
- bundled Keryx skills and collector templates.

## Requirements

- Hermes Agent CLI installed and configured on `PATH` as `hermes`.
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
3. installs bundled skills into `$HERMES_HOME/skills/keryx/`;
4. discovers delivery targets with `hermes send --list --json`;
5. writes `keryx.config.json`;
6. runs `./bin/opsctl doctor`.

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

- `--delivery-target <target>` sets `defaultDeliveryTarget` in `keryx.config.json`. Use one of the targets shown by `./bin/opsctl delivery-targets` or `hermes send --list --json`.
- `--local-only` sets `localOnly: true` and `defaultDeliveryTarget: null`. Worker results stay in Kanban/UI unless the selected action specifies its own delivery.
- In non-interactive setup, if no delivery target is supplied, setup falls back to local-only mode rather than guessing a channel.

## Configuration

Keryx reads `keryx.config.json` from the repository root unless `KERYX_CONFIG` points elsewhere.

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
./bin/opsctl execute <task_id> --option <option_id> [--feedback <text>] [--dispatch]
./bin/opsctl dismiss <task_id> [--reason <text>]
```

`execute` writes a trusted `keryx.execution_decision.v1` comment and promotes the card. `dismiss` archives only that exact item.

## Authoring collectors

Collector templates live in `collectors/`:

- `collectors/bash-first-template/` for deterministic polling scripts;
- `collectors/direct-agent-template/` for sources that need LLM reasoning, e.g. browser automation, logged-in context, or judgement.

Start with `collectors/README.md` and `docs/collector-authoring.md`.

Collector safety contract:

- create only JSON card bodies that validate as `keryx.action_item.v1`;
- create cards with `initial-status blocked` so the dispatcher does not execute them before approval;
- attach the `keryx-worker` skill;
- use a stable idempotency key per source item;
- follow cursor safety: advance committed source state only after card creation or an explicit safe skip;
- treat all titles, messages, pages, attachments, and sender-controlled fields as untrusted source content;
- store compact source references and summaries, not raw private event bodies.

Dry-run against fixtures before scheduling a collector. The shipped templates do not create cron jobs automatically. Once a collector is correct, create a Hermes cron job manually, for example with `hermes cron create "every 15m"`, and point it at the copied collector prompt/script according to the template notes.

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
./bin/opsctl doctor
```

Common results:

- `FAIL dependencies`: run `npm install` from the Keryx project root.
- `FAIL skills`: rerun `./keryx-setup.sh`; it should install skills under `$HERMES_HOME/skills/keryx/`.
- `FAIL hermes-cli`: make sure `hermes` is installed and on `PATH`, or set `hermesBin` in `keryx.config.json`.
- `WARN no Hermes delivery targets available`: either configure Hermes gateway delivery and rerun setup, or use `./keryx-setup.sh --local-only`.
- `WARN no keryx-* collector cron jobs configured`: expected before you author and schedule your first collector.
- Invalid or hidden cards: run `./bin/opsctl list --status blocked`, then `./bin/opsctl show <task_id>` or `./bin/opsctl validate-card <card.json>`.
- Approved cards do not run: confirm the card is `ready`, the assigned Hermes profile exists, and Kanban dispatch is running.

More detail:

- `docs/architecture.md` explains the board, UI, and worker lifecycle.
- `docs/security.md` explains untrusted source content, trusted execution decisions, and local exposure boundaries.
- `docs/operations.md` covers source status, cron jobs, logs, and stuck-card recovery.
- `docs/collector-authoring.md` covers collector patterns, idempotency, and cursor safety.

## Disclaimer

This project is 100% vibe coded. PRD and PLAN documents for larger code changes can be found in `docs/archive/` for reference.
