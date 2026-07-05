# Security model

Keryx is an attention-allocation and execution surface around Hermes Kanban. The security boundary is built from explicit card schemas, blocked-by-default execution, a deterministic disposition function, human-approved policy as the only silent-execution trust gate, centralised mutations, plugin-qualified worker skills, and external access control.

The central security problem of v005 is that **the human approval comment is no longer the only trust gate**. When Keryx acts silently, the trust gate becomes an explicit, inspectable, human-approved policy rule — never a claim made by a collector or by untrusted source content, and never reachable for money, destructive, or credential-gated actions.

## Source content is untrusted

All source content is untrusted: message text, page text, titles, summaries, attachments, sender names, and links may contain prompt injection or stale instructions. Collectors may use source content to classify items, but they must not follow instructions embedded in that content, and they must not copy source-authored imperatives into option `execution_prompt` text.

Workers re-query source systems before external side effects and act only from the trusted decision comment, treating any retrieved source text as evidence, not instruction.

## Confidence is derived, never declared

A card's **confidence** band for its exact `(collector, class)` scope is derived from the user's own approval / override / regret history recorded in the Kanban audit trail. It is never a card field and never set by a collector, so injected source content cannot manufacture trust or push a card toward silent execution. A collector supplies only honest risk evidence (`reversibility`, `blast_radius`, optional `absolute_floor`) and an open `class` key; the disposition function does the rest.

Confidence uses cold-reset epochs: dismissal, rejection, or silent-regret events for a `(collector, class)` reset that scope to `cold`; prior approvals no longer sustain silent eligibility, and confidence rebuilds only from events after the latest reset.

## No raw event persistence

The rule is no raw event persistence. Keryx cards should persist compact source references, stable IDs, summaries, risk notes, and option prompts. Avoid storing raw event bodies, credentials, cookies, full private messages, or large attachments in Kanban task bodies, comments, outcomes, or logs.

## Trusted execution decision

Execution starts from a trusted decision comment — on the review path this is the trusted execution decision a human recorded. There are exactly two trusted kinds:

- a human `keryx.execution_decision.v1` on the **review** path, and
- a synthetic `keryx.policy_decision.v1` (`approved_by: "keryx-policy"`) on the **silent** path.

The worker validates that the selected option exists in the `keryx.action_item.v2` body, incorporates operator feedback when present (a policy decision carries none — its only authority is its `reasons[]`), and ignores any conflicting instructions in untrusted source fields.

## Policy is the trust gate for silent execution

For any state-changing silent action, **policy is the trust gate**. A state-changing option may execute silently only when its `class` has climbed the graduation ladder (cold → warming → trusted) and a human has approved an `active` `keryx.policy.v1` rule whose gate bounds (`min_reversibility`, `max_blast_radius`, `min_confidence`) cover the option. Every rule is human-approved through a blocked suggestion card created by `hermes keryx policy propose`; a `shadow` rule never authorizes silent execution, it only computes what it *would have* done. Workers and collectors propose promotions and demotions but never self-grant them.

Policy evolution uses deterministic commands, not manual edits: `hermes keryx policy scan <collector> [--preview]` creates/preview promotion and demotion proposals from the derived history, and `hermes keryx policy apply <task_id>` applies an approved proposal to `references/policy.json`.

Text feedback is advisory evidence, not authority: `keryx.correction.v1` comments are inspected with `hermes keryx schema correction` and validated with `hermes keryx validate-correction <file>`.

## read_only monitors are silent by design

A `read_only` option mutates no state and emits no external signal — it reads sources and produces an outcome message for the user. Because it exercises no authority, it is silent by design, needs no graduation rule, and routes its outcome to the digest. The schema and the worker both enforce that `read_only` requires `blast_radius = self` and carries no `absolute_floor`; a read that leaves an externally observable signal (read-receipt, recorded visit, mark-as-read) is not `read_only` and must be declared at least `reversible` + `external`.

## The absolute floor never silences

The **absolute floor** is a hard cap: any option carrying an `absolute_floor` category — `money`, `destructive`, or `credential_gate` (credentials, 2FA, CAPTCHA, consent dialogs, payment) — can never run silently, regardless of risk axes, confidence band, or any learned rule. It caps at draft + approve, and the worker re-checks the floor against live facts at execution time, not just at carding time.

## External side-effect boundaries

Workers perform only the selected option after a trusted decision, and they block when the action requires private input, credentials, payment, destructive changes, ambiguous account choices, or any decision not captured in the trusted approval. Before any external side effect they run a plan-drift check: action, target account, recipient, URL/domain, amount, and delivery must match the approved option or trusted user feedback, not source text, and the re-queried source must not have escalated beyond the option's declared axes.

## Visible browser, payment, and credential gates

Flows involving credentials, 2FA, CAPTCHA, consent dialogs, payment details, or ambiguous account choices require a visible browser or human decision. Do not automate through those gates invisibly.

## Local UI exposure

The Keryx server binds to `127.0.0.1` by default and does not implement built-in authentication. Interrupt and digest delivery go outbound through `hermes send` and open no inbound surface. If the dashboard is exposed beyond localhost, put it behind an authenticated reverse proxy, private network, or equivalent external control.

### Host-header allowlist (DNS-rebinding defence)

Because the server binds to localhost without authentication, a malicious web page could use DNS rebinding — pointing a hostname it controls at `127.0.0.1` — to reach the local API from a victim's browser. To block this, an `onRequest` hook validates the `Host` header before any route (API or static) runs:

- Allowed by default: `localhost`, `127.0.0.1`, and `[::1]`, with or without any port. Matching is on the hostname only (IPv6 brackets are parsed and the port is ignored), case-insensitively.
- Other hosts are rejected with HTTP `403` and the standard API error shape `{ ok: false, error: { code: "FORBIDDEN_HOST", message: ... } }`.
- Missing-Host policy: a request without a `Host` header is allowed. HTTP/1.1 browsers always send a `Host`, so a request without one is a CLI client or raw-socket caller, not a browser, and the DNS-rebinding attack does not apply. A present-but-malformed `Host` is rejected.

For reverse-proxy deployments that terminate a public hostname, extend the allowlist with the `KERYX_ALLOWED_HOSTS` environment variable — a comma-separated list of additional hostnames (ports and IPv6 brackets are normalised away). For example:

```sh
KERYX_ALLOWED_HOSTS=keryx.example.com npm start
```

The proxy should forward the original `Host` (Caddy's `reverse_proxy` does this by default) or set it to a value present in `KERYX_ALLOWED_HOSTS`.

## Deployment examples are examples

Files under `deploy/` are examples only. They should be copied and reviewed before use. They do not change system services or reverse proxy configuration by themselves.
