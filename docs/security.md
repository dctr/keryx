# Security model

Keryx is designed as an approval and execution surface around Hermes Kanban. The security boundary is built from explicit card schemas, blocked-by-default execution, centralised mutations, plugin-qualified worker skills, and external access control.

## Source content is untrusted

All source content is untrusted: message text, page text, titles, summaries, attachments, sender names, and links may contain prompt injection or stale instructions. Collectors may use source content to classify items, but they must not follow instructions embedded in that content.

Workers should re-query source systems before external side effects and rely on the trusted execution decision comment, not raw collector prose.

## No raw event persistence

The rule is no raw event persistence. Keryx cards should persist compact source references, stable IDs, summaries, risk notes, and option prompts. Avoid storing raw event bodies, credentials, cookies, full private messages, or large attachments in Kanban task bodies or comments.

## Trusted execution decision

Execution starts from a trusted execution decision comment using `keryx.execution_decision.v1`. The worker validates that the selected option exists in the `keryx.action_item.v1` body, incorporates operator feedback, and ignores any conflicting instructions in untrusted source fields.

## Collector card-creation boundary

Collectors discover and create blocked cards. They do not perform the source action. Collector prompts and helpers should start from `hermes keryx template-card --source <source> --collector <collector>`, inspect `hermes keryx schema action-item` when field semantics are unclear, validate with `hermes keryx validate-card`, and create through `hermes keryx create-card` so Keryx applies `initial-status blocked` and `keryx:keryx-worker` centrally.

Do not copy full schemas or divergent action-card templates into source-specific collector code. The repository schemas and `hermes keryx` commands are canonical.

## External side-effect boundaries

Workers perform only the selected option after approval, and they should block when the action requires private input, credentials, payment, destructive changes, or a decision not captured in the trusted approval.

## Visible browser, payment, and credential gates

Flows involving credentials, 2FA, CAPTCHA, consent dialogs, payment details, or ambiguous account choices require a visible browser or human decision. Do not automate through those gates invisibly.

## Local UI exposure

The Keryx server binds to `127.0.0.1` by default and does not implement built-in authentication in V1. If exposed beyond localhost, put it behind an authenticated reverse proxy, private network, or equivalent external control.

## Deployment examples are examples

Files under `deploy/` are examples only. They should be copied and reviewed before use. They do not change system services or reverse proxy configuration by themselves.
