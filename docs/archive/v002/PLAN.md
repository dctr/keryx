# Keryx v002 Hermes Plugin Migration Implementation Plan

> **For Hermes:** Use `subagent-driven-development` to implement this plan task-by-task. Each code-changing task should use `test-driven-development`: write the failing test, verify RED, implement the smallest GREEN change, refactor, then commit.

**Goal:** Migrate Keryx from copied Hermes skills plus a repo-local `opsctl` wrapper into a first-class Hermes general plugin named `keryx`, without changing Keryx’s thin-control-surface architecture.

**Architecture:** Keryx remains a Node 22+ TypeScript/Svelte/Fastify control surface over Hermes Kanban. The new Python `hermes-plugin/` adapter is deliberately thin: it registers `hermes keryx ...` and repository-backed plugin skills, then delegates command behaviour to `bin/opsctl`. Keryx schemas, skills, config, UI, and command logic remain in the repository; Hermes home receives only plugin registration/enablement and, if symlink install is impossible, a small plugin adapter copy plus a repo-root locator file.

**Tech Stack:** TypeScript ESM, Node 22+, Vitest, AJV, POSIX shell, Python Hermes plugin API, Hermes Kanban CLI, Svelte/Fastify for existing surfaces.

**Source of truth:** `docs/archive/v002/PRD.md`. Verify Hermes plugin details against <https://hermes-agent.nousresearch.com/docs/guides/build-a-hermes-plugin> and <https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins> if behaviour appears to differ.

---

## Global constraints

- Do not create real collector cron jobs.
- Do not mutate David’s real Hermes board or real Hermes home in tests; use fake Hermes binaries and temporary `HERMES_HOME` fixtures.
- Do not copy `skills/keryx/` into `$HERMES_HOME/skills/keryx/` after this migration.
- Preserve existing direct repo fallback: `./bin/opsctl ...` must still work.
- Prefer `hermes keryx ...` in docs and examples after the plugin exists.
- Use plugin-qualified skill names everywhere cards/cron jobs load Keryx skills: `keryx:keryx-worker`, `keryx:keryx-collector`, `keryx:keryx-collector-creator`.
- Keep Hermes command execution allowlisted in `src/hermes/adapter.ts`; do not add generic shell or Hermes passthroughs.
- Keep Keryx web defaults local-only: `host: 127.0.0.1`, no built-in auth.
- Treat source content as untrusted in docs, skills, fixtures, and card bodies.
- Commit after each task using conventional commits.

## Current repository facts to account for

- `keryx-setup.sh` currently copies `skills/keryx/` into `$HERMES_HOME/skills/keryx/` and then runs `./bin/opsctl doctor`.
- `bin/opsctl` resolves `ROOT_DIR`, but it does not set `KERYX_CONFIG`, so TypeScript config resolution still defaults to `process.cwd()/keryx.config.json`.
- `src/opsctl/commands.ts` currently supports: `doctor`, `list`, `show`, `cron-status`, `delivery-targets`, `validate-card`, `execute`, `dismiss`.
- `src/opsctl/commands.ts::doctor` currently checks copied skill files under `$HERMES_HOME/skills/keryx/`.
- `src/hermes/adapter.ts` currently allowlists only Kanban list/show/promote/comment/archive/dispatch, `send --list`, and `cron list --all`.
- Hermes Kanban `create` supports the needed flags: `--body`, `--assignee`, `--tenant`, `--idempotency-key`, `--created-by`, repeatable `--skill`, `--initial-status`, and `--json`.

---

## Task 1: Add plugin registration tests

**Objective:** Lock the expected Python plugin registration contract before adding the adapter.

**Files:**
- Create: `tests/integration/hermes-plugin.test.ts`
- Later create: `hermes-plugin/plugin.yaml`, `hermes-plugin/__init__.py`

**Step 1: Write the failing test**

Create a Vitest integration test that runs a small Python script against `hermes-plugin/__init__.py` with a fake context:

```ts
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = resolve('.');

async function runPython(source: string) {
  return execFileAsync('python3', ['-c', source], {
    cwd: repoRoot,
    env: { ...process.env, PYTHONPATH: repoRoot },
  });
}

describe('Hermes plugin adapter', () => {
  it('registers the keryx CLI command and bundled repository skills without side effects', async () => {
    const { stdout, stderr } = await runPython(`
