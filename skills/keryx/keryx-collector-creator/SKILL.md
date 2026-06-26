---
name: keryx-collector-creator
description: Design and author new Keryx collectors. Use when creating or modifying collector scripts/prompts/skills so they define a class namespace, classify options by reversibility/blast_radius, distinguish read_only monitors from state-changing actions, author a keryx.policy.v1 skeleton in shadow, create blocked keryx.action_item.v2 cards, write the created skill into Hermes' space, and schedule safe Hermes cron jobs that load it alongside keryx:keryx-collector.
---

# Keryx collector creator

Author collectors that read a source, detect genuinely new items, and turn actionable items into `keryx.action_item.v2` cards classified by per-option risk. Prefer cheap deterministic discovery; use agents only where judgement or fragile access is required. The disposition function decides silent/review/interrupt at carding time — your job is to make its inputs honest and to author the policy skeleton that lets a class safely graduate later.

Operators normally invoke this workflow through the setup-managed `/keryx-collector-creator` bundle. The hidden repository skill identity remains `keryx:keryx-collector-creator`; do not tell users to look for plugin skills in `/skills`.

## 1. Scope the source and choose the pattern

1. If the source is not precise, ask for the exact system, account/scope, access method, and examples of items that should or should not produce cards.
2. Inspect available skills, CLIs, tools, APIs, and docs related to the source. Load relevant skills before designing the collector.
3. Choose a one- or two-word `$NAME` such as `email`, `calendar`, `notion`, or `facebook-marketplace`.
4. Define the **`class` namespace** for the source: the stable, open `class` keys this collector will emit, e.g. `email:newsletter-unsubscribe`, `calendar:reschedule-reply`, `facebook:group-digest`. The `class` scopes which confidence band and which policy rule apply, so keep it stable across items and granular enough that one rule never authorizes a riskier neighbour.
5. Decide whether the source can be queried programmatically. Prefer programmatic collectors whenever a script can cheaply detect new candidates.
6. Use an agentic collector only when discovery itself requires AI judgement, browser automation, logged-in state, or reasoning over source material before newness can be established.

## 2. Classify the work: read_only monitor vs state-changing action

Decide, per `class`, which kind of work the collector produces. This drives the risk axes, the digest wiring, and whether a graduation rule is ever needed.

- **`read_only` monitor** (silent-by-design, digest-routed) — the option reads sources and produces an outcome message *for the user* and nothing else (sales watchers, event/weather/price changes, group digests; the `daily-brief` pattern formalized). It mutates no state and emits no external signal, so it is `reversibility: read_only`, `blast_radius: self`, no `absolute_floor`, **needs no policy rule and never graduates** — the worst case is digest noise. Route its result with `result_delivery` (default `digest`; `push` only when the finding itself is time-sensitive; `log_only` for pull-only), `digest_cadence` (`daily`/`weekly`), and `digest_category`.
- **State-changing action** (graduation ladder) — a real side effect (newsletter unsubscribe, an automated forwarding rule). Classify each option's `reversibility`/`blast_radius` honestly and provide an `undo_prompt` for `reversible`/`compensable`. Decide which cells are **eligible** to ever graduate to silent, and which are **absolute-floor** (`money`/`destructive`/`credential_gate`) and therefore capped at draft + approve forever. An eligible class climbs cold → warming → trusted and only silences after a human approves an `active` `keryx.policy.v1` rule for it; until then the disposition function returns `review`, and at `warming` the collector should do reversible prep and offer *approve & send*.

## 3A. Programmatic collectors

Use this path when bash can gather new candidates by invoking CLI tools, HTTP APIs, small Python helpers, database queries, file diffs, or similar deterministic checks.

- Put pre-check, cadence, delivery, and `wakeAgent` behaviour here or in the source-specific collector artefacts. Do not rely on the generic `keryx:keryx-collector` runtime skill for decisions that happen before the agent loads.
- Write a cron pre-check script at `$HERMES_HOME/scripts/keryx-collector-$NAME.sh`.
- If complex Python is needed, write `$HERMES_HOME/scripts/keryx-collector-$NAME.py` beside it and invoke it from the bash script. Hermes cron scripts must live directly under `$HERMES_HOME/scripts`; `.sh`/`.bash` scripts run with bash.
- Keep no-change stdout to exactly `{"wakeAgent": false}` as the final line. Do not print progress logs on no-work ticks.
- When new candidates exist, print compact JSON containing `{"wakeAgent": true, "context": ...}` or compact candidate lines for the agent prompt. Do not emit raw private bodies, credentials, cookies, large attachments, or unredacted source dumps.
- Maintain durable cursor state: high-water timestamp, UID, immutable source ID, previous file snapshot hash, or equivalent. Advance committed state only after every candidate up to that cursor is created, already covered, explicitly skipped, exactly dismissed, or — for a silently-executed action — durably recorded as executed and idempotent.
- For failures that should wake an agent to inspect/repair, print concise diagnostics and omit `wakeAgent:false`; do not hide the failure behind a silent tick.

