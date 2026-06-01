# Operations guide

This guide covers the normal checks for running Keryx locally and recovering when cards or collectors stall.

## Source status

A source status should tell the operator whether a collector is healthy enough to trust its queue:

- `ok`: recent successful scan and no unresolved collector errors.
- `stale`: no recent success within the expected schedule window.
- `warning`: scan succeeded but reported malformed or skipped items.
- `failed`: the latest scan could not read the source or update state safely.
- `disabled`: the collector cron job is intentionally paused or absent.

## Troubleshooting cron jobs

1. List scheduled jobs and find the collector by name.
2. Confirm the schedule, prompt, skills, script path, and working directory.
3. Run the script manually against a fixture or safe source.
4. Confirm the no-work path prints `{"wakeAgent": false}`.
5. Check whether failures are authentication, source format changes, missing files, or state-write problems.
6. Keep failed state conservative: do not advance cursors when card creation or classification failed.

## Troubleshooting Kanban dispatch

If approved cards do not move:

1. Confirm the board exists and the card status is `ready`.
2. Confirm the assigned profile exists and can be spawned.
3. Confirm gateway dispatch is enabled for the board.
4. Inspect recent task runs for spawn failures, crashes, stale claims, or repeated blocks.
5. Check that the task body validates as `keryx.action_item.v1` and references `keryx-worker` where expected.

## Logs

Useful places to inspect, depending on how Keryx is installed:

- foreground server output from `npm start`;
- systemd journal for the copied Keryx service;
- Hermes gateway logs for dispatch and cron scheduler failures;
- Kanban task run history and comments;
- collector-specific state and fixture logs stored beside the copied collector.

Keep logs free of raw source bodies and secrets where possible.

## Recovering stuck cards

For stuck cards:

1. Read the card body and latest comments.
2. Validate the body with `opsctl validate-card`.
3. If the card is `blocked`, check whether it needs operator input or a trusted execution decision.
4. If the card is `ready` but not running, inspect dispatch health.
5. If the card is `running` with an old claim, inspect the worker run and let Kanban reclaim or manually unblock only after confirming no live worker remains.
6. If the source item no longer exists, dismiss the exact card rather than changing broad collector rules.

## Deployment checks

- Run `opsctl doctor` after setup and after changing Hermes configuration.
- Keep the web server bound to `127.0.0.1` unless an authenticated reverse proxy or private network is in front of it.
- Review any copied systemd or Caddy example before enabling it.
- Back up collector state files before editing them manually.
