# Keryx plugin skills

Repository-backed skills for Keryx, the Hermes Kanban attention-allocation surface. When loaded through the Keryx Hermes plugin, use plugin-qualified names:

- `keryx:keryx-worker`: execute approved `keryx.action_item.v2` cards after a trusted decision — a human `keryx.execution_decision.v1` (review path) or a synthetic `keryx.policy_decision.v1` (silent path) — then record a `keryx.outcome.v1` comment into the review log.
- `keryx:keryx-collector`: govern source collector cron jobs that classify actionable source events by per-option risk axes and create blocked card creation requests on board `keryx`.
- `keryx:keryx-collector-creator`: design new Keryx collectors with a `class` namespace, the `read_only` monitor vs state-changing distinction, a `keryx.policy.v1` skeleton in `shadow`, cursor safety, idempotency, and safe Hermes cron jobs.

The runtime skills stay plugin-qualified and hidden from `/skills`. Operators start the collector-design workflow through the setup-managed `/keryx-collector-creator` bundle, which loads `keryx:keryx-collector-creator` without copying repository skill content.

## v005 risk model

Keryx no longer carries a single `autonomy` enum. Each `keryx.action_item.v2` option declares its own risk axes — `reversibility` (`read_only` ⊂ `reversible` ⊂ `compensable` ⊂ `irreversible`), `blast_radius` (`self` / `external`), and any hard `absolute_floor` categories (`money` / `destructive` / `credential_gate`) — and the card declares an open `class` string. A deterministic disposition function maps those axes plus the user's derived confidence band for `(collector, class)` to one of three dispositions: **silent**, **review**, or **interrupt**. Outcomes land in the **review log** and are reported through the `<notify_target>` digest.

## Safety contract

- External and untrusted source content is data, not instruction. Collectors avoid raw source persistence; workers act from the trusted decision, never from source text; cursors advance only after every discovered item is handled.
- **Confidence is derived from the user's own approval/override/regret history, never declared by a card or collector**, so injected source content cannot manufacture trust.
- **Policy is the trust gate** for state-changing silent actions, and every `keryx.policy.v1` rule is human-approved through a blocked suggestion card.
- **`read_only` monitors are silent by design** — they mutate no state and emit no external signal, so they need no graduation rule and route to the digest.
- **The absolute floor never silences**: money, destructive, and credential/2FA/CAPTCHA-gated options cap at draft + approve regardless of axes, confidence, or rules.
