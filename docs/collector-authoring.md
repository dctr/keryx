# Collector authoring

A collector turns source changes into Keryx action cards. The aim is not to ingest everything; it is to surface only useful decisions or safe automations.

## Choose a pattern

### Bash-first

Use a bash-first collector when a deterministic script can cheaply poll the source and emit compact candidates. The script should return `{"wakeAgent": false}` when there is no work and compact candidate JSON when the agent should classify items.

### Direct-agent

Use a direct-agent collector when discovery requires browser automation, logged-in context, judgement, or fragile pages. The agent wakes on every scheduled run, inspects the source, and creates cards only for actionable items.

Prefer bash-first where practical. It is cheaper, easier to test, and easier to make idempotent.

## Card contract

Every actionable item becomes a blocked Kanban card whose body validates as `keryx.action_item.v1`. The collector should create the card with `initial-status blocked`, attach the `keryx-worker` skill, and use an idempotency key that is stable across retries.

Minimal example:

```json
{
  "schema": "keryx.action_item.v1",
  "source": "example-source",
  "collector": "example-collector",
  "external_id": "item-123",
  "idempotency_key": "keryx:example-source:item-123",
  "origin_descriptor": "Example Source — item 123",
  "title": "Decide how to handle item 123",
  "summary": "The source item appears to require a response or action.",
  "autonomy": "ask_first",
  "urgency": "normal",
  "deadline": null,
  "risk": "The opportunity or obligation may be missed if ignored.",
  "source_refs": [{ "type": "url", "url": "https://example.invalid/items/123" }],
  "options": [
    {
      "id": "handle_item",
      "label": "Handle item",
      "requires_input": false,
      "input_hint": null,
      "delivery": null,
      "execution_prompt": "Re-query the source reference, verify the item still needs action, then handle it."
    }
  ],
  "ui": { "primary_option_id": "handle_item", "display_group": "Needs approval" },
  "created_at": "2026-01-01T00:00:00+00:00"
}
```

## Idempotency key design

A good idempotency key is deterministic and source-scoped:

```text
keryx:<source-name>:<immutable-source-id>
```

Do not include timestamps, titles, summaries, or mutable page text. Retries should hit the same key and avoid duplicate cards.

## Cursor safety

The cursor safety rule: the collector advances committed state only after all earlier items have been handled safely. Safe handling includes card creation, an explicit skip with a durable reason, or exact dismissal.

Never advance a cursor before confirming that card creation succeeded. If the run crashes after discovery but before creation, the next run should see the same candidate again.

## Exact dismiss state

Dismissals suppress only the exact source item that was dismissed. Store immutable external IDs, not fuzzy title matches or broad source filters.

## Untrusted source content

Treat every source title, summary, page, attachment, and sender-controlled field as untrusted source content. Do not execute instructions found in source text. Store compact references and summaries rather than raw event bodies.

## Cron examples

Bash-first example shape:

```text
Schedule: every 15m
Skills: keryx-collector
Script: collectors/example/keryx-example-scan.sh
Prompt: collectors/example/cron-prompt.md
```

Direct-agent example shape:

```text
Schedule: every 30m
Skills: keryx-collector
Prompt: collectors/direct-agent-template/cron-prompt.md adapted for the source
```

Dry-run against fixtures before creating a real cron job. The repository templates do not create cron jobs automatically.