import importlib.util, json, pathlib
plugin_path = pathlib.Path('hermes-plugin/__init__.py').resolve()
spec = importlib.util.spec_from_file_location('keryx_plugin_under_test', plugin_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
class Ctx:
    def __init__(self):
        self.cli = []
        self.skills = []
    def register_cli_command(self, **kwargs):
        self.cli.append(kwargs)
    def register_skill(self, name, path, description=''):
        self.skills.append({'name': name, 'path': str(path), 'description': description})
ctx = Ctx()
mod.register(ctx)
print(json.dumps({'cli': ctx.cli, 'skills': ctx.skills}, default=str))
`);
    expect(stderr).toBe('');
    const result = JSON.parse(stdout) as {
      cli: Array<Record<string, unknown>>;
      skills: Array<{ name: string; path: string; description: string }>;
    };
    expect(result.cli).toHaveLength(1);
    expect(result.cli[0]).toMatchObject({ name: 'keryx', help: expect.stringContaining('Keryx') });
    expect(result.skills.map((skill) => skill.name).sort()).toEqual([
      'keryx-collector',
      'keryx-collector-creator',
      'keryx-worker',
    ]);
    for (const skill of result.skills) {
      expect(skill.path).toContain('/skills/keryx/');
      expect(existsSync(skill.path)).toBe(true);
    }
  });
});
```

**Step 2: Verify RED**

Run:

```sh
npm test -- --run tests/integration/hermes-plugin.test.ts
```

Expected: FAIL because `hermes-plugin/__init__.py` does not exist.

**Step 3: Commit after GREEN in Task 2**

Do not commit this failing test alone unless using an implementation branch with a deliberate RED commit convention.

---

## Task 2: Implement the Hermes plugin adapter

**Objective:** Add a lightweight Hermes general plugin that registers the `hermes keryx` CLI command and repository-backed Keryx skills.

**Files:**
- Create: `hermes-plugin/plugin.yaml`
- Create: `hermes-plugin/__init__.py`
- Modify: `tests/integration/hermes-plugin.test.ts`

**Step 1: Add `plugin.yaml`**

Create:

```yaml
name: keryx
version: "0.2.0"
description: Keryx action inbox integration for Hermes Kanban
```

Do not add `requires_env`: Keryx does not need a secret to register.

**Step 2: Add root resolution helpers**

`hermes-plugin/__init__.py` should resolve the repository root from the symlink-resolved plugin path first. If setup had to copy the adapter, allow a small fallback locator file named `keryx-root.txt` inside the installed plugin directory.

```python
"""Keryx Hermes plugin.

Registers operator-facing CLI and bundled read-only skills only. The plugin
must stay thin; Keryx logic remains in the TypeScript opsctl surface.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path
from typing import Iterable

_PLUGIN_DIR = Path(__file__).resolve().parent
_INSTALL_DIR = Path(__file__).parent

_SKILLS = {
    "keryx-worker": "Execute approved Keryx action-item cards safely.",
    "keryx-collector": "Govern Keryx source collector cron jobs.",
    "keryx-collector-creator": "Design and author new Keryx collectors.",
}


def _candidate_roots() -> Iterable[Path]:
    yield _PLUGIN_DIR.parent
    locator = _INSTALL_DIR / "keryx-root.txt"
    if locator.exists():
        raw = locator.read_text(encoding="utf-8").strip()
        if raw:
            yield Path(raw).expanduser().resolve()


def _is_keryx_root(path: Path) -> bool:
    return (
        (path / "bin" / "opsctl").is_file()
        and (path / "schemas" / "action-item.v1.schema.json").is_file()
        and (path / "skills" / "keryx" / "keryx-worker" / "SKILL.md").is_file()
    )


def _resolve_keryx_root() -> Path:
    for candidate in _candidate_roots():
        if _is_keryx_root(candidate):
            return candidate
    raise FileNotFoundError(
        "Could not resolve Keryx repository root from plugin path. "
        "Expected bin/opsctl, schemas/, and skills/keryx/."
    )


KERYX_ROOT = _resolve_keryx_root()
```

**Step 3: Add CLI delegation**

Add an argparse setup that captures the remaining arguments and delegates to `bin/opsctl`:

```python
def _setup_argparse(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "opsctl_args",
        nargs=argparse.REMAINDER,
        help="Arguments passed to Keryx opsctl, e.g. doctor or list --status blocked",
    )
    parser.set_defaults(func=_handle_cli)


def _handle_cli(args: argparse.Namespace) -> None:
    argv = list(getattr(args, "opsctl_args", []) or [])
    if argv and argv[0] == "--":
        argv = argv[1:]
    env = os.environ.copy()
    env.setdefault("KERYX_CONFIG", str(KERYX_ROOT / "keryx.config.json"))
    completed = subprocess.run(
        [str(KERYX_ROOT / "bin" / "opsctl"), *argv],
        env=env,
        check=False,
    )
    raise SystemExit(completed.returncode)
```

Do not reimplement Keryx command behaviour in Python.

**Step 4: Register the CLI command and skills**

```python
def register(ctx) -> None:
    ctx.register_cli_command(
        name="keryx",
        help="Operate the Keryx action inbox",
        setup_fn=_setup_argparse,
        handler_fn=_handle_cli,
        description="Keryx CLI wrapper for schemas, card validation, Kanban actions, and doctor checks.",
    )

    for name, description in _SKILLS.items():
        ctx.register_skill(
            name,
            KERYX_ROOT / "skills" / "keryx" / name / "SKILL.md",
            description=description,
        )
```

Do not call Node, npm, Hermes, or `opsctl` during `register(ctx)`.

**Step 5: Extend tests for CLI delegation**

Add a Python test case that patches `subprocess.run` and asserts:

- `bin/opsctl` is the delegated executable;
- args are passed through unchanged;
- default `KERYX_CONFIG` points at `<repo>/keryx.config.json`;
- an explicit environment `KERYX_CONFIG` is preserved;
- `_handle_cli` exits with the child return code.

**Step 6: Verify GREEN**

Run:

```sh
npm test -- --run tests/integration/hermes-plugin.test.ts
```

Expected: PASS.

**Step 7: Commit**

```sh
git add hermes-plugin tests/integration/hermes-plugin.test.ts
git commit -m "feat: add keryx Hermes plugin adapter"
```

---

## Task 3: Make `bin/opsctl` cwd-independent

**Objective:** Ensure direct `bin/opsctl` invocation uses repo-local config by default even when called from another directory.

**Files:**
- Modify: `bin/opsctl`
- Modify: `tests/integration/opsctl-cli.test.ts`

**Step 1: Write failing tests**

Add tests for:

1. `<repo>/bin/opsctl doctor` from a temporary cwd passes `KERYX_CONFIG=<repo>/keryx.config.json` into the TypeScript process by default.
2. `KERYX_CONFIG=/tmp/custom.json <repo>/bin/opsctl doctor` preserves the explicit override.
3. `./bin/opsctl --help` still prints help without contacting Hermes.

Because `bin/opsctl` executes Node/tsx directly, make the test cheap by using a temporary fake `node_modules/.bin/tsx` earlier in PATH is not enough: the script calls `$ROOT_DIR/node_modules/.bin/tsx` by absolute path if present. Instead, test externally with fake Hermes and a temporary config file where practical:

```ts
await execFileAsync(opsctlPath, ['doctor'], {
  cwd: tmpdirPath,
  env: {
    ...process.env,
    HERMES_HOME: hermesHome,
    HERMES_BIN: fakeHermes,
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
  },
});
```

Then assert the command uses the repo config values rather than temp cwd defaults. If a lower-level assertion is needed, add a small unit test for `loadConfig({ cwd, env })` only after adding a repo-root/default path option.

**Step 2: Verify RED**

Run:

```sh
npm test -- --run tests/integration/opsctl-cli.test.ts
```

Expected: FAIL because the current shell wrapper does not export repo-local `KERYX_CONFIG`.

**Step 3: Patch `bin/opsctl`**

Add before the built/source dispatch:

```sh
KERYX_CONFIG=${KERYX_CONFIG:-"$ROOT_DIR/keryx.config.json"}
export KERYX_CONFIG
```

Leave the explicit environment override highest precedence.

**Step 4: Verify GREEN**

Run:

```sh
npm test -- --run tests/integration/opsctl-cli.test.ts
./bin/opsctl --help
```

Expected:

- targeted tests pass;
- help includes `Usage: opsctl` and existing commands.

**Step 5: Commit**

```sh
git add bin/opsctl tests/integration/opsctl-cli.test.ts
git commit -m "fix: make opsctl use repo config by default"
```

---

## Task 4: Add schema, template, and collector-state `opsctl` commands

**Objective:** Expose canonical repository schemas and a schema-valid card template through `opsctl`/`hermes keryx`.

**Files:**
- Modify: `src/opsctl/commands.ts`
- Modify: `src/opsctl/output.ts` only if formatting helpers are needed
- Modify: `tests/unit/opsctl-readonly.test.ts`

**Step 1: Update help text in the failing test**

Expect `getHelpText()` / `opsctl --help` to include:

```text
schema <action-item|execution-decision|collector-state>
template-card [--source <source>] [--collector <collector>]
validate-state <file>
```

**Step 2: Add failing tests for schema commands**

Tests should assert:

- `runOpsctl(['schema', 'action-item'], { configPath: null })` prints exactly `schemas/action-item.v1.schema.json` plus trailing newline;
- `schema execution-decision` prints `schemas/execution-decision.v1.schema.json`;
- `schema collector-state` prints `schemas/collector-state.v1.schema.json`;
- unknown schema names return exit code `2` with a concise usage error.

Use `readFileSync(resolve('schemas/action-item.v1.schema.json'), 'utf8')` as the expected content.

**Step 3: Add failing tests for `validate-state`**

Create a temporary JSON file:

```json
{
  "schema": "keryx.collector_state.v1",
  "source": "email",
  "committed_cursor": null,
  "last_success_at": null,
  "exact_dismissed_external_ids": []
}
```

Expected: `OK valid collector state: email`.

Also test a missing required field returns non-zero and includes AJV validation text.

**Step 4: Add failing tests for `template-card`**

Call:

```ts
const result = await runOpsctl(
  ['template-card', '--source', 'email', '--collector', 'keryx-email'],
  { env: {}, configPath: null, now: () => new Date('2026-06-11T00:00:00.000Z') },
);
```

Assert:

- output parses as JSON;
- `source === 'email'`;
- `collector === 'keryx-email'`;
- `idempotency_key` starts with `keryx:email:`;
- `validateActionItem(parsed).ok === true`.

**Step 5: Verify RED**

Run:

```sh
npm test -- --run tests/unit/opsctl-readonly.test.ts
```

Expected: FAIL for unknown commands.

**Step 6: Implement command handlers**

In `src/opsctl/commands.ts`:

- import all three schema JSON modules and `validateCollectorState`;
- extend `HELP_TEXT`;
- extend the command switch with `schema`, `template-card`, `validate-state`;
- keep JSON output stable with `JSON.stringify(value, null, 2) + '\n'`.

Suggested helpers:

```ts
function schemaCommand(name: string | undefined): CommandResult {
  switch (name) {
    case 'action-item':
      return ok(json(actionItemSchema));
    case 'execution-decision':
      return ok(json(executionDecisionSchema));
    case 'collector-state':
      return ok(json(collectorStateSchema));
    default:
      return fail('FAIL schema requires one of: action-item, execution-decision, collector-state', 2);
  }
}
```

```ts
function templateCard(parsed: ParsedArgs, now: () => Date): CommandResult {
  const source = stringFlag(parsed, 'source') ?? 'example';
  const collector = stringFlag(parsed, 'collector') ?? `keryx-${source}`;
  const externalId = `${source}:replace-me`;
  const card: ActionItem = {
    schema: 'keryx.action_item.v1',
    source,
    collector,
    external_id: externalId,
    idempotency_key: `keryx:${source}:replace-me`,
    origin_descriptor: `${source} item replace-me`,
    title: `Review ${source} item`,
    summary: 'Replace this summary with compact candidate facts. Do not paste raw private source content.',
    autonomy: 'minimal',
    urgency: 'normal',
    deadline: null,
    risk: null,
    source_refs: [{ type: source, id: 'replace-me' }],
    options: [
      {
        id: 'approve',
        label: 'Approve requested action',
        requires_input: false,
        input_hint: null,
        delivery: null,
        execution_prompt: 'Re-query the source system, verify the item still needs action, then perform the approved action safely.',
      },
    ],
    ui: { primary_option_id: 'approve', display_group: 'Needs approval' },
    created_at: now().toISOString(),
  };
  const validation = validateActionItem(card);
  return validation.ok ? ok(json(card)) : fail(`FAIL generated template is invalid\n${formatValidationErrors(validation.errors)}`);
}
```

**Step 7: Verify GREEN**

Run:

```sh
npm test -- --run tests/unit/opsctl-readonly.test.ts
./bin/opsctl schema action-item >/tmp/keryx-action-schema.json
./bin/opsctl template-card --source email --collector keryx-email >/tmp/keryx-card-template.json
./bin/opsctl validate-card /tmp/keryx-card-template.json
rm -f /tmp/keryx-action-schema.json /tmp/keryx-card-template.json
```

Expected: tests pass and validation prints `OK valid action card: Review email item`.

**Step 8: Commit**

```sh
git add src/opsctl tests/unit/opsctl-readonly.test.ts
git commit -m "feat: expose keryx schemas and card template"
```

---

## Task 5: Add central `create-card` command

**Objective:** Give collectors a deterministic Keryx-owned card creation path instead of duplicating raw Kanban create command construction.

**Files:**
- Modify: `src/opsctl/commands.ts`
- Modify: `src/hermes/adapter.ts`
- Modify: `src/hermes/types.ts` if a typed create result is useful
- Modify: `tests/unit/opsctl-readonly.test.ts` or create `tests/unit/opsctl-create-card.test.ts`

**Step 1: Write failing tests for policy**

Create `tests/unit/opsctl-create-card.test.ts` if the readonly file becomes crowded.

Test valid card creation:

```ts
const runner = vi.fn<HermesRunner>(async () => ({
  stdout: JSON.stringify({ id: 't_created', title: validActionItem.title, status: 'blocked' }),
  stderr: '',
  exitCode: 0,
}));
const filePath = writeTempJson(validActionItem);
const result = await runOpsctl(['create-card', filePath], {
  config: loadConfig({ env: {}, configPath: null, overrides: { defaultAssignee: 'default' } }),
  hermesRunner: runner,
});
```

Assert the runner receives:

```ts
{
  bin: 'hermes',
  args: [
    'kanban', '--board', 'keryx', 'create', validActionItem.title,
    '--body', JSON.stringify(validActionItem),
    '--assignee', 'default',
    '--tenant', validActionItem.source,
    '--idempotency-key', validActionItem.idempotency_key,
    '--created-by', validActionItem.collector,
    '--skill', 'keryx:keryx-worker',
    '--initial-status', 'blocked',
    '--json',
  ],
  env: {},
}
```

Also assert:

- invalid card JSON is rejected before Hermes is called;
- missing file path returns exit code `2`;
- explicit `config.hermesHome` is forwarded in adapter env;
- Hermes command failure returns a clear `FAIL` from existing error handling.

**Step 2: Verify RED**

Run:

```sh
npm test -- --run tests/unit/opsctl-create-card.test.ts
```

Expected: FAIL because `create-card` and adapter create support do not exist.

**Step 3: Add adapter method and allowlist**

Add to `HermesCliAdapter`:

```ts
async createTaskFromActionItem(actionItem: ActionItem): Promise<unknown> {
  return parseJson(await this.run([
    'kanban', '--board', this.config.board, 'create', actionItem.title,
    '--body', JSON.stringify(actionItem),
    '--assignee', this.config.defaultAssignee,
    '--tenant', actionItem.source,
    '--idempotency-key', actionItem.idempotency_key,
    '--created-by', actionItem.collector,
    '--skill', 'keryx:keryx-worker',
    '--initial-status', 'blocked',
    '--json',
  ]));
}
```

Extend `assertAllowedHermesArgs` so only this exact `kanban create` shape is accepted. Keep it narrow; do not allow arbitrary `kanban create` permutations.

**Step 4: Add `create-card` handler**

In `src/opsctl/commands.ts`:

- parse JSON with existing `parseJsonFile`;
- validate with `validateActionItem`;
- call `adapter.createTaskFromActionItem(validation.value)`;
- return the Hermes JSON response as JSON.

**Step 5: Verify GREEN**

Run:

```sh
npm test -- --run tests/unit/opsctl-create-card.test.ts tests/unit/hermes-adapter.test.ts
npm test -- --run tests/unit/opsctl-readonly.test.ts
```

Expected: all targeted tests pass.

**Step 6: Commit**

```sh
git add src/opsctl src/hermes tests/unit
git commit -m "feat: centralise keryx card creation"
```

---

## Task 6: Replace copied-skill doctor checks with plugin health checks

**Objective:** Make `opsctl doctor` reflect the plugin architecture instead of requiring `$HERMES_HOME/skills/keryx/`.

**Files:**
- Modify: `src/opsctl/commands.ts`
- Modify: `src/hermes/adapter.ts`
- Modify: `tests/unit/opsctl-readonly.test.ts`

**Step 1: Write failing tests**

Update doctor tests so they no longer call `writeInstalledKeryxSkills(hermesHome)`.

Create a temp plugin install path:

```ts
mkdirSync(join(hermesHome, 'plugins', 'keryx'), { recursive: true });
writeFileSync(join(hermesHome, 'plugins', 'keryx', 'plugin.yaml'), 'name: keryx\nversion: "0.2.0"\n', 'utf8');
writeFileSync(join(hermesHome, 'plugins', 'keryx', '__init__.py'), '# test plugin\n', 'utf8');
```

Update expected doctor output:

```ts
expect(result.stdout).toMatch(/^OK\s+plugin:/m);
expect(result.stdout).not.toMatch(/^FAIL\s+skills:/m);
expect(result.stdout).not.toContain('$HERMES_HOME/skills/keryx');
```

Add a missing-plugin test:

```ts
expect(result.stdout).toMatch(/^FAIL\s+plugin:/m);
expect(result.exitCode).toBe(1);
```

**Step 2: Verify RED**

Run:

```sh
npm test -- --run tests/unit/opsctl-readonly.test.ts
```

Expected: FAIL because current doctor checks copied skills.

**Step 3: Implement plugin checks**

Replace `checkInstalledSkills` with `checkInstalledPlugin`:

```ts
function checkInstalledPlugin(hermesHome: string): DoctorLine {
  const pluginDir = join(hermesHome, 'plugins', 'keryx');
  const missing = ['plugin.yaml', '__init__.py'].filter((relativePath) => !existsSync(join(pluginDir, relativePath)));
  if (missing.length > 0) {
    return { level: 'FAIL', check: 'plugin', message: `missing ${missing.join(', ')} under ${pluginDir}` };
  }
  return { level: 'OK', check: 'plugin', message: `installed under ${pluginDir}` };
}
```

Optionally add a permissive `adapter.listPlugins()` later, but do not block this task on parsing a volatile table if setup tests already prove `hermes plugins enable keryx` is called.

**Step 4: Verify GREEN**

Run:

```sh
npm test -- --run tests/unit/opsctl-readonly.test.ts
```

Expected: doctor tests pass and no copied-skill check remains.

**Step 5: Commit**

```sh
git add src/opsctl tests/unit/opsctl-readonly.test.ts
git commit -m "fix: update doctor for plugin installation"
```

---

## Task 7: Migrate setup script to install and enable the plugin

**Objective:** Replace copied-skill setup with plugin symlink/copy installation and `hermes plugins enable keryx`.

**Files:**
- Modify: `keryx-setup.sh`
- Modify: `tests/integration/setup-script.test.ts`

**Step 1: Rewrite failing setup expectations**

In `tests/integration/setup-script.test.ts`:

- remove assertions that read `$HERMES_HOME/skills/keryx/...`;
- assert dry-run output contains `would install Keryx Hermes plugin` and `would enable Hermes plugin keryx`;
- assert dry-run output does not contain `would install bundled Keryx skills`;
- assert real setup creates `$HERMES_HOME/plugins/keryx/plugin.yaml` and `$HERMES_HOME/plugins/keryx/__init__.py` via symlink or copied adapter;
- assert `$HERMES_HOME/skills/keryx` does not exist;
- assert fake Hermes log contains `plugins enable keryx`;
- assert fake Hermes log does not contain any `cron create` command.

**Step 2: Update fake Hermes**

Extend the fake Hermes script with cases for:

```sh
'plugins enable keryx')
  printf '%s\n' 'Enabled plugin keryx'
  ;;
'keryx doctor')
  printf '%s\n' 'OK plugin: installed under fake home'
  ;;
```

Keep existing `kanban boards create`, `send --list --json`, and `cron list --all` cases.

**Step 3: Verify RED**

Run:

```sh
npm test -- --run tests/integration/setup-script.test.ts
```

Expected: FAIL because setup still copies skills.

**Step 4: Patch usage text**

Change setup help:

```text
--hermes-home <path>         Install/enable the Keryx plugin in this Hermes home
--force                      Replace an existing conflicting Keryx plugin path
```

Do not describe skill copying.

**Step 5: Replace `install_skills` with `install_plugin`**

Add:

```sh
PLUGIN_SOURCE_DIR="$ROOT_DIR/hermes-plugin"
PLUGIN_TARGET_DIR="$HERMES_HOME_PATH/plugins/keryx"
```

Implement:

```sh
install_plugin() {
  if [ ! -f "$PLUGIN_SOURCE_DIR/plugin.yaml" ] || [ ! -f "$PLUGIN_SOURCE_DIR/__init__.py" ]; then
    echo "FAIL Hermes plugin adapter missing under $PLUGIN_SOURCE_DIR" >&2
    exit 1
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    say "DRY-RUN would install Keryx Hermes plugin at $PLUGIN_TARGET_DIR from $PLUGIN_SOURCE_DIR"
    return 0
  fi

  mkdir -p "$(dirname -- "$PLUGIN_TARGET_DIR")"

  if [ -L "$PLUGIN_TARGET_DIR" ]; then
    current=$(readlink "$PLUGIN_TARGET_DIR" || true)
    if [ "$current" = "$PLUGIN_SOURCE_DIR" ]; then
      say "OK plugin symlink already installed: $PLUGIN_TARGET_DIR -> $PLUGIN_SOURCE_DIR"
      return 0
    fi
    if [ "$FORCE" -ne 1 ]; then
      echo "FAIL existing Keryx plugin symlink points elsewhere: $PLUGIN_TARGET_DIR -> $current" >&2
      exit 1
    fi
    rm -f "$PLUGIN_TARGET_DIR"
  elif [ -e "$PLUGIN_TARGET_DIR" ]; then
    if [ "$FORCE" -ne 1 ]; then
      echo "FAIL existing Keryx plugin path exists; rerun with --force to replace: $PLUGIN_TARGET_DIR" >&2
      exit 1
    fi
    rm -rf "$PLUGIN_TARGET_DIR"
  fi

  if ln -s "$PLUGIN_SOURCE_DIR" "$PLUGIN_TARGET_DIR" 2>/dev/null; then
    say "OK installed plugin symlink: $PLUGIN_TARGET_DIR -> $PLUGIN_SOURCE_DIR"
    return 0
  fi

  mkdir -p "$PLUGIN_TARGET_DIR"
  cp "$PLUGIN_SOURCE_DIR/plugin.yaml" "$PLUGIN_TARGET_DIR/plugin.yaml"
  cp "$PLUGIN_SOURCE_DIR/__init__.py" "$PLUGIN_TARGET_DIR/__init__.py"
  printf '%s\n' "$ROOT_DIR" > "$PLUGIN_TARGET_DIR/keryx-root.txt"
  say "OK copied plugin adapter: $PLUGIN_TARGET_DIR"
}
```

Safety note: before using `rm -rf`, ensure `PLUGIN_TARGET_DIR` is exactly `$HERMES_HOME_PATH/plugins/keryx` and never empty.

**Step 6: Add `enable_plugin`**

```sh
enable_plugin() {
  if [ "$DRY_RUN" -eq 1 ]; then
    say "DRY-RUN would enable Hermes plugin keryx with: $HERMES_BIN plugins enable keryx"
    return 0
  fi
  run_hermes plugins enable keryx
  say "OK plugin keryx enabled"
}
```

**Step 7: Update final doctor**

Prefer a fresh Hermes plugin CLI invocation:

```sh
run_doctor() {
  if [ "$DRY_RUN" -eq 1 ]; then
    say "DRY-RUN would run hermes keryx doctor"
    return 0
  fi
  HERMES_HOME="$HERMES_HOME_PATH" KERYX_CONFIG="$CONFIG_PATH" "$HERMES_BIN" keryx doctor
}
```

If real Hermes cannot discover a newly enabled plugin until process restart, this fresh `hermes` process should still load it. Add fallback to `$ROOT_DIR/bin/opsctl doctor` only if real testing proves it necessary; if added, print a `WARN` explaining the fallback.

**Step 8: Update setup call order**

Use:

```sh
require_hermes_cli
create_board
install_plugin
enable_plugin
discover_delivery_targets
write_config
run_doctor
say "OK setup complete"
```

**Step 9: Verify GREEN**

Run:

```sh
npm test -- --run tests/integration/setup-script.test.ts
./keryx-setup.sh --dry-run
```

Expected:

- targeted tests pass;
- dry-run mentions plugin install/enablement;
- dry-run does not mention copied skills.

**Step 10: Commit**

```sh
git add keryx-setup.sh tests/integration/setup-script.test.ts
git commit -m "feat: install keryx as a Hermes plugin"
```

---

## Task 8: Cover setup conflict and `--force` semantics

**Objective:** Preserve existing plugin paths by default and replace only when explicitly forced.

**Files:**
- Modify: `tests/integration/setup-script.test.ts`
- Modify: `keryx-setup.sh` if gaps remain

**Step 1: Add conflict tests**

Add cases for:

1. Existing symlink to current `hermes-plugin/` is OK and preserved.
2. Existing symlink to another path fails without `--force`.
3. Existing regular directory fails without `--force`.
4. `--force` replaces a conflicting symlink or directory with the current adapter.
5. Fallback copied adapter includes `keryx-root.txt` only when symlink creation fails. If forcing symlink failure is awkward cross-platform, isolate the fallback copy into a shell helper that can be tested with an environment flag such as `KERYX_SETUP_DISABLE_SYMLINK=1`.

**Step 2: Verify RED/GREEN**

Run:

```sh
npm test -- --run tests/integration/setup-script.test.ts
```

Expected: all setup tests pass.

**Step 3: Commit**

```sh
git add keryx-setup.sh tests/integration/setup-script.test.ts
git commit -m "test: cover keryx plugin setup conflicts"
```

---

## Task 9: Update documentation and documentation contract tests

**Objective:** Make user/operator docs reflect plugin install, qualified skills, and central schema/template/card commands.

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/architecture.md`
- Modify: `docs/collector-authoring.md`
- Modify: `docs/operations.md`
- Modify: `docs/security.md` if it mentions setup/skills/commands
- Modify: `collectors/README.md`
- Modify: `collectors/bash-first-template/cron-prompt.md`
- Modify: `collectors/direct-agent-template/cron-prompt.md`
- Create or modify: `tests/unit/docs-contract.test.ts` / existing docs tests

**Step 1: Add failing contract tests**

Searchable assertions should include:

- `README.md` does not contain `installs bundled skills into $HERMES_HOME/skills/keryx/`.
- `README.md`, `AGENTS.md`, `docs/collector-authoring.md`, and collector prompt templates contain `keryx:keryx-worker` where worker skill attachment is documented.
- Docs mention `hermes keryx template-card`, `hermes keryx schema action-item`, `hermes keryx validate-card`, and `hermes keryx create-card`.
- Docs do not instruct collectors to call raw `hermes kanban create` as the default path.
- Any collector examples using `autonomy` use only `auto`, `minimal`, `research`, or `complex`.
- Troubleshooting references plugin install/enablement rather than copied skill files.

**Step 2: Verify RED**

Run:

```sh
npm test -- --run tests/unit/docs-contract.test.ts
```

Expected: FAIL on current copied-skill docs.

**Step 3: Update `README.md`**

Required changes:

- Describe Keryx as shipping a Hermes plugin named `keryx`.
- Setup sequence:
  1. ensure Hermes CLI;
  2. ensure board;
  3. install/enable plugin;
  4. discover delivery targets;
  5. write `keryx.config.json`;
  6. run `hermes keryx doctor`.
- Preferred daily commands:

```sh
hermes keryx doctor
hermes keryx list --status blocked
hermes keryx show <task_id>
hermes keryx cron-status
hermes keryx delivery-targets
hermes keryx schema action-item
hermes keryx template-card --source <source> --collector <collector>
hermes keryx validate-card <card.json>
hermes keryx create-card <card.json>
```

- Keep `./bin/opsctl ...` documented as direct repo fallback.
- Troubleshooting:
  - `FAIL plugin`: check `$HERMES_HOME/plugins/keryx`, run `hermes plugins list`, then `hermes plugins enable keryx`.
  - stale legacy copied skills may exist but are no longer the source of truth; do not delete user-modified skill files automatically.

**Step 4: Update `AGENTS.md`**

Required changes:

- Project map includes `hermes-plugin/`.
- Commands include `hermes keryx doctor` after setup, while keeping `./bin/opsctl doctor` for direct checks.
- Architecture rules say the plugin is the Hermes-facing adapter and Keryx remains thin over Kanban.
- Collector rules say attach `keryx:keryx-worker`.
- Documentation rule says plugin-qualified Keryx skill names must be used in examples.

**Step 5: Update collector docs and templates**

Collector creation loop should be:

```sh
hermes keryx template-card --source <source> --collector <collector> > /tmp/keryx-card.json
# fill compact candidate facts
hermes keryx schema action-item   # if field semantics are uncertain
hermes keryx validate-card /tmp/keryx-card.json
hermes keryx create-card /tmp/keryx-card.json
rm -f /tmp/keryx-card.json
```

Cron examples should use plugin-qualified skills:

```json
{
  "skills": ["keryx:keryx-collector-<source>", "keryx:keryx-collector"]
}
```

Cards should attach only:

```text
keryx:keryx-worker
```

**Step 6: Verify GREEN**

Run:

```sh
npm test -- --run tests/unit/docs-contract.test.ts
```

Expected: docs contract tests pass.

**Step 7: Commit**

```sh
git add README.md AGENTS.md docs collectors tests/unit/docs-contract.test.ts
git commit -m "docs: document keryx plugin workflow"
```

---

## Task 10: Update bundled Keryx skills for plugin-qualified names

**Objective:** Make the repository skill files correct when loaded as plugin skills.

**Files:**
- Modify: `skills/keryx/DESCRIPTION.md`
- Modify: `skills/keryx/keryx-worker/SKILL.md`
- Modify: `skills/keryx/keryx-collector/SKILL.md`
- Modify: `skills/keryx/keryx-collector-creator/SKILL.md`
- Modify or create: `tests/unit/skills.test.ts`

**Step 1: Load authoring guidance**

Before editing skill content, load/use `skill-creator`.

**Step 2: Add failing skill contract tests**

Assert:

- no Keryx skill says to attach bare `keryx-worker` to cards;
- no Keryx skill says cron jobs should load bare `keryx-collector` after migration;
- `keryx-collector` mentions `hermes keryx template-card`, `hermes keryx validate-card`, and `hermes keryx create-card`;
- `keryx-collector-creator` mentions plugin-qualified cron skill examples;
- skills do not embed full static action-card JSON templates or schemas.

**Step 3: Verify RED**

Run:

```sh
npm test -- --run tests/unit/skills.test.ts
```

Expected: FAIL on current bare names.

**Step 4: Update `keryx-collector`**

Required content changes:

- Cards attach `keryx:keryx-worker`.
- Default creation path is `hermes keryx template-card` → fill → `validate-card` → `create-card`.
- Raw `hermes kanban create` is fallback only after explicit operator approval.
- Do not paste raw private source content into card bodies.

**Step 5: Update `keryx-collector-creator`**

Required content changes:

- Source-specific plugin skills, if shipped in Keryx, are referenced as `keryx:keryx-collector-<source>`.
- Generic collector skill is `keryx:keryx-collector`.
- Worker cards attach `keryx:keryx-worker`.
- Examples prefer `hermes keryx ...` over `./bin/opsctl ...` except for direct repo fallback.

**Step 6: Update `keryx-worker`**

Required content changes:

- Do not assume the skill lives under `$HERMES_HOME/skills`.
- Any suggestion-card instructions attach `keryx:keryx-worker`.
- Keep trusted-decision semantics unchanged.

**Step 7: Verify GREEN**

Run:

```sh
npm test -- --run tests/unit/skills.test.ts
```

Expected: skill tests pass.

**Step 8: Commit**

```sh
git add skills/keryx tests/unit/skills.test.ts
git commit -m "docs: qualify bundled keryx plugin skills"
```

---

## Task 11: Update setup/config examples and package metadata if needed

**Objective:** Keep clone/install behaviour coherent for a fresh checkout.

**Files:**
- Modify: `keryx.config.example.json` if command examples or comments need plugin wording
- Modify: `package.json` only if tests or build scripts need to include plugin checks
- Modify: `docs/operations.md` if doctor/setup language was not fully handled in Task 9

**Step 1: Check current config example**

Read:

```sh
./bin/opsctl doctor
hermes keryx doctor
```

No command should require a checked-in local `keryx.config.json` beyond existing setup expectations.

**Step 2: Ensure no build change is needed**

The plugin adapter is plain Python under `hermes-plugin/`; npm build should not bundle it. Do not add Python packaging unless a future distribution PRD requires it.

**Step 3: Run focused checks**

```sh
npm test -- --run tests/integration/hermes-plugin.test.ts tests/integration/setup-script.test.ts tests/integration/opsctl-cli.test.ts
npm test -- --run tests/unit/opsctl-readonly.test.ts tests/unit/opsctl-create-card.test.ts
```

**Step 4: Commit if files changed**

```sh
git add keryx.config.example.json package.json docs/operations.md
git commit -m "chore: align plugin migration metadata"
```

Skip the commit if no files changed.

---

## Task 12: Full verification and polish

**Objective:** Prove the plugin migration is complete without touching real Hermes state beyond safe dry-runs.

**Files:**
- Modify as needed based on verification failures.

**Step 1: Run whitespace and static checks**

```sh
git diff --check
npm run lint
```

Expected: no whitespace errors; TypeScript passes.

**Step 2: Run unit/integration tests**

```sh
npm test
```

Expected: all Vitest tests pass.

**Step 3: Run typecheck and build when appropriate**

Run because shared TypeScript command/types changed:

```sh
npm run typecheck
npm run build
```

Expected: both pass.

**Step 4: Run setup dry-run**

```sh
./keryx-setup.sh --dry-run
```

Expected output includes plugin install/enablement and does not mention copied skill installation.

**Step 5: Smoke-test direct CLI commands**

Use only local files and fake/temp state where mutation would occur:

```sh
./bin/opsctl --help
./bin/opsctl schema action-item >/tmp/keryx-action-item-schema.json
./bin/opsctl template-card --source smoke --collector keryx-smoke >/tmp/keryx-smoke-card.json
./bin/opsctl validate-card /tmp/keryx-smoke-card.json
rm -f /tmp/keryx-action-item-schema.json /tmp/keryx-smoke-card.json
```

Expected: help prints, schema/template commands work, validation passes.

**Step 6: Optional manual plugin smoke test against a temp Hermes home**

Only if Hermes CLI is available and this can be done with a temporary home:

```sh
TMP_HOME=$(mktemp -d)
HERMES_HOME="$TMP_HOME" ./keryx-setup.sh --hermes-home "$TMP_HOME" --local-only
HERMES_HOME="$TMP_HOME" hermes plugins list
HERMES_HOME="$TMP_HOME" hermes keryx --help
rm -rf "$TMP_HOME"
```

Expected: plugin appears enabled and `hermes keryx --help` routes to `opsctl`. If the fake/test harness already covers this and live Hermes would require interactive config, skip and record why.

**Step 7: Inspect for stale copied-skill language**

```sh
rg 'skills/keryx|\$HERMES_HOME/skills/keryx|keryx-worker|keryx-collector' README.md AGENTS.md docs collectors skills
```

Expected: any remaining bare skill names are either skill frontmatter names or explanatory references; card/cron attachment examples are plugin-qualified.

**Step 8: Final status**

```sh
git status --short
git log --oneline --decorate -12
```

Expected: working tree clean after final commits.

**Step 9: Commit verification fixes**

If verification revealed defects:

```sh
git add <fixed-files>
git commit -m "fix: polish keryx plugin migration"
```

---

## Acceptance checklist

The implementation is complete when:

- [ ] `hermes-plugin/plugin.yaml` and `hermes-plugin/__init__.py` exist.
- [ ] Plugin registration tests prove `ctx.register_cli_command(name='keryx', ...)` is called.
- [ ] Plugin registration tests prove all three bundled skills are registered from repository paths.
- [ ] Plugin registration does not run Node, npm, Hermes, or `opsctl`.
- [ ] `bin/opsctl` uses repo-local `keryx.config.json` by default outside the repo cwd.
- [ ] Explicit `KERYX_CONFIG` still wins.
- [ ] `opsctl schema action-item|execution-decision|collector-state` prints canonical repository schema files.
- [ ] `opsctl template-card` emits schema-valid `keryx.action_item.v1` JSON.
- [ ] `opsctl validate-state` validates `keryx.collector_state.v1` files.
- [ ] `opsctl create-card` validates before calling Hermes and uses central Keryx card policy.
- [ ] `create-card` attaches `keryx:keryx-worker`, creates `blocked`, sets tenant/source, created-by/collector, assignee/config, and idempotency key.
- [ ] `opsctl doctor` checks plugin installation, not copied skill files.
- [ ] `keryx-setup.sh --dry-run` reports plugin install/enablement and no copied-skill install.
- [ ] Real setup tests use temp `HERMES_HOME` and fake Hermes only.
- [ ] Setup creates/updates `$HERMES_HOME/plugins/keryx` and calls `hermes plugins enable keryx`.
- [ ] Setup does not create collector cron jobs.
- [ ] Setup does not copy `skills/keryx/` into `$HERMES_HOME/skills/keryx/`.
- [ ] README, AGENTS, docs, collector templates, and skills use plugin-qualified skill attachment names.
- [ ] Collector docs and skills point to `hermes keryx template-card`, `schema`, `validate-card`, and `create-card` instead of embedding schema/template copies.
- [ ] `npm run lint` passes.
- [ ] `npm test` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm run build` passes if command/type/build-relevant files changed.

---

## Known risks and stopping rules

- **Hermes plugin CLI discovery differs from docs:** stop and verify against live `hermes plugins list`, `HERMES_PLUGINS_DEBUG=1 hermes plugins list`, and the current docs before inventing a workaround.
- **`hermes plugins enable keryx` output changes:** keep setup assertions focused on the command being called and observable plugin path state, not brittle prose.
- **Symlink install unavailable:** copy only `plugin.yaml`, `__init__.py`, and `keryx-root.txt`; never copy `skills/keryx/` into Hermes home.
- **Legacy copied skills exist:** warn in docs/doctor if useful, but do not delete them automatically; they may be user-modified.
- **Kanban create flags change:** update the narrow adapter allowlist and tests from the live Hermes CLI; do not widen to arbitrary passthrough.
- **Docs still contain bare skill names:** distinguish frontmatter names from attachment examples. Bare names are acceptable as local skill file names; not acceptable as post-migration card/cron load names.
