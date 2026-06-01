---
name: keryx-collector-creator
description: Design and author new Keryx collectors. Use when creating or modifying collector scripts/prompts/templates so they choose the right bash-first or direct-agent pattern, define cursor safety, create blocked keryx.action_item.v1 cards, and dry-run before scheduling.
---

# Keryx collector creator

Author collectors as small source adapters feeding Hermes Kanban. Do not turn Keryx into a second task database.

## Choose a pattern

- Use bash-first when a cheap deterministic script can detect new candidates: email UID scans, local calendar checks, simple Notion/file scans.
- Use direct-agent when discovery needs judgement, browser automation, logged-in sessions, or fragile page state.
- If a source needs credentials, 2FA, CAPTCHA, payment, or private browser input, design the collector to pause/block rather than hiding the requirement.

## Define the collector contract

1. Name the cron job `keryx-<source>` and load `keryx-collector`.
2. Define source namespace, stable external ID, idempotency key format, and state path before writing code.
3. Define cursor safety explicitly: what constitutes handled, when the committed cursor may advance, and how failures avoid item loss.
4. Define exact-dismiss semantics so dismissed items do not recur without creating fuzzy/global suppression rules.
5. Specify the `keryx.action_item.v1` body shape with compact summaries, stable `source_refs`, and one or more options.
6. Keep untrusted source content out of task bodies, state files, comments, test fixtures, and logs unless redacted and clearly marked as data.

## Build and verify

- Start with tests or dry-run fixtures that prove no real Hermes board, cron jobs, delivery targets, or profile skills are mutated.
- For bash-first collectors, test the no-work path prints `{ "wakeAgent": false }` and does not advance state prematurely.
- For direct-agent collectors, test classification prompts against representative actionable and non-actionable examples.
- Verify blocked card creation command shape includes board `keryx`, `initial_status: blocked`, assignee `default`, stable idempotency key, and skill `keryx-worker`.
- Do not schedule real cron jobs until the collector has passed dry-run verification and the operator explicitly asks for installation.

## Output expected from this skill

Produce the collector files, dry-run instructions, state schema/example, and verification commands. Call out any remaining credentials or source-access blockers plainly.