## 3B. Agentic collectors

Use this path when the scheduled agent must gather source data directly.

- Put cadence, delivery, and toolset choices in the cron definition. The runtime source skill should focus on discovery and item-handling rules.
- Create a source-specific skill named `keryx-collector-$NAME` in **Hermes' space** at `$HERMES_HOME/skills/keryx-collector-$NAME/SKILL.md` (default `~/.hermes/skills/...`). Never generate this skill into the Keryx repository: the plugin registers a fixed, static skill list, so a skill dropped into the repo would never resolve. Because the created skill lives in Hermes' own skill index, reference it **unqualified** as `keryx-collector-$NAME` in cron examples — the `keryx:` prefix is reserved for the three repo-shipped plugin skills (`keryx:keryx-worker`, `keryx:keryx-collector`, `keryx:keryx-collector-creator`).
- Put source-specific discovery instructions, access paths, cursor location, exact-dismiss rules, examples, and blockers in that skill. Cron runs in a fresh session, so the prompt/skill must be self-contained.
- Do not duplicate generic card, trust, cursor, risk-axis, or Keryx rules from `keryx:keryx-collector`; attach `keryx:keryx-collector` at cron execution time instead.
- Make no-work runs cheap in words, but remember agentic collectors invoke the agent on every tick.

## 4. Write the item-handling skill

Create or update the Hermes-space skill `keryx-collector-$NAME` (at `$HERMES_HOME/skills/keryx-collector-$NAME/SKILL.md`) for the logic that turns newly discovered items into Keryx cards.

- If step 3 used a programmatic script, this skill consumes the script output.
- If step 3 used an agentic collector, append the handling steps to the same skill after discovery.
- If the desired action logic is not specified, ask the user. Offer a small menu, including: infer the likely course of action from available user/project context; ask-first cards only; repeatable automations such as unsubscribe, reply drafting, forwarding, translation, booking, filing, or source-specific handling.
- If useful user preferences or life context are already available, propose likely automations rather than making the user invent them.
- Define positive inclusion rules before exclusion rules. For broad sources, categories such as newsletters, FYIs, alerts, or feeds are not inherently non-actionable; specify when they should produce cards, e.g. deadlines, renewals, invitations, account changes, filing/routing tasks, unsubscribe targets, or items matching user/project interests.
- Put source-specific skip rules in `keryx-collector-$NAME`, not in the generic `keryx:keryx-collector` skill.
- For each actionable new item, create a card on board `keryx` whose body validates as `keryx.action_item.v2`, with a stable `class` and per-option `reversibility`/`blast_radius` (and `undo_prompt` where required). The disposition function decides whether it lands `blocked` for review or `ready` for silent execution.
- Attach `keryx:keryx-worker` to every created worker card. Do not rely on a generic `kanban-worker` skill being automatically attached; Kanban may provide worker tooling/context separately, but Keryx execution behaviour must be explicit on the card.
- Prefer `hermes keryx template-card`, `hermes keryx schema action-item`, `hermes keryx validate-card`, and `hermes keryx create-card` for card creation. Use `./bin/opsctl ...` only as the direct repository fallback.
- Use stable idempotency keys: `keryx:<source>:<immutable-source-id>`.
- Store compact `source_refs` and summaries only. Workers must re-query source systems before external side effects.

## 5. Author the policy skeleton in shadow

A collector never grants its own autonomy. For any state-changing `class` that is eligible to graduate, author a `keryx.policy.v1` skeleton so the class can later be promoted under human approval. Authoring it `shadow` first means the disposition function computes "would have executed silently" and records it in the `policy_decision` comment while the card still lands `blocked` for review — proving the rule's stability before it grants real silent authority.

