# Keryx Web UI Implementation Plan

> **For Hermes:** Implement this plan through the `keryx-development` Kanban board task-by-task. Keep the workflow serial unless a task explicitly creates an isolated git worktree.

**Goal:** Build a fully functioning Keryx web UI, safe `opsctl` wrapper, installer script, bundled skills, collector templates, and documentation inside the repository root (`.`).

**Architecture:** Keryx is a thin TypeScript control surface over Hermes Kanban. The central register remains the Hermes Kanban board `keryx`; Keryx adds schema validation, a Fastify API, a Svelte inbox UI, and an `opsctl` CLI that wraps allowed Hermes commands. Keryx must not create a second task database or duplicate Hermes execution.

**Tech Stack:** TypeScript, Svelte + Vite, Fastify, Vitest, Playwright, AJV JSON-schema validation, Node CLI scripts, POSIX shell installer.

**Source of truth:** `docs/archive/v001/PRD.md` from the repository root. Ignore the future native-app/Tauri section for this implementation.

---

## Global constraints

- Implement only in the repository root (`.`).
- Do not install the bundled Keryx skills into the local Hermes profile during implementation.
- Do not create real collector cron jobs during implementation.
- Do not create or mutate the user's real `keryx` Kanban board during tests except through explicitly mocked or temporary test fixtures.
- Tests that exercise install behaviour must use a temporary `HERMES_HOME`.
- Application code must be written with the `test-driven-development` skill: write failing tests first, verify RED, implement minimal GREEN, then refactor.
- Skill-writing tasks must use the `skill-creator` skill: concise frontmatter, focused instructions, no stray README/CHANGELOG files inside individual skill directories.
- Commit after each Kanban implementation task with a clear `type: subject` message.

## Required repository shape

```text
keryx/
├── README.md
├── docs/
│   └── archive/
│       └── v001/
│           ├── PLAN.md
│           └── PRD.md
├── package.json
├── package-lock.json
├── tsconfig.json
├── vite.config.ts
├── vitest.config.ts
├── playwright.config.ts
├── svelte.config.js
├── keryx.config.example.json
├── keryx-setup.sh
├── bin/
│   └── opsctl
├── schemas/
│   ├── action-item.v1.schema.json
│   ├── execution-decision.v1.schema.json
│   └── collector-state.v1.schema.json
├── src/
│   ├── web/
│   │   ├── App.svelte
│   │   ├── main.ts
│   │   ├── styles.css
│   │   └── lib/
│   │       ├── api.ts
│   │       ├── filters.ts
│   │       └── taskView.ts
│   ├── server/
│   │   ├── app.ts
│   │   ├── index.ts
│   │   └── routes.ts
│   ├── opsctl/
│   │   ├── cli.ts
│   │   ├── commands.ts
│   │   └── output.ts
│   ├── hermes/
│   │   ├── adapter.ts
│   │   ├── fakeHermes.ts
│   │   └── types.ts
│   ├── schemas/
│   │   ├── actionItem.ts
│   │   ├── collectorState.ts
│   │   ├── executionDecision.ts
│   │   └── validate.ts
│   └── config.ts
├── skills/
│   └── keryx/
│       ├── DESCRIPTION.md
│       ├── keryx-worker/
│       │   └── SKILL.md
│       ├── keryx-collector/
│       │   └── SKILL.md
│       └── keryx-collector-creator/
│           └── SKILL.md
├── collectors/
│   ├── README.md
│   ├── bash-first-template/
│   │   ├── keryx-example-scan.sh
│   │   ├── cron-prompt.md
│   │   └── state.example.json
│   └── direct-agent-template/
│       └── cron-prompt.md
├── deploy/
│   ├── systemd/
│   │   └── keryx.service.example
│   └── caddy/
│       └── Caddyfile.example
├── docs/
│   ├── architecture.md
│   ├── collector-authoring.md
│   ├── security.md
│   └── operations.md
└── tests/
    ├── unit/
    ├── integration/
    └── e2e/
```

---

## Task 1: Bootstrap the TypeScript project and test harness

**Objective:** Create the Node/Svelte/Fastify project skeleton with runnable scripts and a first failing-then-passing smoke test.

