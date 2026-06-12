# Keryx v004 PLAN — user-facing collector creator skill

**Date:** 2026-06-13
**Source:** Live installation and operator-session debugging after Keryx was installed as a Hermes plugin. David confirmed the Keryx process was already running via a user-level systemd unit, but the Hermes plugin installation had not previously been done.

Execution constraints for all tasks:

- Keep Keryx a thin control surface over Hermes Kanban; do not add a second task database or bypass Kanban.
- Do not make `keryx-worker` or `keryx-collector` visible as ordinary user-facing skills. They are runtime skills for Kanban cards and cron jobs.
- Preserve repository-backed plugin skills as the source of truth. Avoid copied skill content that can drift from the repository.
- Tests must use fake Hermes homes, fake plugin installs, or temp fixtures. Do not create real cron jobs, mutate the real `keryx` board, or depend on David's live Hermes home in tests.
- Before committing implementation, run at least the targeted tests, `npm run lint`, and `npm test`. Run `npm run typecheck` if touching Svelte/shared types and `npm run build` if changing setup/package/runtime entrypoints.

## Context and observed issues

### Installation state

The setup script was run from the repository root:

```sh
./keryx-setup.sh && hermes keryx doctor && ./bin/opsctl doctor
```

Observed successful setup output:

```text
OK hermes CLI found: /home/assistant/.local/bin/hermes
OK board keryx ensured
OK installed plugin symlink: /home/assistant/.hermes/plugins/keryx -> /home/assistant/Projects/keryx/hermes-plugin
✓ Plugin keryx enabled. Takes effect on next session.
OK plugin keryx enabled
WARN existing keryx.config.json kept; rerun with --force to overwrite
OK config: board=keryx; hermes=hermes
OK hermes-cli: found /home/assistant/.local/bin/hermes
OK hermes-version: 0.16.0
OK plugin: installed and enabled under /home/assistant/.hermes/plugins/keryx
OK dependencies: project dependencies installed
OK hermes: board keryx reachable; 0 blocked Keryx cards visible
OK delivery-targets: 93 target(s) available
WARN cron: no keryx-* collector cron jobs configured
```

Both doctor paths passed:

```sh
hermes keryx doctor
./bin/opsctl doctor
```

The only expected warning was the absence of collector cron jobs.

### User-facing problem

After starting a fresh Hermes CLI session, David could not see any `/keryx:*` skills. Investigation showed this was not a plugin install failure:

```text
keryx_loaded: True
keryx_skills: ['keryx-collector', 'keryx-collector-creator', 'keryx-worker']
worker_path: /home/assistant/Projects/keryx/skills/keryx/keryx-worker/SKILL.md
```

Hermes' plugin API deliberately keeps plugin skills out of the normal skill index:

```text
The skill becomes resolvable as '<plugin_name>:<name>' via skill_view().
It does not enter the flat ~/.hermes/skills/ tree and is not listed in the
system prompt's <available_skills> index — plugin skills are opt-in explicit
loads only.
```

That behaviour is acceptable for runtime-only skills, but not for the collector-creator workflow. A user should be able to discover and invoke the creator affordance without knowing the hidden plugin-qualified skill name.

### Runtime paths verified as working

The hidden runtime skills are still valid for the system design.

Cron job skill loading was verified to resolve the qualified plugin collector skill:

```text
plugin_skills: ['keryx-collector', 'keryx-collector-creator', 'keryx-worker']
cron_loaded_collector: True
cron_missing_notice: False
```

A cron job may therefore continue to use:

```json
"skills": ["keryx-collector-<source>", "keryx:keryx-collector"]
```

Kanban task skill pass-through was verified to preserve and dispatch the qualified plugin worker skill:

```text
kanban_stored_skills: ['keryx:keryx-worker']
kanban_dispatch_spawned_skills: ['keryx:keryx-worker']
spawn_contains_qualified_skill: True
spawn_skill_argv: ['--skills', 'keryx:keryx-worker']
```

