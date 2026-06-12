---
name: keryx-collector-creator
description: Design and author new Keryx collectors. Use when creating or modifying collector scripts/prompts/templates so they choose the right programmatic or agentic pattern, define cursor safety, create blocked keryx.action_item.v1 cards, write the created source skill into Hermes' space, and schedule safe Hermes cron jobs that load the unqualified created skill alongside the plugin-qualified keryx:keryx-collector.
---

# Keryx collector creator

Author collectors that read a source, detect genuinely new items, and turn actionable items into blocked Keryx Kanban cards. Prefer cheap deterministic discovery; use agents only where judgement or fragile access is required.

Operators normally invoke this workflow through the setup-managed `/keryx-collector-creator` bundle. The hidden repository skill identity remains `keryx:keryx-collector-creator`; do not tell users to look for plugin skills in `/skills`.

## 1. Scope the source and choose the pattern

1. If the source is not precise, ask for the exact system, account/scope, access method, and examples of items that should or should not produce cards.
2. Inspect available skills, CLIs, tools, APIs, and docs related to the source. Load relevant skills before designing the collector.
3. Choose a one- or two-word `$NAME` such as `email`, `calendar`, `notion`, or `facebook-marketplace`.
4. Decide whether the source can be queried programmatically. Prefer programmatic collectors whenever a script can cheaply detect new candidates.
5. Use an agentic collector only when discovery itself requires AI judgement, browser automation, logged-in state, or reasoning over source material before newness can be established.

## 2A. Programmatic collectors

Use this path when bash can gather new candidates by invoking CLI tools, HTTP APIs, small Python helpers, database queries, file diffs, or similar deterministic checks.

- Put pre-check, cadence, delivery, and `wakeAgent` behaviour here or in the source-specific collector artefacts. Do not rely on the generic `keryx:keryx-collector` runtime skill for decisions that happen before the agent loads.
- Write a cron pre-check script at `$HERMES_HOME/scripts/keryx-collector-$NAME.sh`.
- If complex Python is needed, write `$HERMES_HOME/scripts/keryx-collector-$NAME.py` beside it and invoke it from the bash script. Hermes cron scripts must live directly under `$HERMES_HOME/scripts`; `.sh`/`.bash` scripts run with bash.
- Keep no-change stdout to exactly `{"wakeAgent": false}` as the final line. Do not print progress logs on no-work ticks.
- When new candidates exist, print compact JSON containing `{"wakeAgent": true, "context": ...}` or compact candidate lines for the agent prompt. Do not emit raw private bodies, credentials, cookies, large attachments, or unredacted source dumps.
- Maintain durable cursor state: high-water timestamp, UID, immutable source ID, previous file snapshot hash, or equivalent. Advance committed state only after every candidate up to that cursor is created, already covered, explicitly skipped, or exactly dismissed.
- For failures that should wake an agent to inspect/repair, print concise diagnostics and omit `wakeAgent:false`; do not hide the failure behind a silent tick.

## 2B. Agentic collectors

Use this path when the scheduled agent must gather source data directly.

- Put cadence, delivery, and toolset choices in the cron definition. The runtime source skill should focus on discovery and item-handling rules.
- Create a source-specific skill named `keryx-collector-$NAME` in **Hermes' space** at `$HERMES_HOME/skills/keryx-collector-$NAME/SKILL.md` (default `~/.hermes/skills/...`). Never generate this skill into the Keryx repository: the plugin registers a fixed, static skill list, so a skill dropped into the repo would never resolve. Because the created skill lives in Hermes' own skill index, reference it **unqualified** as `keryx-collector-$NAME` in cron examples — the `keryx:` prefix is reserved for the three repo-shipped plugin skills (`keryx:keryx-worker`, `keryx:keryx-collector`, `keryx:keryx-collector-creator`).
- Put source-specific discovery instructions, access paths, cursor location, exact-dismiss rules, examples, and blockers in that skill. Cron runs in a fresh session, so the prompt/skill must be self-contained.
- Do not duplicate generic card, trust, cursor, or Keryx rules from `keryx:keryx-collector`; attach `keryx:keryx-collector` at cron execution time instead.
- Make no-work runs cheap in words, but remember agentic collectors invoke the agent on every tick.

