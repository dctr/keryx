# Keryx v002 Product Requirements Document: Hermes Plugin Migration

**Date:** 2026-06-11  
**Project path:** repository root (`.`)  
**Status:** Planning specification only. This document describes the repository migration work required to make Keryx a Hermes Agent plugin. It is not an implementation record.

## 1. Summary

Keryx is currently a Node 22+ TypeScript/Svelte/Fastify control surface over Hermes Kanban. It is intentionally thin: Hermes Kanban remains the source of truth for action items, Hermes cron remains responsible for scheduling collectors, Hermes workers remain responsible for execution, and Keryx provides a stricter action-item schema, an `opsctl` wrapper, a local API, a Svelte inbox UI, bundled skills, and collector templates.

The current repository already contains the core pieces needed for a plugin-backed architecture:

- `bin/opsctl` — the Keryx command wrapper;
- `schemas/*.json` — canonical JSON Schema contracts for Keryx action items, execution decisions, and collector state;
- `skills/keryx/*/SKILL.md` — Keryx worker and collector skills;
- `keryx.config.json` / `keryx.config.example.json` — repo-local runtime configuration;
- `keryx-setup.sh` — setup script that currently ensures the `keryx` Kanban board, copies bundled skills into `$HERMES_HOME/skills/keryx/`, writes local config, and runs `./bin/opsctl doctor`;
- `src/config.ts`, `src/opsctl/`, `src/hermes/`, and tests — Keryx runtime, CLI, Hermes adapter, and validation logic.

The v002 goal is to turn the Hermes-facing part of Keryx into a first-class Hermes plugin. Keryx-specific files should stay in the Keryx repository wherever possible. Hermes should receive only plugin registration/enablement and any minimal scheduler trampoline files required by Hermes runtime constraints. In particular, Keryx skills should no longer be copied into `$HERMES_HOME/skills/keryx/`; they should be registered from the repository by the plugin.

## 2. Goals

### 2.1 Product and operational goals

- Make Keryx installable into Hermes as a general plugin named `keryx`.
- Register Keryx CLI commands through Hermes' plugin API using `ctx.register_cli_command`.
- Register bundled Keryx skills through Hermes' plugin API using `ctx.register_skill`.
- Keep Keryx JSON schemas shipped as repository data files and use them as the canonical validation contracts.
- Keep Keryx runtime configuration repo-local, with `keryx.config.json` remaining the normal runtime config file and `KERYX_CONFIG` remaining an optional process override.
- Remove skill-copy drift by making the repo skill files the source of truth loaded by Hermes as plugin-qualified skills.
- Update setup, docs, tests, and in-repo skills so future collectors and cards attach Keryx skills using plugin-qualified names.
- Preserve Keryx's thin-control-surface architecture: no second task database, no bypass of Hermes Kanban, no new execution framework.
- Preserve local-only default posture for the Keryx web server.

### 2.2 Developer experience goals

- After setup, repository updates should update plugin code, schemas, and skills by updating the repo, not by manually syncing copied files.
- `bin/opsctl` and plugin-registered CLI commands should work regardless of the caller's current working directory.
- Setup dry-runs should clearly describe plugin installation and enablement without mutating Hermes or creating cron jobs.
- Tests must use fake Hermes binaries/temp Hermes homes and must not mutate a developer's real Hermes installation.

### 2.3 Non-goals

- Do not introduce a concrete source collector as part of the plugin migration.
- Do not create or schedule real Hermes cron jobs as part of setup.
- Do not migrate any one local Hermes installation, existing cron job, or existing personal collector.
- Do not add Keryx-specific secrets or API keys.
- Do not expose the Keryx web server beyond localhost or add built-in authentication in this migration.
- Do not replace Hermes Kanban, Hermes cron, Hermes gateway delivery, or Hermes worker dispatch.
- Do not rely on project-local Hermes plugins that require `HERMES_ENABLE_PROJECT_PLUGINS=true`; setup should install/enable Keryx as a normal user/plugin-home plugin for the chosen Hermes home.