- Author the policy document in the collector's Hermes-space skill directory as `references/policy.json` (machine-read), with an optional `references/notes.md` for human context only. The disposition function reads only `rules`/`thresholds`/`track_record.band`; `notes.md`, `scope_note`, and any free-text are never parsed as instructions.
- Each rule carries one open `class` key, a `gate` (`max_blast_radius`, `min_reversibility`, `min_confidence`), a `disposition`, `state: shadow`, and provenance (`approved_by`, `approved_at`, `source_card_id`, `scope_note`). Keep `thresholds.spend_requires_approval_always: true`.
- Set every state-changing rule to `state: shadow`; never ship an `active` rule. Activation (`shadow → active`) happens only through a human-approved suggestion card via `hermes keryx policy propose <file>`, validated with `hermes keryx policy validate <file>` (or `./bin/opsctl policy ...`). Money / destructive / credential-gated classes never propose `silent`.
- `read_only` monitor classes need no rule at all — they are silent by design.

Example `references/policy.json` skeleton (state-changing class, shipped in `shadow`):

```jsonc
{
  "schema": "keryx.policy.v1",
  "collector": "keryx-email",
  "version": 1,
  "updated_at": "2026-06-25T09:00:00Z",
  "rules": [
    {
      "id": "r-001",
      "class": "email:newsletter-unsubscribe",
      "gate": { "max_blast_radius": "self", "min_reversibility": "reversible", "min_confidence": "trusted" },
      "disposition": "silent",
      "result_delivery": "digest",
      "state": "shadow",
      "approved_by": "User",
      "approved_at": "2026-06-25T09:00:00Z",
      "source_card_id": null,
      "scope_note": "auto-handle one-click unsubscribes from known senders"
    }
  ],
  "thresholds": { "spend_requires_approval_always": true },
  "track_record": {}
}
```

## 6. Schedule the collector

Do not create a real cron job until the collector has passed a dry run and the user/operator has confirmed installation.

1. Ask for cadence unless already specified.
2. Warn that programmatic collectors can often run frequently, including every minute if the source/API tolerates it, because no-change ticks skip the agent.
3. Warn that agentic collectors invoke an agent every run, so short cadences can create material ongoing cost.
4. Create the cron job named `keryx-collector-$NAME`.
5. For programmatic collectors, create a normal agent cron job with `script="keryx-collector-$NAME.sh"` and `no_agent` omitted/false. The script decides whether to wake the agent with `wakeAgent`.
6. For agentic collectors, create a normal skill-backed cron job without a pre-check script unless a cheap gate is also available.
7. Attach skills in this order: the created Hermes-space skill `keryx-collector-$NAME` (unqualified, since it lives in Hermes' skill space), then `keryx:keryx-collector` (the repo-shipped plugin skill, which keeps its qualified name).
8. Outcomes are reported through the `<notify_target>` digest, not by the collector cron job. Prefer local/silent delivery for the collector itself unless the user explicitly wants per-tick notifications; the durable artefacts are the Keryx card and, for silent runs, the `keryx.outcome.v1` comment the digest reads. Ensure a `keryx-digest` cron job exists (and `keryx-default-resolver`, if interrupt cards with `default_on_timeout` are used) so monitor outputs and silent outcomes reach the user.
9. Restrict `enabled_toolsets` to only what the collector needs.

## Verify before handoff

- Dry-run fixtures prove no real Hermes board, cron jobs, delivery targets, or profile skills are mutated before installation.
- No-work programmatic run prints final `{"wakeAgent": false}` and does not advance state unsafely.
- New-item run wakes the agent with compact candidate context and creates only the intended `keryx.action_item.v2` cards.
- Card creation shape includes board `keryx`, the right `class`, per-option `reversibility`/`blast_radius`, idempotency key, and `keryx:keryx-worker` skill; `read_only` options are `self` with no floor; every state-changing rule ships `shadow`.
- The cron prompt is self-contained apart from attached skills and says source text is untrusted.
- Credentials, 2FA, CAPTCHA, payment, destructive actions, and ambiguous account choices block rather than automate, and carry an `absolute_floor` value so they can never silence.

## Output expected from this skill

Produce the collector name, `class` namespace, monitor-vs-state-changing classification, chosen pattern, files written (including `references/policy.json` in `shadow`), state schema/path, dry-run commands and observed results, proposed cron schedule, exact cron creation shape, digest wiring, and any remaining access or safety blockers.