A Keryx card may therefore continue to attach:

```json
"skills": ["keryx:keryx-worker"]
```

## Why a change is needed

Keryx now has three plugin-provided skills with different audiences:

- `keryx:keryx-worker` — runtime-only; loaded by dispatched Kanban workers from approved cards.
- `keryx:keryx-collector` — runtime-only; loaded by collector cron jobs after source-specific detection.
- `keryx:keryx-collector-creator` — operator-facing; invoked by a user/agent to design and install new collectors.

The current plugin-only registration treats all three equally as hidden explicit-load skills. That is right for the first two and wrong for the third.

Without a visible alias, users will try invalid slash-command shapes such as:

```text
/keryx:*
/keryx:keryx-collector-creator
```

or assume plugin installation failed because `hermes skills list` and `/skills` do not show the Keryx skills. The operator-facing path should be obvious:

```text
/keryx-collector-creator create a Gmail collector
```

## Options considered

### Option A — Copy `keryx-collector-creator` into `$HERMES_HOME/skills/keryx/...`

Rejected as the default.

Pros:

- Appears in `/skills` and `hermes skills list`.
- Gives a normal slash command.

Cons:

- Creates a stale copy of repo-owned content.
- Local skills take precedence over external/repo skills, so a stale copy may silently shadow the plugin-backed version.
- Reintroduces the skill-copy drift that the plugin migration intentionally removed.
- Requires setup/update code to decide when it may overwrite a user-modified local skill.

### Option B — Add the whole Keryx skill tree to `skills.external_dirs`

Rejected.

Pros:

- Keeps files repo-backed rather than copied.
- Makes skills visible.

Cons:

- Exposes all three skills unqualified: `keryx-worker`, `keryx-collector`, and `keryx-collector-creator`.
- Invites users, cards, or cron jobs to use the wrong unqualified runtime names.
- Undermines the design rule that cards and cron jobs attach plugin-qualified Keryx runtime skills.

### Option C — Add only a single-skill external directory

Rejected as the primary path.

Pros:

- Can expose only `keryx-collector-creator`.
- Avoids exposing worker/collector as unqualified skills.

Cons:

- Directly pointing `skills.external_dirs` at the skill directory makes `skill_view('keryx-collector-creator')` work but does not appear in `skills_list`; Hermes expects external dirs to be parent directories containing skill subdirectories.
- A one-skill parent directory with copied content lists correctly, but reintroduces drift.
- A one-skill parent directory with a symlink lists and loads, but Hermes emits a security warning because the resolved skill file is outside the configured external dir.

### Option D — Install a user-facing skill bundle alias

Accepted.

Create this setup-managed bundle:

```yaml
# $HERMES_HOME/skill-bundles/keryx-collector-creator.yaml
name: keryx-collector-creator
description: Design and author new Keryx collectors.
skills:
  - keryx:keryx-collector-creator
```

Verified in an isolated Hermes home:

```text
plugin_skills: ['keryx-collector', 'keryx-collector-creator', 'keryx-worker']
bundle_key: /keryx-collector-creator
bundle_result_exists: True
loaded: ['keryx:keryx-collector-creator']
missing: []
contains_creator_content: True
```

Pros:

- No stale skill content copy.
- Keeps the plugin skill as the single source of truth.
- Provides the desired user-facing slash command: `/keryx-collector-creator`.
- Does not expose runtime-only skills as ordinary unqualified skills.
- Works across CLI and gateway surfaces because bundle dispatch is centralised in Hermes.
- Is a small, stable, reviewable install artefact under `$HERMES_HOME/skill-bundles/`.

Cons:

- It appears under bundle surfaces rather than as a normal `/skills` entry.
- `hermes skills list` still will not show `keryx-collector-creator` as a normal skill. Documentation and doctor output must make the slash command explicit.

## Proposed approach

Keep plugin registration unchanged for all three repo-shipped skills:

```text
keryx:keryx-worker
keryx:keryx-collector
keryx:keryx-collector-creator
```

