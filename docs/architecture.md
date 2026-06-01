# Keryx architecture

Keryx is a thin control surface over Hermes Kanban. It adds schemas, a safe `opsctl` wrapper, a local Fastify API, and a Svelte inbox UI. It does not create a second task database.

## Central register

Kanban is the central register. Collectors, the web UI, `opsctl`, and workers all converge on the same board and task lifecycle. This keeps the source of truth auditable and lets normal Hermes dispatch semantics remain in charge of execution.

## Lifecycle mapping

- `blocked`: visible in Keryx as waiting for operator approval or missing input.
- `ready`: approved and eligible for Hermes dispatch.
- `running`: claimed by a worker.
- `done`: completed by the worker and shown as completed in the UI.
- `archived`: dismissed or no longer relevant.

Keryx should show malformed card bodies rather than hiding them. A malformed card is still a board item and may need repair.

## Collector flow

Collectors inspect sources and create cards only for actionable items. Card bodies are structured as `keryx.action_item.v1`. Collectors attach `keryx-worker`, use stable idempotency keys, and create cards with `initial-status blocked` so an operator chooses the action before execution.

Collectors do not execute source actions themselves. Their job is discovery, classification, safe card creation, and cursor handling.

## Approval and execution

`opsctl execute` records a trusted execution decision comment using `keryx.execution_decision.v1`, including the selected option and optional feedback. It then promotes the card when promotion is appropriate.

Workers read the card, find the latest trusted execution decision, validate the selected option, re-query source systems when needed, perform the selected action, and complete or block the task with concise metadata.

## UI/API boundary

The Fastify API exposes a narrow set of polling-friendly routes for the Svelte UI. Mutating routes delegate to the same command logic as `opsctl`, so command construction and Kanban mutation rules remain centralised.

The web UI binds to `127.0.0.1` by default and has no built-in authentication in V1. If exposed beyond localhost, authentication belongs in an external layer such as a reverse proxy or private network.