## 3. Current architecture and constraints

### 3.1 Current repository model

The repository currently treats Keryx as an external application that integrates with Hermes through CLI calls and copied skills.

Current setup behaviour:

1. Resolve a target Hermes home from `--hermes-home`, `HERMES_HOME`, or default `~/.hermes`.
2. Check that the Hermes CLI is available.
3. Ensure the Hermes Kanban board `keryx` exists.
4. Copy `skills/keryx/` into `$HERMES_HOME/skills/keryx/`, preserving existing files unless `--force` is supplied.
5. Discover delivery targets through `hermes send --list --json`.
6. Write `keryx.config.json`.
7. Run `./bin/opsctl doctor`.

This works, but creates avoidable drift:

- installed skill copies can become stale after repository updates;
- agents need to know whether to use copied skill names or repo files;
- `opsctl` is discoverable only by knowing the Keryx repo path or running from the repo;
- schemas are canonical in the repo, but collector helpers may be tempted to duplicate validation if they cannot discover the repo path;
- setup semantics are split between a Keryx repo and a Hermes skills tree.

### 3.2 Hermes plugin capabilities relevant to Keryx

Hermes general plugins can be installed under a Hermes home plugin directory and enabled through Hermes plugin configuration. A plugin's `register(ctx)` function can use:

- `ctx.register_cli_command(name, help, setup_fn, handler_fn, description=...)` to add a top-level `hermes <name>` CLI command;
- `ctx.register_skill(name, path, description=...)` to expose read-only plugin skills;
- plugin data files via paths relative to `__file__`, e.g. `Path(__file__).parent / "data" / "..."` or, for Keryx, paths relative to the plugin directory and repository root.

Plugin-registered skills are loaded by qualified name:

```text
<plugin-name>:<skill-name>
```

For Keryx, the plugin name should be `keryx`, so the bundled skills become:

```text
keryx:keryx-worker
keryx:keryx-collector
keryx:keryx-collector-creator
```

A significant consequence: plugin skills are explicit loads. Repository docs, collector templates, setup output, cron examples, and task creation guidance must use the qualified plugin skill names. They must not instruct new cards or cron jobs to attach unqualified `keryx-worker`, `keryx-collector`, or `keryx-collector-creator` once the migration is complete.

### 3.3 Configuration boundary

Keryx runtime configuration should remain in the repository root:

```text
keryx.config.json
```

This file remains gitignored local runtime config. `keryx.config.example.json` remains the tracked example.

Do not use Hermes' `.env` as a Keryx root locator. `.env` is for secrets and credential-like values. The plugin installation path itself becomes the locator: plugin code can infer the Keryx repository root from `__file__` and set `KERYX_CONFIG` when delegating to `bin/opsctl`.

Process overrides remain acceptable:

```text
KERYX_CONFIG=/path/to/keryx.config.json
HERMES_HOME=/path/to/hermes-home
HERMES_BIN=/path/to/hermes
```

But they should not be the default persistent discovery mechanism.

## 4. Target architecture

### 4.1 Repository layout

Add a Hermes plugin directory to the Keryx repository, for example:

```text
hermes-plugin/
  plugin.yaml
  __init__.py
  README.md                    # optional plugin-specific notes
```

The plugin directory should be the Hermes-facing adapter. It should not duplicate Keryx schemas, skills, or TypeScript implementation. Instead, it should resolve the Keryx repository root and point to existing repository files:

```text
repository root
  bin/opsctl
  keryx.config.json
  schemas/action-item.v1.schema.json
  schemas/execution-decision.v1.schema.json
  schemas/collector-state.v1.schema.json
  skills/keryx/keryx-worker/SKILL.md
  skills/keryx/keryx-collector/SKILL.md
  skills/keryx/keryx-collector-creator/SKILL.md
  collectors/
  hermes-plugin/plugin.yaml
  hermes-plugin/__init__.py
```

### 4.2 Plugin installation model

`keryx-setup.sh` should install the plugin into the selected Hermes home by symlink where possible:

```text
$HERMES_HOME/plugins/keryx -> <repo>/hermes-plugin
```

Symlink installation is preferred because it keeps plugin code and registered skill paths tied to the repository checkout. Updating the repository updates the plugin and skills after Hermes restart/reload.

If symlink creation is unavailable on a supported platform, setup may fall back to copying the small plugin adapter directory only. It must still not copy `skills/keryx/` into `$HERMES_HOME/skills/keryx/`.

Setup must enable the plugin through Hermes plugin configuration, e.g. through the Hermes plugin CLI. The exact command can be implementation-defined, but the setup script and tests should assert that setup enables the `keryx` plugin for the selected Hermes home.

### 4.3 Plugin CLI command

Register a top-level Hermes CLI command:

```text
hermes keryx ...
```

The plugin command should route to the existing Keryx command surface rather than reimplementing Keryx logic in Python.

Recommended user-facing aliases:

```sh
hermes keryx doctor
hermes keryx list --status blocked
hermes keryx show <task_id>
hermes keryx cron-status
hermes keryx delivery-targets
hermes keryx schema action-item
hermes keryx schema execution-decision
hermes keryx schema collector-state
hermes keryx template-card [--source <source>] [--collector <collector>]
hermes keryx validate-card <card.json>
hermes keryx validate-state <collector-state.json>
hermes keryx create-card <card.json>
hermes keryx execute <task_id> --option <option_id> [--feedback <text>] [--dispatch]
hermes keryx dismiss <task_id> [--reason <text>]
```

Implementation approach:

- `hermes-plugin/__init__.py` registers `ctx.register_cli_command(name="keryx", ...)`.
- The CLI handler delegates to `<repo>/bin/opsctl` with the remaining arguments.
- The handler sets `KERYX_CONFIG` to `<repo>/keryx.config.json` by default unless the caller already supplied `KERYX_CONFIG`.
- The handler preserves `HERMES_HOME` from the calling Hermes process so `opsctl` targets the same selected Hermes home.
- The handler exits with the same status code as `bin/opsctl` and passes through stdout/stderr.

### 4.4 `bin/opsctl` path independence

`bin/opsctl` currently resolves the repository root from its own path, but config loading inside Keryx defaults to `process.cwd()/keryx.config.json` unless `KERYX_CONFIG` is set.

After migration, `bin/opsctl` should be safe to invoke from any current working directory.

Acceptance behaviour:

- Running `<repo>/bin/opsctl doctor` from outside the repository should use `<repo>/keryx.config.json` by default if `KERYX_CONFIG` is not already set.
- Running `hermes keryx doctor` should use the repository's `keryx.config.json` by default.
- An explicit `KERYX_CONFIG` must still override the default.

Preferred implementation:

```sh
KERYX_CONFIG=${KERYX_CONFIG:-"$ROOT_DIR/keryx.config.json"}
export KERYX_CONFIG
```

inside `bin/opsctl`, before executing the built or source TypeScript entrypoint.

### 4.5 Plugin skill registration

The plugin should register the existing repository skill files:

```python
ctx.register_skill(
    "keryx-worker",
    KERYX_ROOT / "skills" / "keryx" / "keryx-worker" / "SKILL.md",
    description="Execute approved Keryx action-item cards safely.",
)
```

Likewise for:

- `keryx-collector`;
- `keryx-collector-creator`;
- any future source-specific Keryx collector skills stored in the repository.

Skill source of truth remains `skills/keryx/.../SKILL.md` inside the repository. Setup must not copy these files into `$HERMES_HOME/skills/keryx/`.

### 4.6 Qualified skill names in cards and cron jobs

After migration, Keryx documentation, templates, and examples must attach plugin-qualified skills.

Examples:

```sh
hermes kanban --board keryx create \
  --initial-status blocked \
  --skill keryx:keryx-worker \
  --idempotency-key keryx:source:item-123 \
  "Handle source item 123"
```

Cron examples should use:

```json
{
  "skills": ["keryx:keryx-collector", "keryx:keryx-collector-creator"]
}
```