Add setup support for a **single user-facing bundle alias**:

```text
/keryx-collector-creator
```

The setup script should install or update only this bundle file:

```text
$HERMES_HOME/skill-bundles/keryx-collector-creator.yaml
```

The bundle should load the plugin-qualified creator skill:

```yaml
skills:
  - keryx:keryx-collector-creator
```

Doctor should make the operator-facing state obvious:

- plugin installed and enabled;
- plugin skills registered;
- collector creator bundle present;
- bundle resolves and loads `keryx:keryx-collector-creator`;
- runtime design remains: cards use `keryx:keryx-worker`; cron jobs use `keryx:keryx-collector`.

Docs should consistently teach:

```text
/keryx-collector-creator ...        # user/operator invocation
keryx:keryx-worker                  # card runtime skill
keryx:keryx-collector               # cron runtime skill
keryx-collector-<source>            # created source-specific Hermes-space skill
```

## Implementation tasks

### Task 1 — Add tests for setup-managed bundle installation

**Objective:** Prove setup installs the collector creator bundle without copying Keryx skills into `$HERMES_HOME/skills`.

**Files:**

- Modify: `tests/integration/setup-script.test.ts`
- Maybe modify fixtures/fake Hermes helper in the same file if needed.

**Steps:**

1. Add an integration test using a temporary `HERMES_HOME` and fake `hermes` binary, following the existing setup-script pattern.
2. Run `./keryx-setup.sh` against the fake home.
3. Assert the file exists:

   ```text
   $HERMES_HOME/skill-bundles/keryx-collector-creator.yaml
   ```

4. Assert the YAML contains exactly the intended bundle shape:

   ```yaml
   name: keryx-collector-creator
   description: Design and author new Keryx collectors.
   skills:
     - keryx:keryx-collector-creator
   ```

5. Assert setup did **not** create copied Keryx skill directories such as:

   ```text
   $HERMES_HOME/skills/keryx/keryx-worker/SKILL.md
   $HERMES_HOME/skills/keryx/keryx-collector/SKILL.md
   $HERMES_HOME/skills/keryx/keryx-collector-creator/SKILL.md
   ```

6. Run the targeted test and verify it fails before implementation:

   ```sh
   npm test -- --run tests/integration/setup-script.test.ts
   ```

Expected initial result: FAIL because setup does not yet create the bundle.

### Task 2 — Implement bundle installation in `keryx-setup.sh`

**Objective:** Make setup write the slash-command bundle alias into the selected Hermes home.

**Files:**

- Modify: `keryx-setup.sh`

**Implementation shape:**

Add variables near the plugin path variables:

```sh
BUNDLE_DIR="$HERMES_HOME_PATH/skill-bundles"
BUNDLE_PATH="$BUNDLE_DIR/keryx-collector-creator.yaml"
```

Add an `install_collector_creator_bundle` function:

```sh
install_collector_creator_bundle() {
  if [ "$DRY_RUN" -eq 1 ]; then
    say "DRY-RUN would install Keryx collector creator bundle at $BUNDLE_PATH"
    return 0
  fi

  mkdir -p "$BUNDLE_DIR"
  cat > "$BUNDLE_PATH" <<'YAML'
name: keryx-collector-creator
description: Design and author new Keryx collectors.
skills:
  - keryx:keryx-collector-creator
YAML
  say "OK installed collector creator bundle: $BUNDLE_PATH"
}
```

Call it after `enable_plugin` and before `write_config` so the plugin skill target is installed/enabled before the alias is reported.

### Task 3 — Define overwrite semantics for the bundle

**Objective:** Avoid clobbering user-modified bundle files silently.

**Files:**

- Modify: `keryx-setup.sh`
- Modify: `tests/integration/setup-script.test.ts`

**Recommended semantics:**