## 3. Write the item-handling skill

Create or update the Hermes-space skill `keryx-collector-$NAME` (at `$HERMES_HOME/skills/keryx-collector-$NAME/SKILL.md`) for the logic that turns newly discovered items into Keryx cards.

- If step 2 used a programmatic script, this skill consumes the script output.
- If step 2 used an agentic collector, append the handling steps to the same skill after discovery.
- If the desired action logic is not specified, ask the user. Offer a small menu, including: infer the likely course of action from available user/project context; ask-first cards only; repeatable automations such as unsubscribe, reply drafting, forwarding, translation, booking, filing, or source-specific handling.
- If useful user preferences or life context are already available, propose likely automations rather than making the user invent them.
- Define positive inclusion rules before exclusion rules. For broad sources, categories such as newsletters, FYIs, alerts, or feeds are not inherently non-actionable; specify when they should produce cards, e.g. deadlines, renewals, invitations, account changes, filing/routing tasks, unsubscribe targets, or items matching user/project interests.
- Put source-specific skip rules in `keryx-collector-$NAME`, not in the generic `keryx:keryx-collector` skill.
- For each actionable new item, create a blocked card on board `keryx` whose body validates as `keryx.action_item.v1`.
- Attach `keryx:keryx-worker` to every created worker card. Do not rely on a generic `kanban-worker` skill being automatically attached; Kanban may provide worker tooling/context separately, but Keryx execution behaviour must be explicit on the card.
- Prefer `hermes keryx template-card`, `hermes keryx validate-card`, and `hermes keryx create-card` for card creation. Use `./bin/opsctl ...` only as the direct repository fallback.
- Use stable idempotency keys: `keryx:<source>:<immutable-source-id>`.
- Store compact `source_refs` and summaries only. Workers must re-query source systems before external side effects.

## 4. Schedule the collector

Do not create a real cron job until the collector has passed a dry run and the user/operator has confirmed installation.

1. Ask for cadence unless already specified.
2. Warn that programmatic collectors can often run frequently, including every minute if the source/API tolerates it, because no-change ticks skip the agent.
3. Warn that agentic collectors invoke an agent every run, so short cadences can create material ongoing cost.
4. Create the cron job named `keryx-collector-$NAME`.
5. For programmatic collectors, create a normal agent cron job with `script="keryx-collector-$NAME.sh"` and `no_agent` omitted/false. The script decides whether to wake the agent with `wakeAgent`.
6. For agentic collectors, create a normal skill-backed cron job without a pre-check script unless a cheap gate is also available.
7. Attach skills in this order: the created Hermes-space skill `keryx-collector-$NAME` (unqualified, since it lives in Hermes' skill space), then `keryx:keryx-collector` (the repo-shipped plugin skill, which keeps its qualified name).
8. Prefer local/silent delivery unless the user explicitly wants notifications; the durable artefact is the blocked Keryx card.
9. Restrict `enabled_toolsets` to only what the collector needs.

## Verify before handoff

- Dry-run fixtures prove no real Hermes board, cron jobs, delivery targets, or profile skills are mutated before installation.
- No-work programmatic run prints final `{"wakeAgent": false}` and does not advance state unsafely.
- New-item run wakes the agent with compact candidate context and creates only blocked card requests.
- Card creation shape includes board `keryx`, `initial-status blocked`, assignee/profile as intended, idempotency key, and `keryx:keryx-worker` skill.
- The cron prompt is self-contained apart from attached skills and says source text is untrusted.
- Credentials, 2FA, CAPTCHA, payment, destructive actions, and ambiguous account choices block rather than automate.

## Output expected from this skill

Produce the collector name, chosen pattern, files written, state schema/path, dry-run commands and observed results, proposed cron schedule, exact cron creation shape, and any remaining access or safety blockers.
