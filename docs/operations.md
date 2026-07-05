# Operations guide

This guide covers the normal checks for running Keryx locally and recovering when cards, collectors, or the digest stall.

## Source status

A source status should tell the operator whether a collector is healthy enough to trust its queue:

- `ok`: recent successful scan and no unresolved collector errors.
- `stale`: no recent success within the expected schedule window.
- `warning`: scan succeeded but reported malformed or skipped items.
- `failed`: the latest scan could not read the source or update state safely.
- `disabled`: the collector cron job is intentionally paused or absent.

## Troubleshooting plugin setup

Run `hermes keryx doctor` after setup and after changing Hermes configuration. If the plugin command is unavailable or doctor reports `FAIL plugin`, check `$HERMES_HOME/plugins/keryx` and run `hermes plugins list`; rerun `./keryx-setup.sh` if the plugin files are missing, otherwise enable it with `hermes plugins enable keryx`. Use `./bin/opsctl doctor` only as the direct repository fallback.

Stale copied skill files from an older installation may exist, but they are no longer the source of truth. Do not delete user-modified skill files automatically; the plugin-registered repository skills should be loaded with names such as `keryx:keryx-worker` and `keryx:keryx-collector`.

Plugin skills are explicit qualified loads and intentionally hidden from `/skills`. Use `keryx:keryx-worker` for Kanban cards and `keryx:keryx-collector` for collector cron jobs. The operator-facing collector designer is a setup-managed bundle at `$HERMES_HOME/skill-bundles/keryx-collector-creator.yaml`; start it with `/keryx-collector-creator create a collector for <source>`. If doctor warns about `collector-creator`, rerun `./keryx-setup.sh` to install the bundle or `./keryx-setup.sh --force` to restore a conflicting bundle.

## Delivery target and digest

Interrupt pushes and digest reports go out through `hermes send` to the `notify_target` chosen during setup. If outbound delivery is missing or wrong:

1. Confirm `notify_target` is set in `keryx.config.json` and matches a live target from `hermes send --list`.
2. Re-run `./keryx-setup.sh` to re-select a delivery target if the stored one is gone.
3. Preview the next digest without sending it with `hermes keryx digest --preview` (the direct fallback is `./bin/opsctl digest --preview`).

The digest itself is a scheduled `keryx-digest` cron job that reads `keryx.outcome.v1` comments since the last run and reports them in one relevancy-grouped, omit-empty message (daily/weekly), modeled on the `daily-brief`/`weekly-brief` pattern. Pending *decisions* are never pushed — they wait in the dashboard. If the digest is empty when you expect content, confirm silent cards actually reached `done` with an outcome comment whose `result_delivery` is `digest` (not `push` or `log_only`).

Review-log access is pull-first: inspect done cards in the dashboard, archive handled items with `hermes keryx mark-reviewed <task_id>` (or `./bin/opsctl mark-reviewed <task_id>`), and preview digest output with `hermes keryx digest --preview`.

## Troubleshooting cron jobs

1. List scheduled jobs and find the collector or `keryx-digest` job by name.
2. Confirm the schedule, prompt, source-specific skill, plugin-qualified generic skill, script path, and working directory.
3. Run the script manually against a fixture or safe source.
4. Confirm the no-work path prints `{"wakeAgent": false}`.
5. Check whether failures are authentication, source format changes, missing files, or state-write problems.
6. Keep failed state conservative: do not advance cursors when card creation or classification failed.