Source-specific collector examples should use:

```json
{
  "skills": ["keryx:keryx-collector-<source>", "keryx:keryx-collector"]
}
```

If a source-specific skill is not shipped by the core Keryx repository, its packaging must define whether it is a Keryx plugin skill, a normal Hermes user skill, or part of another plugin. The docs must avoid ambiguous unqualified skill names where a plugin-qualified name is required.

### 4.7 Schemas and templates as plugin/repository data

The canonical schemas remain:

```text
schemas/action-item.v1.schema.json
schemas/execution-decision.v1.schema.json
schemas/collector-state.v1.schema.json
```

Requirements:

- `hermes keryx schema action-item` prints the canonical `schemas/action-item.v1.schema.json` content.
- `hermes keryx schema execution-decision` prints the canonical `schemas/execution-decision.v1.schema.json` content.
- `hermes keryx schema collector-state` prints the canonical `schemas/collector-state.v1.schema.json` content.
- `hermes keryx template-card` prints a valid minimal `keryx.action_item.v1` JSON template derived from the current action-item schema and Keryx defaults.
- `hermes keryx validate-card` validates against `schemas/action-item.v1.schema.json`.
- `hermes keryx validate-state` validates against `schemas/collector-state.v1.schema.json`.
- Any future collector helper that creates cards should call Keryx validation through `opsctl`/`hermes keryx` or import/use the repository schemas directly. It must not embed a divergent hand-copied schema.
- Plugin data access should be relative to the plugin/repository path, not to the caller's cwd.

### 4.8 Required collector card-creation surface

The plugin migration does not require adding concrete collectors, but it must provide a clear and deterministic card-creation path for collector authors and collector agents.

Required `hermes keryx`/`opsctl` commands:

```sh
hermes keryx schema action-item
hermes keryx template-card [--source <source>] [--collector <collector>]
hermes keryx validate-card <card.json>
hermes keryx validate-state <collector-state.json>
hermes keryx create-card <card.json>
```

Collector skills should describe the process for creating cards, not duplicate the schema or embed a card template. When a collector agent needs to create a card, it should:

1. Run `hermes keryx template-card --source <source> --collector <collector>` to obtain the current canonical template.
2. Fill source-specific values from compact candidate facts.
3. If unsure about fields, enum values, or optional structures, run `hermes keryx schema action-item`.
4. Write the proposed card body to a temporary JSON file.
5. Run `hermes keryx validate-card <card.json>`.
6. Fix validation errors, if any, and revalidate.
7. Run `hermes keryx create-card <card.json>`.

`create-card` centralises:

- schema validation;
- board selection;
- `initial-status blocked`;
- `--skill keryx:keryx-worker`;
- `created_by` from card `collector`;
- tenant/source from card `source`;
- assignee from Keryx config;
- idempotency key from card `idempotency_key`.

Collectors and collector agents should not call raw `hermes kanban create` directly unless `create-card` is unavailable and an operator explicitly approves the fallback. This keeps card creation policy in Keryx rather than in each collector prompt or helper.

## 5. Required repository changes

### 5.1 Add Hermes plugin files

Create:

```text
hermes-plugin/plugin.yaml
hermes-plugin/__init__.py
```

`plugin.yaml` should include at least:

```yaml
name: keryx
version: "0.2.0"
description: Keryx action inbox integration for Hermes Kanban
```

`__init__.py` should:

- resolve the plugin directory;
- resolve the Keryx repository root;
- register the `hermes keryx` CLI command;
- register the bundled Keryx skills by repository path;
- fail clearly if expected repository files are missing;
- avoid importing heavy Node/TypeScript dependencies during plugin discovery;
- avoid registering LLM tools unless a separate explicit product requirement appears.

The initial plugin should not add model tools to the default tool schema. Keryx's existing interaction surface is CLI, web UI, schemas, and skills; exposing Keryx as a model tool should be a separate decision because it changes the model tool surface.

### 5.2 Update setup script

Modify `keryx-setup.sh`:

Remove or replace:

- copying `skills/keryx/` into `$HERMES_HOME/skills/keryx/` as the primary installation path;
- `--force` semantics that exist solely for overwriting copied skill files.

Add:

- plugin installation into `$HERMES_HOME/plugins/keryx` by symlink where possible;
- fallback copy of only the small plugin adapter directory when symlink is unavailable;
- plugin enablement for the selected Hermes home;
- dry-run messages for plugin installation and enablement;
- clear handling when `$HERMES_HOME/plugins/keryx` already exists:
  - if it points to the current repo plugin path: OK;
  - if it points elsewhere: preserve and fail/warn unless `--force` is supplied;
  - if it is a regular directory: preserve and fail/warn unless `--force` is supplied;
- final health check through `hermes keryx doctor` after plugin enablement, or through `bin/opsctl doctor` only if plugin CLI discovery cannot be available until the next process.

Preserve:

- Hermes CLI availability check;
- board creation/ensure logic;
- delivery-target discovery;
- repo-local `keryx.config.json` writing;
- local-only fallback in non-interactive mode;
- no real collector cron job creation.

### 5.3 Update Keryx config handling

Modify `bin/opsctl` and/or config resolution so `opsctl` works outside the repo cwd.

Minimum change:

- Set default `KERYX_CONFIG` inside `bin/opsctl` to `$ROOT_DIR/keryx.config.json` if not already set.

Optional TypeScript improvement:

- Add a `repoRoot`/`defaultConfigPath` concept to `src/config.ts` so command code can resolve default config by module/repo root rather than cwd.

Acceptance:

- `bin/opsctl doctor` from repository root still works.
- `<absolute repo>/bin/opsctl doctor` from another directory works.
- `KERYX_CONFIG=/tmp/custom.json <repo>/bin/opsctl doctor` uses the explicit config.

### 5.4 Update in-repo documentation

Update `README.md`:

- Describe Keryx as shipping a Hermes plugin.
- Update setup script steps:
  - ensure Hermes CLI;
  - ensure board;
  - install/enable plugin;
  - discover delivery targets;
  - write `keryx.config.json`;
  - run health check.
- Remove the claim that setup installs bundled skills into `$HERMES_HOME/skills/keryx/`.
- Document plugin-qualified skill names.
- Document that collector agents retrieve the current card template and schema through `hermes keryx template-card` and `hermes keryx schema action-item`, not by relying on duplicated schema text in skills.
- Update daily commands to include `hermes keryx ...` as the preferred path, while optionally noting `./bin/opsctl ...` as the direct repo command.
- Update troubleshooting from `FAIL skills: rerun setup; it should install skills under $HERMES_HOME/skills/keryx/` to plugin registration/enablement checks.
- Keep warnings that setup does not create real collector cron jobs.

Update `AGENTS.md`:

- Project map: note `hermes-plugin/` and plugin-registered skills.
- Commands: add `hermes keryx doctor` once the plugin exists; keep `./bin/opsctl doctor` for direct repo testing.
- Architecture rules: plugin is the Hermes-facing integration boundary; Keryx remains a thin control surface over Hermes Kanban.
- Collector rules: attach `keryx:keryx-worker`, not unqualified `keryx-worker`.
- Documentation rule: update plugin and skill-qualified naming when adding collector docs/templates.

Update `docs/collector-authoring.md`:

- Replace unqualified skill names with plugin-qualified skill names.
- Fix any schema-invalid examples. Current examples must use `autonomy` values allowed by `schemas/action-item.v1.schema.json`: `auto`, `minimal`, `research`, or `complex`.
- Clarify that plugin-registered skills are explicit qualified loads.
- Clarify that repository schemas and CLI-emitted templates are canonical and should not be copied into collector helpers or skills.
- Clarify the collector card-creation loop: `template-card`, fill values, `schema action-item` if uncertain, `validate-card`, then `create-card`.

Update `docs/architecture.md`, `docs/operations.md`, and `docs/security.md` if they mention copied skills, direct `opsctl` only, or unqualified skills.

### 5.5 Update bundled skills

