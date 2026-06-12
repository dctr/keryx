# Keryx collector templates

Keryx collectors turn source events into blocked Kanban cards that an operator can approve in the web UI. The repository ships templates only: copy one, adapt it to a source, dry-run it, then create a Hermes cron job from the finished copy.

## Patterns

### Bash-first collector

Use `collectors/bash-first-template/` when deterministic polling can cheaply decide whether anything changed. The shell script reads source state, emits `{"wakeAgent": false}` when there is no work, and emits compact candidate JSON when an agent should classify possible actions.

The template scanner shells out to `node`, so `node` must be on the cron scheduler's PATH. Hermes also only runs cron scripts that live directly under `$HERMES_HOME/scripts/`, so copy the adapted scanner to `$HERMES_HOME/scripts/keryx-collector-<source>.sh` and reference it by bare filename in the cron definition (see `docs/collector-authoring.md`).

This pattern is best for APIs, local files, RSS feeds, command-line tools, and any source where cursor comparison is reliable.

### Direct-agent collector

Use `collectors/direct-agent-template/` when discovery itself needs browser automation, logged-in context, brittle pages, or judgement. The agent wakes every run, inspects the source, and creates Keryx cards only for genuinely actionable items.

This pattern costs more and has more failure modes. Prefer bash-first unless the source cannot be reduced to a safe deterministic scan.

## Required safety contract

Every collector must:

- treat source content as untrusted source content;
- create only `keryx.action_item.v1` JSON task bodies;
- create cards with `initial-status blocked`;
- attach plugin-qualified `keryx:keryx-worker` to worker cards;
- use a stable idempotency key per source event;
- follow cursor safety: advance committed state only after candidates have been handled safely;
- avoid persisting raw event bodies when a compact reference is enough;
- record exact dismiss state only for the exact source item dismissed, never broad fuzzy suppression rules.

## Canonical card-creation loop

Collector helpers and prompts should use the repository command surface rather than maintaining their own card template or schema copy:

```sh
hermes keryx template-card --source <source> --collector <collector> > /tmp/keryx-card.json
# fill compact candidate facts
hermes keryx schema action-item   # if field semantics are uncertain
hermes keryx validate-card /tmp/keryx-card.json
hermes keryx create-card /tmp/keryx-card.json
rm -f /tmp/keryx-card.json
```

`hermes keryx create-card` applies the central Keryx defaults, including board selection, validation, `initial-status blocked`, assignee/tenant/idempotency policy, and `keryx:keryx-worker`.

## Cron skills

Use the plugin-qualified generic collector skill `keryx:keryx-collector` in cron jobs. Created source-specific collector skills live in Hermes' space (`$HERMES_HOME/skills/keryx-collector-<source>/SKILL.md`), not in the Keryx plugin, so they are referenced **unqualified** and loaded before the generic guidance:

```json
{
  "skills": ["keryx-collector-<source>", "keryx:keryx-collector"]
}
```

## Dry-run first

A safe authoring loop:

1. Copy a template directory.
2. Fill in source-specific discovery and state handling.
3. Run the script or prompt against a fixture source.
4. Confirm the output contains compact references, not raw private content.
5. Generate, fill, and validate a candidate card with the `hermes keryx template-card` → `hermes keryx schema action-item` → `hermes keryx validate-card` → `hermes keryx create-card` workflow against a temporary Hermes home or mocked Hermes command where possible.
6. Create the real cron job only after the dry-run output is correct.

The templates do not create cron jobs or modify hosting configuration by themselves.