**Files:**
- Create: `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `svelte.config.js`
- Create: `src/web/main.ts`, `src/web/App.svelte`, `src/web/styles.css`
- Create: `src/server/app.ts`, `src/server/index.ts`
- Create: `tests/unit/smoke.test.ts`

**Steps:**
1. Load/use `test-driven-development`.
2. Write `tests/unit/smoke.test.ts` expecting a trivial exported function such as `createAppName()` to return `Keryx`.
3. Run `npm test -- --run tests/unit/smoke.test.ts` and verify RED.
4. Install minimal dependencies: TypeScript, Svelte, Vite, Fastify, Vitest, Playwright, AJV, CLI helpers if needed.
5. Add minimal source code to satisfy the smoke test and start a Fastify server.
6. Add package scripts:
   - `npm start` starts the local web server on `127.0.0.1`.
   - `npm run build` builds client and server artefacts.
   - `npm test` runs Vitest.
   - `npm run lint` runs a cheap static check.
   - `npm run typecheck` runs TypeScript checks.
   - `npm run e2e` runs Playwright tests.
7. Run `npm test`, `npm run typecheck`, and `npm run build`.
8. Commit: `chore: bootstrap keryx web project`.

**Verification:** `npm test`, `npm run typecheck`, and `npm run build` pass from the repository root.

---

## Task 2: Add schemas, shared TypeScript types, and validation helpers

**Objective:** Implement formal schemas for Keryx cards, execution decisions, and collector state.

**Files:**
- Create: `schemas/action-item.v1.schema.json`
- Create: `schemas/execution-decision.v1.schema.json`
- Create: `schemas/collector-state.v1.schema.json`
- Create: `src/schemas/actionItem.ts`, `src/schemas/executionDecision.ts`, `src/schemas/collectorState.ts`, `src/schemas/validate.ts`
- Create: `tests/unit/schema-validation.test.ts`

**Steps:**
1. Load/use `test-driven-development`.
2. Write failing schema tests for:
   - valid PRD-style action item;
   - missing required field;
   - invalid `autonomy`;
   - invalid option without `execution_prompt`;
   - valid execution decision comment;
   - valid collector state without raw source content.
3. Run the targeted tests and verify RED.
4. Implement JSON schemas matching `docs/archive/v001/PRD.md` sections 5, 7.3, and 6.3.
5. Implement typed validation helpers that return `{ ok: true, value }` or `{ ok: false, errors }`.
6. Keep malformed cards visible to callers by returning validation errors, not throwing opaque exceptions.
7. Run `npm test -- --run tests/unit/schema-validation.test.ts`, then `npm test`.
8. Commit: `feat: add keryx schemas and validators`.

**Verification:** Schema tests prove valid examples pass and malformed examples produce useful messages.

---

## Task 3: Add configuration loading and the Hermes CLI adapter

**Objective:** Centralise Keryx config and Hermes command execution behind a testable adapter.

**Files:**
- Create: `keryx.config.example.json`
- Create: `src/config.ts`
- Create: `src/hermes/adapter.ts`, `src/hermes/types.ts`, `src/hermes/fakeHermes.ts`
- Create: `tests/unit/config.test.ts`, `tests/unit/hermes-adapter.test.ts`

**Steps:**
1. Load/use `test-driven-development`.
2. Write failing tests for default config, config-file override, `HERMES_HOME` isolation, and Hermes command construction.
3. Verify RED.
4. Implement config fields: `board`, `pollIntervalMs`, `defaultAssignee`, `defaultDeliveryTarget`, `localOnly`, `hermesBin`, `host`, `port`.
5. Implement a Hermes adapter that accepts an injected runner function for tests and executes only allowlisted command shapes.
6. Add parsing helpers for Hermes Kanban JSON and `hermes send --list --json` output.
7. Ensure tests never call the user's real Hermes CLI unless explicitly marked as manual.
8. Run targeted tests and full `npm test`.
9. Commit: `feat: add config and hermes adapter`.

**Verification:** Tests show command construction is centralised and can be mocked.

---

## Task 4: Implement read-only `opsctl` commands

**Objective:** Provide `opsctl` commands for doctor, list, show, cron status, delivery targets, and card validation.

**Files:**
- Create: `bin/opsctl`
- Create/modify: `src/opsctl/cli.ts`, `src/opsctl/commands.ts`, `src/opsctl/output.ts`
- Create: `tests/unit/opsctl-readonly.test.ts`
- Create: `tests/integration/opsctl-cli.test.ts`

**Steps:**
1. Load/use `test-driven-development`.
2. Write failing tests for:
   - `opsctl validate-card <file>` returns success for valid JSON;
   - invalid JSON returns non-zero with validation messages;
   - `opsctl list --status blocked` wraps `hermes kanban --board keryx list --json`;
   - `opsctl show <task_id>` wraps `show` and validates the body;
   - `opsctl cron-status` summarises `keryx-*` cron jobs;
   - `opsctl delivery-targets --json` wraps `hermes send --list --json`;
   - `opsctl doctor` emits OK/WARN/FAIL lines.
3. Verify RED.
4. Implement CLI argument parsing and JSON/text output.
5. Make `bin/opsctl` executable and point it at the built/tsx entrypoint.
6. Run targeted tests, `npm test`, and `./bin/opsctl --help`.
7. Commit: `feat: add readonly opsctl commands`.

**Verification:** `opsctl` can validate fixture cards and mocked Hermes calls without touching real Hermes state.

---

## Task 5: Implement mutating `opsctl execute` and `opsctl dismiss`

**Objective:** Add safe, idempotent UI mutations through `opsctl` only.

**Files:**
- Modify: `src/opsctl/commands.ts`
- Modify: `src/hermes/adapter.ts`
- Create: `tests/unit/opsctl-execute.test.ts`, `tests/unit/opsctl-dismiss.test.ts`

**Steps:**
1. Load/use `test-driven-development`.
2. Write failing tests for `execute`:
   - `blocked` -> append `keryx.execution_decision.v1` comment, promote, optionally dispatch;
   - `todo` -> comment and promote;
   - `ready`, `running`, `done` -> idempotent success without duplicate mutation;
   - invalid option ID -> clear error;
   - malformed body -> clear error.
3. Write failing tests for `dismiss`:
   - append dismissal comment;
   - archive the card;
   - record exact dismiss metadata through a mocked collector-state writer if implemented;
   - already archived/done cases are handled explicitly.
4. Verify RED.
5. Implement execution decision comment JSON exactly as `keryx.execution_decision.v1`.
6. Implement dismiss comment JSON and exact-item semantics only; do not add fuzzy/global dismiss rules.
7. Ensure no direct Kanban DB writes are introduced.
8. Run targeted tests and full `npm test`.
9. Commit: `feat: add safe opsctl mutations`.

**Verification:** Double-click/idempotency tests pass and command logs show no direct DB writes.

---

## Task 6: Implement the Fastify API

**Objective:** Expose a narrow HTTP API used by the Svelte UI.

**Files:**
- Modify: `src/server/app.ts`, `src/server/routes.ts`, `src/server/index.ts`
- Create: `tests/unit/server-routes.test.ts`, `tests/integration/server-api.test.ts`

**Steps:**
1. Load/use `test-driven-development`.
2. Write failing tests for:
   - `GET /api/health`;
   - `GET /api/tasks` returns parsed cards plus malformed-card errors;
   - `GET /api/sources` returns cron/source health;
   - `POST /api/tasks/:id/execute` validates selected option and feedback;
   - `POST /api/tasks/:id/dismiss` validates reason;
   - API routes call shared `opsctl`/adapter logic rather than constructing Hermes commands inline.
3. Verify RED.
4. Implement Fastify routes with dependency injection for the Hermes adapter.
5. Return concise structured errors suitable for display.
6. Add polling-friendly cache headers if useful, but no WebSockets/SSE in V1.
7. Run targeted tests and `npm test`.
8. Commit: `feat: add keryx server api`.

**Verification:** Integration tests exercise the API with a fake Hermes adapter.

---

## Task 7: Build the Svelte action-inbox UI

**Objective:** Build the responsive user-facing web UI for viewing, filtering, executing, and dismissing Keryx cards.

**Files:**
- Modify: `src/web/App.svelte`, `src/web/main.ts`, `src/web/styles.css`
- Create/modify: `src/web/lib/api.ts`, `src/web/lib/filters.ts`, `src/web/lib/taskView.ts`
- Create: `tests/unit/task-view.test.ts`
- Create: `tests/e2e/inbox.spec.ts`

**Steps:**
1. Load/use `test-driven-development`.
2. Write failing unit tests for view mapping: status labels, urgency/deadline sorting, malformed-card display, primary option selection.
3. Write a failing Playwright test that loads the UI against a mocked API and sees:
   - source status strip;
   - Inbox / Running / Completed / Dismissed views;
   - source and autonomy filters;
   - task title, summary, risk, origin, status, options, feedback input;
   - Execute and Dismiss controls;
   - malformed card warning.
4. Verify RED.
5. Implement the UI with 30-second polling and manual refresh.
6. Wire Execute/Dismiss actions to the API and update local state after response.
7. Keep the UI compact and readable; no built-in authentication in V1.
8. Run unit tests, Playwright e2e, `npm run build`.
9. Commit: `feat: build keryx action inbox ui`.

**Verification:** Playwright proves the core action flow renders and calls the expected API endpoints.

---

## Task 8: Write the bundled Keryx skills

**Objective:** Ship the `keryx` skill category and three reusable skills without installing them locally.

**Files:**
- Create: `skills/keryx/DESCRIPTION.md`
- Create: `skills/keryx/keryx-worker/SKILL.md`
- Create: `skills/keryx/keryx-collector/SKILL.md`
- Create: `skills/keryx/keryx-collector-creator/SKILL.md`
- Create: `tests/unit/skills.test.ts`

**Steps:**
1. Load/use `skill-creator` before writing any skill file.
2. Keep each `SKILL.md` concise and self-contained.
3. Write failing tests that assert:
   - required skill files exist;
   - frontmatter contains only useful `name` and `description` fields where appropriate;
   - no individual skill directory contains extraneous README/CHANGELOG files;
   - the category `DESCRIPTION.md` exists;
   - critical phrases from `docs/archive/v001/PRD.md` are present: untrusted source content, `keryx.action_item.v1`, trusted execution decision, blocked card creation, cursor safety.
4. Verify RED.
5. Write `keryx-worker` for execution: parse JSON, validate schema, find latest trusted execution decision comment, treat source strings as untrusted, execute selected option, re-query source systems where needed, complete/block with concise metadata.
6. Write `keryx-collector` for collector cron jobs: classify only actionable items, create blocked cards on board `keryx`, attach `--skill keryx-worker`, use stable idempotency keys, avoid raw source persistence, advance cursors only after handling.
7. Write `keryx-collector-creator` for authoring new collectors: choose bash-first vs direct-agent pattern, define cursor/idempotency semantics, create templates, recommend tests/dry-runs.
8. Run skill tests and full `npm test`.
9. Commit: `feat: add bundled keryx skills`.

**Verification:** Skill files validate structurally and contain the safety contracts from the PRD.

---

## Task 9: Add collector templates and supporting docs

**Objective:** Provide cloneable collector templates and operator documentation.

**Files:**
- Create: `collectors/README.md`
- Create: `collectors/bash-first-template/keryx-example-scan.sh`
- Create: `collectors/bash-first-template/cron-prompt.md`
- Create: `collectors/bash-first-template/state.example.json`
- Create: `collectors/direct-agent-template/cron-prompt.md`
- Create: `docs/architecture.md`, `docs/collector-authoring.md`, `docs/security.md`, `docs/operations.md`
- Create: `deploy/systemd/keryx.service.example`, `deploy/caddy/Caddyfile.example`
- Create: `tests/unit/templates-and-docs.test.ts`

**Steps:**
1. Load/use `test-driven-development` for tests around scripts/templates.
2. Write failing tests that assert templates and docs exist, executable bits are correct where needed, and no user-specific IDs/private paths are hard-coded.
3. Verify RED.
4. Implement the bash-first template so it demonstrates state reading and prints `{"wakeAgent": false}` when there is no work.
5. Implement direct-agent prompt template with the PRD collector safety contract.
6. Write docs from the PRD: architecture, collector authoring, security, operations.
7. Add deployment examples only; do not configure hosting on this machine.
8. Run targeted tests and `npm test`.
9. Commit: `docs: add collector templates and operations docs`.

**Verification:** Tests confirm the cloneable support files exist and avoid private configuration.

---

## Task 10: Implement the installer script and doctor checks

**Objective:** Add an idempotent `keryx-setup.sh` and complete `opsctl doctor` coverage.

**Files:**
- Create: `keryx-setup.sh`
- Modify: `src/opsctl/commands.ts`
- Create: `tests/integration/setup-script.test.ts`
- Modify: `keryx.config.example.json`

**Steps:**
1. Load/use `test-driven-development`.
2. Write failing tests using a temporary `HERMES_HOME` and fake `hermes` binary for:
   - `--dry-run` prints intended actions and writes nothing;
   - `--hermes-home <tmp>` uses the supplied home;
   - `--force` overwrites existing installed Keryx skill files;
   - without `--force`, existing skill files are preserved;
   - `--delivery-target <target>` writes config;
   - `--local-only` writes `localOnly: true` and `defaultDeliveryTarget: null`;
   - script does not create collector cron jobs.
3. Verify RED.
4. Implement `keryx-setup.sh`:
   - locate Hermes home;
   - verify `hermes` CLI;
   - create board `keryx` if missing;
   - copy `skills/keryx/` into `$HERMES_HOME/skills/keryx/`;
   - discover delivery targets through `hermes send --list --json`;
   - write Keryx config;
   - run `./bin/opsctl doctor` at the end.
5. Ensure implementation tests run against fake Hermes/temp home only; do not run real local installation.
6. Run targeted tests, `npm test`, and `./keryx-setup.sh --dry-run`.
7. Commit: `feat: add keryx setup script`.

**Verification:** Installer tests prove idempotency and no accidental local profile mutation.

---

## Task 11: Create the user-facing README

**Objective:** Write a clear README for fresh users cloning Keryx.

**Files:**
- Create: `README.md`
- Create/modify: `tests/unit/readme.test.ts`

**Steps:**
1. Write a failing test that checks README contains the essential commands and warnings.
2. Verify RED.
3. Write `README.md` for users, including:
   - what Keryx is;
   - requirements;
   - `git clone`, `npm install`, `./keryx-setup.sh`, `npm start`;
   - `./bin/opsctl doctor`;
   - how setup installs skills into `$HERMES_HOME/skills/keryx/`;
   - how delivery-target selection works;
   - local-only mode;
   - how to author a collector;
   - safe reverse-proxy exposure;
   - troubleshooting.
4. Run README test and full `npm test`.
5. Commit: `docs: add user-facing readme`.

**Verification:** README gives a fresh user enough information to install, run, diagnose, and avoid unsafe exposure.

---

## Task 12: Full integration verification and polish

**Objective:** Run the complete verification suite, fix defects, and leave the repository in a clean, committed state.

**Files:**
- Modify as needed based on verification failures.
- Create/modify: `tests/e2e/full-flow.spec.ts` if not already covered.

**Steps:**
1. Load/use `test-driven-development` for any behavioural defects found: reproduce each with a failing test before fixing.
2. Run:
   - `npm test`
   - `npm run typecheck`
   - `npm run lint`
   - `npm run build`
   - `npm run e2e`
   - `./bin/opsctl doctor` with fake/test configuration if real Hermes state would be mutated
   - `./keryx-setup.sh --dry-run`
3. If any command fails, fix with TDD and rerun the failed command plus the full relevant suite.
4. Confirm `git status --short` is clean after the final commit.
5. Commit any verification fixes: `fix: polish keryx mvp verification`.

**Verification:** The repository builds, tests, dry-runs setup, and has no uncommitted changes.

---

## Task 13: Send final build overview via configured delivery target

**Objective:** Notify the user through the configured delivery target with a complete, factual overview of the work completed.

**Files:**
- No required file changes.

**Steps:**
1. Inspect `git log --oneline --decorate -20`, `git status --short`, and the latest test/build outputs from Task 12.
2. Prepare a concise delivery message covering:
   - what was built;
   - important commands that passed;
   - any known caveats or unfinished items;
   - whether skills were bundled only or installed locally;
   - how to run Keryx locally;
   - where the repository is.
3. Send the message through the configured default delivery target. If using Hermes tools, use the resolved target from delivery discovery rather than a hard-coded platform. If using the CLI, use the Hermes send command only if available and configured.
4. Complete the Kanban task with the exact message sent and any delivery result/status.

**Verification:** The user receives a delivery overview after all build and verification tasks complete.