Update all Keryx skills under `skills/keryx/` so their examples and instructions use plugin-qualified skill names.

Known repository skills:

```text
skills/keryx/keryx-worker/SKILL.md
skills/keryx/keryx-collector/SKILL.md
skills/keryx/keryx-collector-creator/SKILL.md
```

Expected changes:

- `keryx-collector` should instruct collectors/cards to attach `keryx:keryx-worker` after plugin migration.
- `keryx-collector-creator` should instruct cron jobs to attach `keryx:keryx-collector-<source>` and `keryx:keryx-collector` when source-specific skills are plugin-registered, and to attach `keryx:keryx-worker` to cards.
- `keryx-worker` should not assume it was loaded from `$HERMES_HOME/skills`; it should work as a plugin skill.
- Any examples that call `opsctl` should prefer `hermes keryx ...` or explicitly say `./bin/opsctl ...` is the repository-direct fallback.
- Collector skills must not embed full JSON schemas or hand-maintained action-card templates. They should instruct agents to call `hermes keryx template-card` and `hermes keryx schema action-item` instead.

### 5.6 Update tests

Add or update tests without touching a real Hermes home.

#### Plugin registration tests

Create tests that import the plugin module with a fake plugin context and assert:

- `register_cli_command` is called once with name `keryx`;
- `register_skill` is called for all bundled Keryx skills;
- registered skill paths exist and point into the repository;
- missing expected files fail clearly or produce a diagnostic result, depending on implementation choice;
- plugin registration does not run Node, npm, Hermes, or `opsctl` during discovery.

#### Setup script tests

Update `tests/integration/setup-script.test.ts`:

- dry-run says it would install/enable the Keryx plugin;
- setup creates/updates `$HERMES_HOME/plugins/keryx` in the temp Hermes home;
- setup enables the plugin through the fake Hermes CLI;
- setup no longer copies `skills/keryx/` into `$HERMES_HOME/skills/keryx/`;
- setup still does not create real collector cron jobs;
- `--force` behaviour is covered for an existing conflicting plugin path;
- local-only and delivery-target config behaviour remain covered.

#### CLI/config tests

Add tests that show:

- `bin/opsctl` defaults `KERYX_CONFIG` to repo-local config when invoked from a different cwd;
- explicit `KERYX_CONFIG` still wins;
- `hermes keryx ...` plugin command passes through args and exit status to `bin/opsctl`;
- `hermes keryx doctor` sets or preserves the expected environment.
- `hermes keryx schema action-item`, `schema execution-decision`, and `schema collector-state` return the canonical repository schema files.
- `hermes keryx template-card` returns JSON that validates against `schemas/action-item.v1.schema.json`.
- `hermes keryx create-card <card.json>` validates before creating and uses the central Keryx creation policy.

The plugin CLI tests can use a fake/substituted `opsctl` or test the Python handler directly with monkeypatched subprocess calls.

#### Documentation/contract tests

Add lightweight checks where appropriate:

- README no longer says setup copies skills into `$HERMES_HOME/skills/keryx/`.
- README/AGENTS/collector docs mention `keryx:keryx-worker` where card skill attachment is documented.
- `docs/collector-authoring.md` examples validate against `schemas/action-item.v1.schema.json`.
- Collector skills/docs do not embed full schema or static card templates; they point to `hermes keryx template-card` and `hermes keryx schema action-item`.

### 5.7 Update package/build behaviour if needed

The plugin adapter is Python while Keryx is a TypeScript/Node project. The plugin should remain lightweight and should not require a Python packaging step for local setup.

No npm build changes are required if:

- plugin code lives as plain Python under `hermes-plugin/`;
- setup symlinks/copies that directory into Hermes;
- `bin/opsctl` handles built vs source TypeScript execution as it does today.

If future distribution uses pip entry points or `hermes plugins install`, that can be a later packaging project. The v002 migration should keep local repository setup simple.

## 6. Security and side-effect requirements