- If the bundle file does not exist: create it.
- If it exists and exactly matches the expected Keryx-managed content: keep/rewrite idempotently and report OK.
- If it exists with different content:
  - without `--force`: keep it and print a `WARN`, similar to `keryx.config.json` non-interactive preservation;
  - with `--force`: overwrite it.
- `--dry-run` reports whether it would write, keep, or overwrite.

**Why:** The bundle is setup-managed, but it lives in a user-owned Hermes home and could have been edited deliberately.

**Tests:**

1. Existing matching bundle is idempotent.
2. Existing conflicting bundle is preserved without `--force` and prints `WARN`.
3. Existing conflicting bundle is overwritten with `--force`.
4. `--dry-run` creates nothing and prints the planned action.

### Task 4 — Add doctor coverage for the bundle

**Objective:** Make `hermes keryx doctor` report whether the user-facing collector creator command is installed.

**Files:**

- Modify likely: `src/opsctl/commands/doctor.ts` or the existing doctor implementation path.
- Modify tests beside existing doctor tests under `tests/unit/` or `tests/integration/`.

**Checks to add:**

1. Locate `$HERMES_HOME/skill-bundles/keryx-collector-creator.yaml` using the same Hermes home resolution already used for plugin checks.
2. Parse or minimally inspect the bundle content.
3. Report OK only when it loads `keryx:keryx-collector-creator`.
4. Report WARN, not FAIL, when missing: runtime cards/cron can still work, but the operator-facing collector creation path is not installed.

**Suggested output:**

```text
OK collector-creator: /keryx-collector-creator bundle installed
```

Missing case:

```text
WARN collector-creator: bundle missing; rerun ./keryx-setup.sh to install /keryx-collector-creator
```

Conflicting case:

```text
WARN collector-creator: bundle does not load keryx:keryx-collector-creator; rerun ./keryx-setup.sh --force to restore
```

### Task 5 — Add an executable bundle-resolution test if feasible

**Objective:** Prove the generated bundle can load the plugin-qualified creator skill in a Hermes-like environment.

**Files:**

- Add or modify an integration test under `tests/integration/`.

**Test strategy:**

Use a temporary `HERMES_HOME`:

1. Create `plugins/keryx` as a symlink or copied adapter pointing at `hermes-plugin/`.
2. Write `config.yaml` enabling plugin `keryx`.
3. Run setup or write the expected bundle fixture.
4. Invoke Hermes' own venv/Python only if available in the test environment; otherwise use a fake resolver contract test.

Preferred assertion, if real Hermes internals are available:

```text
resolve_bundle_command_key('keryx-collector-creator') == '/keryx-collector-creator'
build_bundle_invocation_message('/keryx-collector-creator') loads ['keryx:keryx-collector-creator']
missing == []
```

If coupling to Hermes internals is too brittle for Keryx tests, keep this as a manual verification documented in the plan and rely on setup/doctor content tests.

### Task 6 — Update README and operations docs

**Objective:** Teach the right invocation surfaces and prevent future confusion.

**Files:**

- Modify: `README.md`
- Modify: `docs/operations.md`
- Modify: `docs/collector-authoring.md` if it describes starting the creator workflow.
- Modify: `skills/keryx/DESCRIPTION.md` if useful.

**Required documentation changes:**

1. In setup section, say setup installs a user-facing bundle:

   ```text
   /keryx-collector-creator
   ```

2. In daily commands or collector authoring, add:

   ```text
   Start a new collector design with:
   /keryx-collector-creator create a collector for <source>
   ```

3. Clarify plugin skill visibility:

   ```text
   Keryx runtime skills are plugin-qualified and intentionally hidden from /skills. Cards and cron jobs load them explicitly. The user-facing collector creator is exposed through the /keryx-collector-creator bundle installed by setup.
   ```

4. Keep runtime examples unchanged:

   ```text
   keryx:keryx-worker
   keryx:keryx-collector
   ```

### Task 7 — Update in-repo skill guidance

**Objective:** Ensure Keryx's own skills describe the user-facing creator path accurately.

**Files:**

