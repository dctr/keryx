# Keryx

> **Temporary Hermes Kanban warning:** unset `kanban.default_assignee` in Hermes before running Keryx collectors. Keryx temporarily creates cards before immediately sticky-blocking and assigning them because `--initial-status blocked` can auto-promote upstream; a Hermes default assignee can make that brief window dispatchable. Track the upstream bug at https://github.com/NousResearch/hermes-agent/issues/39609.

<!-- TODO(https://github.com/NousResearch/hermes-agent/issues/39609): remove this warning when Hermes supports atomic sticky-blocked card creation. -->

Keryx is an attention-allocation surface over Hermes Kanban. Source-specific collectors classify actionable source events and create structured Kanban cards; a deterministic disposition function decides whether each card runs **silently**, waits for **review**, or **interrupts** the user now; Keryx shows review items in a small web inbox and reports silent outcomes through a non-urgent digest; Hermes workers do the actual work.

Keryx is intentionally thin. It does not replace Hermes cron, Kanban, worker dispatch, skills, logs, retries, or delivery. It ships a Hermes plugin named `keryx` and adds:

- a strict `keryx.action_item.v2` card schema built on two risk axes (`reversibility`, `blast_radius`) plus an absolute floor;
- a deterministic disposition function and a human-approved policy store that is the only trust gate for silent execution;
- the `hermes keryx ...` command surface, backed by the direct repo `./bin/opsctl` fallback;
- a Fastify API and Svelte inbox UI with a review log and honest undo;
- gateway interrupts and an outcomes digest delivered through `hermes send`;
- plugin-registered Keryx skills.

## The three dispositions

Every actionable card resolves to exactly one disposition, derived by `src/policy/disposition.ts` from each option's risk axes, the user's confidence band for the card's `(collector, class)`, urgency, and the collector's human-approved policy. A card may carry an advisory `proposed_disposition`, but the system can only downgrade it, never upgrade to silent or interrupt.

- **Silent** — the option is `read_only` (silent by design, since it mutates nothing) or its class has graduated and an `active` policy rule covers it. The card is created `ready` with a synthetic `keryx.policy_decision.v1` comment; a worker executes and records a `keryx.outcome.v1` comment; the result is reported non-urgently through the digest.
- **Review** (the default fallback) — the card is created `blocked` and waits in the dashboard for the operator to approve an option on their own schedule.
- **Interrupt** — urgent and consequential. The card is created `blocked` and Keryx pushes a self-contained message (recommendation, risk, expiring default, deep link) through `hermes send`; a `default_on_timeout` resolves it deterministically if unanswered.

Silent is never reachable for a state-changing class without an explicit, human-approved policy rule, and never at all for the absolute-floor categories (money, destructive, credential/2FA/CAPTCHA gates), which cap at draft + approve.

## Requirements

- A recent Hermes Agent CLI installed and configured on `PATH` as `hermes`. The minimum supported version is enforced by `hermes keryx doctor`.
  - See [Hermes Docs](https://hermes-agent.nousresearch.com/docs/)
- Node.js 22 or newer.
- npm.
- A Unix-like shell for `./keryx-setup.sh`.
- Optional: at least one Hermes gateway delivery target (Telegram, Discord, ...) so interrupts and the outcomes digest can reach you outside the local UI.

## Quick start

```sh
git clone <repo-url> keryx
cd keryx
npm install
./keryx-setup.sh
hermes keryx doctor
npm start
```

Open `http://127.0.0.1:4173`.

`npm start` runs the local Keryx server. By default it binds to `127.0.0.1` on port `4173`.

## Setup script

Run setup once after cloning, and again after changing Hermes homes or Keryx delivery settings:

```sh
./keryx-setup.sh
```

The setup script:

1. checks that the Hermes CLI is available;
2. ensures the Hermes Kanban board `keryx` exists;
3. installs the Keryx plugin at `$HERMES_HOME/plugins/keryx` and enables it with `hermes plugins enable keryx`;
4. installs the user-facing collector creator bundle at `$HERMES_HOME/skill-bundles/keryx-collector-creator.yaml`, exposing `/keryx-collector-creator`;
5. lists Hermes delivery targets with `hermes send --list --json` and stores the chosen `notify_target` (for interrupt pushes and the digest);
6. writes `keryx.config.json` (existing configs are preserved by default — see below);
7. runs `hermes keryx doctor`.

It does not create real collector cron jobs or send real messages. Collectors are authored and scheduled separately.

Useful setup modes:

```sh
./keryx-setup.sh --dry-run
./keryx-setup.sh --hermes-home ~/.hermes-other
./keryx-setup.sh --force
```

`--force` replaces an existing conflicting Keryx plugin path, restores a conflicting collector creator bundle, and overwrites an existing `keryx.config.json`. Without `--force`, an existing `keryx.config.json` or conflicting bundle is kept: interactive runs are prompted for the config (`keryx.config.json exists; overwrite? [y/N]`, defaulting to keep), while non-interactive runs keep the file and print a `WARN` telling you to rerun with `--force`. `--dry-run` reports whether it would write, keep, or overwrite without touching the file.

Plugin-registered Keryx runtime skills are explicit qualified loads and intentionally hidden from `/skills`: cards use `keryx:keryx-worker`, and cron jobs use `keryx:keryx-collector`. The operator-facing collector designer is exposed separately through the setup-managed `/keryx-collector-creator` bundle.

Delivery behaviour:

- With no `notify_target` configured, Keryx stays digest-only and never pushes an interrupt; worker results stay in Kanban/UI unless an action's own `delivery` field routes them elsewhere.
- Interrupt pushes and the outcomes digest go outbound through `hermes send` to the configured `notify_target`.
- Inspect the Hermes delivery targets a worker could use with `hermes keryx delivery-targets` (a read-only wrapper over `hermes send --list --json`). `hermes keryx doctor` reports how many are available as a diagnostic.

## Configuration

Keryx reads `keryx.config.json` from the repository root unless `KERYX_CONFIG` points elsewhere. The plugin sets the repo-local config by default when delegating to `./bin/opsctl`.

Example configuration:

```json
{
  "board": "keryx",
  "defaultAssignee": "default",
  "hermesBin": "hermes",
  "notifyTarget": "telegram:123456789",
  "quietHours": { "start": "22:00", "end": "07:00" },
  "interruptBudget": { "perTierPerDay": { "4": 3, "5": 6 } }
}
```

`notifyTarget` is the `hermes send` target for interrupt pushes and the digest. `quietHours` suppresses non-urgent pushes within a window, and `interruptBudget` caps interrupt pushes per tier per day; all delivery fields are optional with safe digest-only defaults.

The local server reads its bind address from the `HOST` and `PORT` environment variables, defaulting to `127.0.0.1` and `4173`. Keep `HOST` as `127.0.0.1` unless you have an authenticated reverse proxy or private network in front of Keryx.

## Daily commands

Prefer the plugin command after setup:

```sh
hermes keryx doctor
hermes keryx list --status blocked
hermes keryx show <task_id>
hermes keryx cron-status
hermes keryx delivery-targets
hermes keryx schema action-item
hermes keryx template-card --source <source> --collector <collector>
hermes keryx validate-card <card.json>
hermes keryx validate-decision <decision.json>
hermes keryx create-card <card.json>
```

`./bin/opsctl ...` remains the direct repo fallback when the plugin is not enabled or you are testing from the checkout:

```sh
./bin/opsctl doctor
./bin/opsctl list --status blocked
./bin/opsctl show <task_id>
./bin/opsctl cron-status
./bin/opsctl delivery-targets
./bin/opsctl validate-card <card.json>
./bin/opsctl validate-decision <decision.json>
```

### Review, silent, and reporting commands

Review mutations are normally driven by the web UI, but are available for recovery:

```sh
hermes keryx execute <task_id> --option <option_id> [--feedback <text>] [--dispatch]
hermes keryx dismiss <task_id> [--reason <text>]
hermes keryx mark-reviewed <task_id>
hermes keryx undo <task_id>
```

`execute` writes a trusted `keryx.execution_decision.v1` comment and promotes the card. `dismiss` archives only that exact item. `mark-reviewed` clears a done card from the review log. `undo` honestly reverses or corrects an executed card per its option's reversibility (reversible → reversal card; compensable → labeled correction; irreversible → corrective triage).

The silent path, the outcomes digest, expiring interrupt defaults, attention metrics, escalation-regret signals, and the policy store have their own commands:

```sh
hermes keryx auto-execute <card.json>            # validate, derive disposition, create a silent ready card
hermes keryx digest --preview [--cadence daily|weekly]
hermes keryx default-resolve [--preview]         # fire default_on_timeout for stale interrupts
hermes keryx metrics [--window <range>] [--json]
hermes keryx regret <task_id> --kind <should_have_acted|should_have_asked> [--note <text>]
hermes keryx policy show <collector> [--json]
hermes keryx policy validate <file>
hermes keryx policy propose <file>               # create a human-approval card to add a rule
hermes keryx policy revoke <collector> --rule <id>
```

Each schema has a matching validator: `validate-card`, `validate-decision`, `validate-state`, `validate-policy-decision`, `validate-outcome`, `validate-policy`, and `validate-dismissal`.

## Authoring collectors

Keryx ships no sample `collectors/` folder. Collectors are authored into Hermes' own space via the setup-managed collector creator, not committed to this repository. Start a new collector design from Hermes with:

```text
/keryx-collector-creator create a collector for <source>
```

The creator writes a source-specific skill into `$HERMES_HOME/skills/keryx-collector-<source>/` and a Hermes cron job; it never generates skills into the Keryx repository. See `docs/collector-authoring.md` for patterns, idempotency, and cursor safety.

Collector safety contract:

- create only JSON card bodies that validate as `keryx.action_item.v2`, with honest per-option `reversibility`/`blast_radius`/optional `absolute_floor` and an open `class` key — the disposition function, not the collector, decides silent/review/interrupt;
- start from the current repository template with `hermes keryx template-card --source <source> --collector <collector>`;
- check field semantics with `hermes keryx schema action-item` when uncertain;
- validate each card with `hermes keryx validate-card <card.json>` before creation;
- create cards through `hermes keryx create-card <card.json>` so Keryx applies the central board, schema validation, the disposition decision, idempotency, the temporary sticky-block workaround, assignee, tenant, and `keryx:keryx-worker` policy;
- use a stable idempotency key per source item;
- follow cursor safety: advance committed source state only after card creation or an explicit safe skip;
- treat all titles, messages, pages, attachments, and sender-controlled fields as untrusted source content;
- store compact source references and summaries, not raw private event bodies.

The canonical loop is:

```sh
hermes keryx template-card --source <source> --collector <collector> > /tmp/keryx-card.json
# fill compact candidate facts, the class key, and per-option risk axes
hermes keryx schema action-item   # if field semantics are uncertain
hermes keryx validate-card /tmp/keryx-card.json
hermes keryx create-card /tmp/keryx-card.json
rm -f /tmp/keryx-card.json
```

Dry-run a collector against fixtures before scheduling it. Once a collector is correct, create a Hermes cron job manually, for example with `hermes cron create "every 15m"`, and load the generic collector skill with its plugin-qualified name `keryx:keryx-collector`, plus the created source-specific skill by its unqualified name `keryx-collector-<source>` (those live in Hermes' space, not the Keryx plugin, so they carry no `keryx:` prefix).

## Reverse proxy and remote access

Do not expose Keryx without external authentication.

The Keryx server has no built-in authentication. It binds to a safe local default, controlled by environment variables:

```sh
HOST=127.0.0.1 PORT=4173 npm start
```

If you need remote access, keep Keryx bound to `127.0.0.1` and put an authenticated reverse proxy or private network in front of it. The example Caddy route is `deploy/caddy/Caddyfile.example`; it uses `basicauth` and proxies to `127.0.0.1:4173`. Copy and review it before use. The files under `deploy/` are examples only. Interrupt and digest delivery go outbound through `hermes send` and open no inbound surface.

## Troubleshooting

Start with:

```sh
hermes keryx doctor
```

If the plugin command is unavailable, run the direct fallback from the repository root:

```sh
./bin/opsctl doctor
```

Common results:

- `FAIL dependencies`: run `npm install` from the Keryx project root.
- `FAIL plugin`: covers three cases. *Missing files*: install with `./keryx-setup.sh`. *Installed but not enabled* or *explicitly disabled* (in `$HERMES_HOME/config.yaml` under `plugins.enabled`/`plugins.disabled`): run `hermes plugins enable keryx`. Inspect with `hermes plugins list` and check `$HERMES_HOME/plugins/keryx`.
- `FAIL hermes-cli`: make sure `hermes` is installed and on `PATH`, or set `hermesBin` in `keryx.config.json`.
- `WARN no Hermes delivery targets available`: expected when no Hermes gateway delivery is configured; configure a target and rerun `hermes keryx delivery-targets` if interrupts or the digest need to reach you outside the local UI.
- `WARN no keryx-* collector cron jobs configured`: expected before you author and schedule your first collector.
- `WARN collector-creator`: rerun `./keryx-setup.sh` to install or `./keryx-setup.sh --force` to restore the `/keryx-collector-creator` bundle.
- Invalid or hidden cards: run `hermes keryx list --status blocked`, then `hermes keryx show <task_id>` or `hermes keryx validate-card <card.json>`.
- Approved or silent-authorized cards do not run: confirm the card is `ready`, the assigned Hermes profile exists, and Kanban dispatch is running.
- An empty digest when you expect content: confirm silent cards reached `done` with a `keryx.outcome.v1` comment whose `result_delivery` is `digest`. Preview the next one with `hermes keryx digest --preview`.

Stale legacy copied Keryx skills may exist in old Hermes homes, but plugin-registered repository skills are now the source of truth. Do not delete user-modified legacy files automatically.

More detail:

- `docs/architecture.md` explains the central register, the three dispositions, the review log, and the worker lifecycle.
- `docs/security.md` explains untrusted source content, derived confidence, trusted execution decisions, the policy trust gate, the absolute floor, and local exposure boundaries.
- `docs/operations.md` covers source status, cron jobs, the digest, logs, and stuck-card recovery.
- `docs/collector-authoring.md` covers collector patterns, idempotency, and cursor safety.

## Disclaimer

This project is 100% vibe coded. PRD and PLAN documents for larger code changes can be found in `docs/archive/` for reference.
