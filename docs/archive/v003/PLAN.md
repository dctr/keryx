# Keryx v003 PLAN — assessment remediation

**Date:** 2026-06-12
**Source:** Clean-slate repo assessment (Jarvis, 2026-06-12). This plan cards up the accepted findings for end-to-end autonomous implementation on the `keryx-development` Kanban board. No human review gates; machine-review cards follow each work package.

Execution constraints for all tasks:

- Single repository, strictly serial execution. Every card is linearly dependent on the previous card.
- Every repository-changing card commits (conventional message) and pushes to `origin main` before completing.
- TDD for behaviour changes; tests use fake Hermes runners or temp `HERMES_HOME` fixtures, never the real Hermes home.
- Keep the test suite green at every card boundary.

## Section 1 — Config and API correctness

1.1 Remove dead config fields. `host`, `port`, and `pollIntervalMs` in `keryx.config.json` are validated but never consumed (`src/server/index.ts` reads `HOST`/`PORT` env vars; the UI hardcodes 30 s polling). Remove them from `src/config.ts`, the example config, docs, and tests. Server keeps env-based `HOST`/`PORT` with `127.0.0.1:4173` defaults.

1.2 Remove `defaultDeliveryTarget` and `localOnly`. They influence only doctor display output; no execution path consumes them (workers never read `keryx.config.json`). Remove from config, setup script (including `--delivery-target`/`--local-only` flags and delivery-target discovery), and doctor delivery checks. Keep the read-only `delivery-targets` command and `send --list` allowlist entry as diagnostics.

1.3 Doctor must check the plugin is **enabled**, not merely installed. Currently `checkInstalledPlugin` only stats files under `$HERMES_HOME/plugins/keryx`, so an installed-but-disabled plugin reports `OK plugin`. Add an enablement check (narrowly allowlisted Hermes CLI query or `$HERMES_HOME/config.yaml` `plugins.enabled`/`plugins.disabled` parse) with actionable FAIL/WARN messaging.

1.4 Sanitise task IDs. `/api/tasks/:id/execute` and `/api/tasks/:id/dismiss` accept any non-empty string; IDs beginning with `-` flow into Hermes argv as option-lookalikes. Reject with 400 before invoking opsctl; mirror the guard in opsctl `execute`/`dismiss`.

## Section 2 — Skills correctness

2.1 `keryx-collector-creator` creates source-specific skills (`keryx-collector-$NAME`) into **Hermes' space** (default `$HERMES_HOME/skills/keryx-collector-$NAME/SKILL.md`), never into the Keryx repository. Consequently those created skills are referenced **unqualified** (`keryx-collector-$NAME`), not `keryx:keryx-collector-$NAME` — only repo-shipped plugin skills carry the `keryx:` prefix. Update the creator skill, `keryx-worker`'s feedback loop (`keryx:keryx-collector-$SOURCE` → unqualified), collector templates, `collectors/README.md`, `docs/collector-authoring.md`, `README.md`, and string-asserting tests. The three plugin-shipped skills stay qualified.

2.2 Verify (with an automated, committed test) that the updated guidance directs created skills to Hermes' space and that no instruction writes skills into the repo.

2.3 Add a `validate-decision <file>` command to opsctl/`hermes keryx` validating `keryx.execution_decision.v1`, with help text, README documentation, and tests, at parity with `validate-card`.

2.4 Rework `keryx-worker` to validate via the CLI (`hermes keryx validate-card`, `hermes keryx validate-decision`, `hermes keryx schema ...`) instead of instructing workers to import TypeScript modules — dispatched workers do not run inside the repo's TS runtime.

## Section 3 — Setup safety

3.1 `keryx-setup.sh` overwrites an existing `keryx.config.json` unconditionally. If the config exists: prompt before overwrite when interactive (default: keep); keep + WARN when non-interactive; `--force` always overwrites; dry-run prints intent.

## Section 4 — Docs and version posture

4.1 `npm test` runs bare `vitest` (watch mode) and can hang agents in interactive TTYs. Change the `test` script to `vitest run` (optionally add `test:watch`), update `package-scripts` test and AGENTS.md.

4.2 Remove explicit Hermes version numbers from human-facing docs and error strings (README "v0.16.0 or newer", adapter "Hermes 0.16 ..." messages). The minimum lives in code only.

4.3 Doctor checks the Hermes CLI version is **0.16.0 or later** (the plugin is written against 0.16): allowlist a minimal version query, parse semver, FAIL below minimum, WARN when unparsable.

## Section 5 — Hardening

5.1 Collector templates reference repo-relative cron script paths, but Hermes rejects cron scripts outside `$HERMES_HOME/scripts/`. Fix `collectors/bash-first-template/cron-prompt.md` and the `docs/collector-authoring.md` cron example to copy the adapted script to `$HERMES_HOME/scripts/keryx-collector-<name>.sh` and reference it by bare filename. Document that the template scanner requires `node` on the cron scheduler's PATH.

5.2 DNS-rebinding defence: add a Host-header allowlist (localhost, 127.0.0.1, [::1], optional port; extensible via `KERYX_ALLOWED_HOSTS`) rejecting other Hosts with 403 across API and static routes. Document in `docs/security.md`.

5.3 Schema hardening: tighten `idempotency_key` pattern to the documented `keryx:<source>:<id>` shape; cross-validate `ui.primary_option_id` ∈ `options[].id` in the TS validation layer (draft-07 cannot express it); keep repo JSON schema and TS import in sync; update template, fixtures, docs.

## Section 6 — Verification and delivery

6.1 Final clean-slate verification: install, lint, typecheck, unit/integration tests, build, e2e (install Chromium if needed; record caveat if environment forbids), `./keryx-setup.sh --dry-run`, `./bin/opsctl doctor`. Cross-check every section above.

6.2 Final machine review of the whole chain against this plan; produce a concise change summary.

6.3 Notify David via the default configured Hermes gateway with a summary of the work, key commits, test status, and caveats.
