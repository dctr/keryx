# Keryx architecture

Keryx is a thin control surface over Hermes Kanban. It adds canonical schemas, a Hermes plugin named `keryx`, the `hermes keryx ...` command surface, a safe `./bin/opsctl` fallback, a local Fastify API, and a Svelte inbox UI. It does not create a second task database.

## Central register

Kanban is the central register. Collectors, the web UI, `hermes keryx`, `opsctl`, and workers all converge on the same board and task lifecycle. This keeps the source of truth auditable and lets normal Hermes dispatch semantics remain in charge of execution.

## Hermes plugin boundary

The Keryx plugin is the Hermes-facing adapter. It registers the `hermes keryx ...` CLI command and repository-backed Keryx skills, then delegates behaviour to repository code. Keryx schemas, skills, config, UI, and command logic remain in this repository.

Repository skills are explicit plugin-qualified loads:

```text
keryx:keryx-worker
keryx:keryx-collector
keryx:keryx-collector-creator
```

## Lifecycle mapping

- `blocked`: visible in Keryx as waiting for operator approval or missing input.
- `ready`: approved and eligible for Hermes dispatch.
- `running`: claimed by a worker.
- `done`: completed by the worker and shown as completed in the UI.
- `archived`: dismissed or no longer relevant.

Keryx should show malformed card bodies rather than hiding them. A malformed card is still a board item and may need repair.

## Collector flow

Collectors inspect sources and create cards only for actionable items. Card bodies are structured as `keryx.action_item.v1`; source content is untrusted and should be reduced to compact facts, references, and options.

Collector authors should use the canonical card workflow rather than hand-maintained templates:

```sh
hermes keryx template-card --source <source> --collector <collector> > /tmp/keryx-card.json
# fill compact candidate facts
hermes keryx schema action-item   # if field semantics are uncertain
hermes keryx validate-card /tmp/keryx-card.json
hermes keryx create-card /tmp/keryx-card.json
rm -f /tmp/keryx-card.json
```

`hermes keryx create-card` centralises board selection, validation, `initial-status blocked`, assignee/tenant/idempotency policy, and worker attachment with `keryx:keryx-worker`. Collectors do not execute source actions themselves. Their job is discovery, classification, safe card creation, and cursor handling.

## Approval and execution

`hermes keryx execute` records a trusted execution decision comment using `keryx.execution_decision.v1`, including the selected option and optional feedback. The direct repository fallback is `opsctl execute`. Both paths promote the card when promotion is appropriate.

Workers read the card, find the latest trusted execution decision, validate the selected option, re-query source systems when needed, perform the selected action, and complete or block the task with concise metadata.

## UI/API boundary

The Fastify API exposes a narrow set of polling-friendly routes for the Svelte UI. Mutating routes delegate to the same command logic as `hermes keryx`/`opsctl`, so command construction and Kanban mutation rules remain centralised.

The web UI binds to `127.0.0.1` by default and has no built-in authentication in V1. If exposed beyond localhost, authentication belongs in an external layer such as a reverse proxy or private network.