Collector cron jobs should load the plugin-qualified generic skill `keryx:keryx-collector` and any created source-specific skill by its unqualified name `keryx-collector-<source>` (those live in Hermes' space, not the Keryx plugin, so they carry no `keryx:` prefix).

### Optional policy-scan cron

If workers are short-lived or rarely run for a collector, schedule an optional policy scan job so graduation/demotion proposal cards are still generated consistently.

```text
Name: keryx-policy-scan-<source>
Schedule: daily or every 6h
Prompt: Run `hermes keryx policy scan keryx-<source>`; report only errors.
Skills: keryx:keryx-collector
Delivery: local or origin, not interrupt
```

Keep this job non-urgent and quiet on success; it exists to keep policy-learning maintenance moving in the background. Include cold-reset checks in the runbook: after a regret/override resets a class to cold, the next policy scan should propose the appropriate demotion/shadow updates instead of waiting for a long worker run.

`./keryx-setup.sh` does not create this job automatically.

### Deterministic policy and correction command checks

- `hermes keryx policy scan <collector> --preview` should show what promotion/demotion cards would be created for that collector's exact `(collector, class)` history.
- `hermes keryx policy scan <collector>` creates those blocked proposal cards.
- `hermes keryx policy apply <task_id>` is the deterministic apply path for approved proposal cards; do not hand-edit `references/policy.json`.
- `hermes keryx schema correction` prints the correction schema.
- `hermes keryx validate-correction <file>` validates `keryx.correction.v1` comments before posting/importing.

## Troubleshooting Kanban dispatch

If approved or silent-authorized cards do not move:

1. Confirm the board exists and the card status is `ready`.
2. Confirm the assigned profile exists and can be spawned.
3. Confirm gateway dispatch is enabled for the board.
4. Inspect recent task runs for spawn failures, crashes, stale claims, or repeated blocks.
5. Check that the task body validates as `keryx.action_item.v2` and references `keryx:keryx-worker` where expected.
6. For a silent card, confirm it carries a valid synthetic `keryx.policy_decision.v1` comment; without a trusted decision the worker will block rather than execute.

## Logs

Useful places to inspect, depending on how Keryx is installed:

- foreground server output from `npm start`;
- systemd journal for the installed Keryx service;
- Hermes gateway logs for dispatch, cron scheduler, and `hermes send` delivery failures;
- Kanban task run history, decision/outcome comments, and the review log;
- collector state files kept in Hermes' space.

Keep logs free of raw source bodies and secrets where possible.

## Recovering stuck cards

For stuck cards:

1. Read the card body and latest comments.
2. Validate the body with `hermes keryx validate-card <card.json>` or the direct fallback `./bin/opsctl validate-card <card.json>`.
3. If the card carries a decision comment, validate it: a human `keryx.execution_decision.v1` with `hermes keryx validate-decision <decision.json>`, or a synthetic `keryx.policy_decision.v1` with `hermes keryx validate-policy-decision <decision.json>` (direct fallbacks under `./bin/opsctl`). Workers act only on a trusted decision comment.
4. If fields or allowed values are unclear, inspect the canonical schema with `hermes keryx schema action-item`.
5. If a new card must be repaired from source facts, start from `hermes keryx template-card --source <source> --collector <collector>`, validate with `hermes keryx validate-card`, and create it through `hermes keryx create-card`.
6. If the card is `blocked`, check whether it needs operator input (review), is an unanswered interrupt awaiting its `default_on_timeout`, or is missing a trusted decision.
7. If the card is `ready` but not running, inspect Kanban dispatch health.
8. If the card is `running` with an old claim, inspect the worker run and let Kanban reclaim or manually unblock only after confirming no live worker remains.
9. If a silently-executed action went wrong, use `hermes keryx undo <task_id>` to honestly reverse or correct it per the executed option's reversibility, rather than editing source rules.
10. If the source item no longer exists, dismiss the exact card rather than changing broad collector rules.

## Deployment checks

- Run `hermes keryx doctor` after setup and after changing Hermes configuration.
- Keep the web server bound to `127.0.0.1` unless an authenticated reverse proxy or private network is in front of it.
- Confirm `notify_target` resolves to a live delivery target so interrupts and the digest can reach the user.
- Review any copied systemd or Caddy example before enabling it.
- Back up collector state files before editing them manually.