- Plugin discovery must not mutate Hermes state beyond registration inside the running Hermes process.
- Setup may mutate only the selected Hermes home and only through explicit setup actions.
- Tests must not mutate a real Hermes home.
- Keryx must remain local-only by default (`127.0.0.1`, no built-in auth).
- Keryx must continue treating source content as untrusted.
- Plugin commands must not add a generic shell passthrough.
- Keryx must keep Hermes command execution allowlisted in `src/hermes/adapter.ts`.
- `opsctl execute` and `opsctl dismiss` remain the central mutation paths for Keryx UI decisions.
- Workers continue to act only from trusted `keryx.execution_decision.v1` comments.
- Plugin registration must not expose secrets, read unrelated user files, or inject prompt context.
- No new default LLM tool should be registered unless separately justified; every model-visible tool has prompt and capability cost.

## 7. Acceptance criteria

The migration is complete when all of the following are true:

1. The repository contains a Hermes plugin adapter with `plugin.yaml` and `__init__.py`.
2. `keryx-setup.sh --dry-run` reports plugin install/enable steps and no skill-copy step.
3. Real setup against a temp Hermes home installs/enables the plugin without creating collector cron jobs.
4. Setup does not copy `skills/keryx/` into `$HERMES_HOME/skills/keryx/`.
5. The plugin registers a `hermes keryx` CLI command.
6. The plugin registers all bundled Keryx skills from repository paths.
7. The documented skill names are plugin-qualified, e.g. `keryx:keryx-worker`.
8. `bin/opsctl` works from outside the repository cwd using repo-local config by default.
9. Explicit `KERYX_CONFIG` continues to override repo-local config.
10. `./bin/opsctl doctor` still works from the repo root.
11. `hermes keryx doctor` works after plugin enablement.
12. README, AGENTS, collector docs, operations docs, and bundled skills no longer instruct users/agents to attach unqualified Keryx skills after plugin migration.
13. JSON schema files in `schemas/` remain the canonical contracts for card, execution decision, and collector state validation.
14. `hermes keryx schema action-item`, `schema execution-decision`, and `schema collector-state` expose those canonical schema files.
15. `hermes keryx template-card` emits a card template generated from or validated against the current action-item schema.
16. `hermes keryx validate-card`, `validate-state`, and `create-card` enforce schema validation before accepting collector-created data.
17. Collector docs and skills instruct agents to retrieve the current template/schema through Keryx CLI commands rather than embedding full schemas or static templates.
18. Existing `opsctl` read/mutate commands continue to pass their current tests.
19. New plugin/setup tests pass without touching a real Hermes installation.
20. `npm run lint` and `npm test` pass.
21. `npm run typecheck` passes if any Svelte/shared types are touched.
22. `npm run build` passes if server/build/plugin packaging behaviour changes.

## 8. Suggested implementation phases

### Phase 1 — Plugin skeleton and path resolution

- Add `hermes-plugin/plugin.yaml`.
- Add `hermes-plugin/__init__.py` with repository-root discovery.
- Register bundled skills with fake context tests.
- Register a minimal `hermes keryx` CLI command that delegates to `bin/opsctl`.
- Ensure plugin registration is lightweight and has no side effects.

### Phase 2 — `opsctl` cwd independence

- Patch `bin/opsctl` to default `KERYX_CONFIG` to repo-local config.
- Add tests for cwd-independent invocation and explicit config override.
- Keep `./bin/opsctl ...` as the direct repo command.

### Phase 3 — Schema/template and card-creation commands

- Add `schema <action-item|execution-decision|collector-state>` commands.
- Add `template-card` command that emits a schema-valid minimal action-card template.
- Add `validate-state` command for collector state files.
- Add `create-card` command that validates, applies central Keryx card-creation policy, and creates a blocked Kanban card.
- Add tests proving schema/template outputs come from repository contracts and remain valid.

### Phase 4 — Setup migration

- Replace copied-skill installation with plugin symlink/copy installation.
- Enable the plugin for the selected Hermes home.
- Update dry-run output.
- Define `--force` semantics for existing plugin paths.
- Keep board ensure, delivery target discovery, repo-local config writing, and doctor checks.
- Update setup integration tests with fake Hermes.