- Modify: `skills/keryx/keryx-collector-creator/SKILL.md`
- Modify: `skills/keryx/keryx-worker/SKILL.md` only if it mentions how to request new collector creation.
- Modify: `skills/keryx/keryx-collector/SKILL.md` only if it mentions creator invocation.

**Rules:**

- Refer to the operator command as `/keryx-collector-creator`.
- Continue referring to the plugin skill as `keryx:keryx-collector-creator` only when discussing the hidden repo-shipped skill identity.
- Do not instruct users to create or attach unqualified `keryx-worker` or `keryx-collector`.

### Task 8 — Add documentation/string tests

**Objective:** Prevent regressions in the naming model.

**Files:**

- Modify: `tests/unit/templates-and-docs.test.ts`
- Modify: `tests/unit/readme.test.ts`
- Modify: `tests/unit/skills.test.ts`

**Assertions:**

1. README contains `/keryx-collector-creator`.
2. README still contains `keryx:keryx-worker` and `keryx:keryx-collector` for runtime paths.
3. Docs do not recommend `/keryx:*` or `/keryx:keryx-collector-creator` as slash commands.
4. No docs instruct card or cron attachment of unqualified `keryx-worker` or `keryx-collector`.
5. Source-specific created skills remain unqualified as `keryx-collector-<source>`.

### Task 9 — Verify setup and doctor end to end

**Objective:** Confirm the new setup behaviour works from a clean checkout and a fake or real safe Hermes home.

**Commands:**

```sh
npm run lint
npm test
./keryx-setup.sh --dry-run
./bin/opsctl doctor
```

If using a temporary Hermes home for manual verification:

```sh
tmp_home=$(mktemp -d)
./keryx-setup.sh --hermes-home "$tmp_home"
HERMES_HOME="$tmp_home" hermes plugins list --plain --no-bundled
```

Expected:

- setup reports installing/enabling plugin;
- setup reports installing collector creator bundle;
- doctor reports plugin OK;
- doctor reports collector creator bundle OK;
- no copied Keryx skills under `$HERMES_HOME/skills/keryx/`.

### Task 10 — Commit and push implementation

**Objective:** Deliver the bundle alias change cleanly.

**Steps:**

1. Check working tree:

   ```sh
   git status --short
   ```

2. Run whitespace check:

   ```sh
   git diff --check
   ```

3. Run required checks:

   ```sh
   npm run lint
   npm test
   ```

4. Commit:

   ```sh
   git add keryx-setup.sh README.md docs/operations.md docs/collector-authoring.md skills/keryx tests
   git commit -m "feat: expose keryx collector creator bundle"
   ```

5. Push:

   ```sh
   git push origin main
   ```

## Risks and tradeoffs

- The bundle command is visible through bundle/slash-command surfaces rather than `hermes skills list`. This is acceptable because the needed user action is invocation, not skill-index browsing.
- If a user edits the bundle file, setup must not silently clobber it unless `--force` is supplied.
- If Hermes changes bundle internals, Keryx should rely mostly on file/content tests and doctor messaging rather than deep imports of Hermes internals.
- The name `/keryx-collector-creator` is intentionally unqualified and user-facing; the hidden plugin skill remains `keryx:keryx-collector-creator`.

## Acceptance criteria

- `./keryx-setup.sh` installs/enables the Keryx plugin and creates `$HERMES_HOME/skill-bundles/keryx-collector-creator.yaml`.
- Invoking `/keryx-collector-creator ...` loads `keryx:keryx-collector-creator`.
- `hermes keryx doctor` or `./bin/opsctl doctor` reports the collector creator bundle state.
- `keryx-worker` and `keryx-collector` remain hidden plugin-qualified runtime skills, not copied or exposed as normal unqualified user skills.
- Cards still attach `keryx:keryx-worker`.
- Cron jobs still attach created source skills unqualified plus `keryx:keryx-collector` qualified.
- Docs explain the distinction clearly enough that a fresh user does not search for `/keryx:*` skills after setup.
