# Operations guide

This guide covers the normal checks for running Keryx locally and recovering when cards or collectors stall.

## Source status

A source status should tell the operator whether a collector is healthy enough to trust its queue:

- `ok`: recent successful scan and no unresolved collector errors.
- `stale`: no recent success within the expected schedule window.
- `warning`: scan succeeded but reported malformed or skipped items.
- `failed`: the latest scan could not read the source or update state safely.
- `disabled`: the collector cron job is intentionally paused or absent.

## Troubleshooting plugin setup

Run `hermes keryx doctor` after setup and after changing Hermes configuration. If the plugin command is unavailable, check `$HERMES_HOME/plugins/keryx`, run `hermes plugins list`, then enable it with `hermes plugins enable keryx`. Use `./bin/opsctl doctor` only as the direct repository fallback.

Stale copied skill files from an older installation may exist, but they are no longer the source of truth. Do not delete user-modified skill files automatically; the plugin-registered repository skills should be loaded with names such as `keryx:keryx-worker` and `keryx:keryx-collector`.

## Troubleshooting cron jobs

1. List scheduled jobs and find the collector by name.
2. Confirm the schedule, prompt, plugin-qualified skills, script path, and working directory.
3. Run the script manually against a fixture or safe source.
4. Confirm the no-work path prints `{"wakeAgent": false}`.
5. Check whether failures are authentication, source format changes, missing files, or state-write problems.
6. Keep failed state conservative: do not advance cursors when card creation or classification failed.

Collector cron jobs should load `keryx:keryx-collector` and any source-specific plugin skill such as `keryx:keryx-collector-<source>`.

## Troubleshooting Kanban dispatch

If approved cards do not move:

1. Confirm the board exists and the card status is `ready`.
2. Confirm the assigned profile exists and can be spawned.
3. Confirm gateway dispatch is enabled for the board.
4. Inspect recent task runs for spawn failures, crashes, stale claims, or repeated blocks.
5. Check that the task body validates as `keryx.action_item.v1` and references `keryx:keryx-worker` where expected.

## Logs

Useful places to inspect, depending on how Keryx is installed:

- foreground server output from `npm start`;
- systemd journal for the installed Keryx service;
- Hermes gateway logs for dispatch and cron scheduler failures;
- Kanban task run history and comments;
- collector-specific state and fixture logs stored beside the collector.

Keep logs free of raw source bodies and secrets where possible.

## Recovering stuck cards

For stuck cards:

1. Read the card body and latest comments.
2. Validate the body with `hermes keryx validate-card <card.json>` or the direct fallback `./bin/opsctl validate-card <card.json>`.
3. If fields or allowed values are unclear, inspect the canonical schema with `hermes keryx schema action-item`.
4. If a new card must be repaired from source facts, start from `hermes keryx template-card --source <source> --collector <collector>`, validate with `hermes keryx validate-card`, and create it through `hermes keryx create-card`.
5. If the card is `blocked`, check whether it needs operator input or a trusted execution decision.
6. If the card is `ready` but not running, inspect dispatch health.
7. If the card is `running` with an old claim, inspect the worker run and let Kanban reclaim or manually unblock only after confirming no live worker remains.
8. If the source item no longer exists, dismiss the exact card rather than changing broad collector rules.

## Deployment checks

- Run `hermes keryx doctor` after setup and after changing Hermes configuration.
- Keep the web server bound to `127.0.0.1` unless an authenticated reverse proxy or private network is in front of it.
- Review any copied systemd or Caddy example before enabling it.
- Back up collector state files before editing them manually.