### Phase 5 — Documentation and skill migration

- Update README.
- Update AGENTS.
- Update docs under `docs/` that reference setup, skills, collector authoring, operations, or direct commands.
- Update `skills/keryx/*/SKILL.md` to use qualified plugin skill names.
- Update collector skills to reference `hermes keryx template-card` and `hermes keryx schema action-item` instead of embedding schema/template text.
- Fix schema-invalid examples in collector docs.

### Phase 6 — Validation and polish

- Run targeted plugin/setup/opsctl tests.
- Run `npm run lint` and `npm test`.
- Run `npm run typecheck` if shared types/UI are touched.
- Run `npm run build` if build/server/plugin packaging changed.
- Run `./keryx-setup.sh --dry-run` and confirm output reflects plugin install/enablement.
- Run `./bin/opsctl doctor` in an environment where it is safe to inspect configured Hermes state, or use fake Hermes harnesses for automated tests.

## 9. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Plugin skills are not in the normal skill index | Agents may not discover them unless explicitly loaded | Use qualified names everywhere: `keryx:keryx-worker`, `keryx:keryx-collector`, etc. Update docs, templates, and tests. |
| Setup symlink conflicts with existing plugin path | Setup may overwrite user/plugin state | Preserve by default; require `--force` for conflicting paths; dry-run shows intended action. |
| `hermes keryx` is unavailable until plugin discovery after enablement/restart | Setup final doctor may fail immediately after enablement | Prefer a setup flow that invokes a fresh Hermes process after enablement; fall back to `bin/opsctl doctor` only if needed and document behaviour. |
| Python plugin wrapper accidentally reimplements TypeScript logic | Divergent behaviours | Keep wrapper thin; delegate to `bin/opsctl`; keep Keryx logic in TypeScript. |
| Config resolution changes break existing `KERYX_CONFIG` users | Existing overrides stop working | Explicit `KERYX_CONFIG` must remain highest precedence. Add tests. |
| Skills duplicate schema/template details | Skill instructions drift when schemas change | Skills must describe process only and point agents to `hermes keryx schema ...` and `hermes keryx template-card`. Add documentation/contract tests. |
| Docs retain unqualified skill names | New cards/cron jobs may fail to load plugin skills | Add documentation/contract tests for qualified names. |
| Plugin registration imports heavy dependencies | Hermes startup/plugin discovery slows down or fails without npm install | Plugin discovery should only register paths and CLI wrapper; `opsctl` execution may require npm/build as before. |
| Tests mutate a real Hermes home | Developer state damage | Use temp `HERMES_HOME`, fake Hermes binaries, and no real cron creation in tests. |

## 10. Open questions

1. Should setup always symlink the plugin, or should it support `--copy-plugin` for environments where symlinks are undesirable?
2. Should `hermes keryx` be a pure pass-through to `opsctl`, or should it expose curated subcommands with richer argparse help while still delegating implementation to `opsctl`?
3. Should setup remove legacy copied Keryx skills from `$HERMES_HOME/skills/keryx/` after successful plugin migration, or only warn about stale copies? This PRD does not require removal because deleting user-modified skill files is risky.
4. What minimum Hermes Agent version should README require after plugin migration? It must be a version that supports general plugins, `ctx.register_cli_command`, and `ctx.register_skill`.

## 11. Handoff notes for future implementation conversations

A future implementation agent should start by reading:

- this PRD;
- `AGENTS.md`;
- `README.md`;
- `keryx-setup.sh`;
- `src/config.ts`;
- `src/opsctl/commands.ts`;
- `src/hermes/adapter.ts`;
- `schemas/*.json`;
- `skills/keryx/*/SKILL.md`;
- `tests/integration/setup-script.test.ts`;
- `tests/unit/opsctl-readonly.test.ts`;
- `docs/collector-authoring.md`.

The implementation should proceed test-first where practical, especially for plugin registration, setup-script behaviour, and cwd-independent `opsctl` config resolution.
