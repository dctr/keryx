import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = resolve('.');
const setupScript = resolve('keryx-setup.sh');
const expectedCollectorCreatorBundle = `name: keryx-collector-creator
description: Design and author new Keryx collectors.
skills:
  - keryx:keryx-collector-creator
`;

async function runPython(source: string) {
  return execFileAsync('python3', ['-c', source], {
    cwd: repoRoot,
    env: { ...process.env, PYTHONPATH: repoRoot, PYTHONDONTWRITEBYTECODE: '1' },
  });
}

async function resolveHermesPython(): Promise<string | null> {
  const configured = process.env.HERMES_AGENT_PYTHON;
  if (configured) {
    const usable = await resolveUsableHermesPython(configured);
    if (usable) {
      return usable;
    }
  }

  try {
    const { stdout } = await execFileAsync('sh', ['-lc', 'command -v hermes && head -n 1 "$(command -v hermes)"'], {
      cwd: repoRoot,
      env: process.env,
    });
    const shebang = stdout.trim().split('\n').at(-1) ?? '';
    const match = shebang.match(/^#!([^\s]+python\d*(?:\.\d*)?)/);
    if (match?.[1]) {
      return await resolveUsableHermesPython(match[1]);
    }
  } catch {
    // Hermes internals are optional for this repository's portable test suite.
  }

  return null;
}

async function resolveUsableHermesPython(candidate: string): Promise<string | null> {
  if (!existsSync(candidate)) {
    return null;
  }

  try {
    await execFileAsync(candidate, ['-c', `
from hermes_cli.plugins import discover_plugins, get_plugin_manager
from agent.skill_bundles import build_bundle_invocation_message, resolve_bundle_command_key
assert discover_plugins
assert get_plugin_manager
assert build_bundle_invocation_message
assert resolve_bundle_command_key
`], {
      cwd: repoRoot,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    return candidate;
  } catch {
    return null;
  }
}

async function installWithSetup(hermesHome: string, root: string): Promise<void> {
  const fakeHermes = join(root, 'bin', 'hermes');
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFakeHermes(fakeHermes);

  const { stderr } = await execFileAsync(setupScript, ['--hermes-home', hermesHome], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HERMES_BIN: fakeHermes,
      KERYX_CONFIG: join(root, 'keryx.config.json'),
    },
  });
  expect(stderr).toBe('');
}

function writeFakeHermes(path: string): void {
  writeFileSync(
    path,
    `#!/usr/bin/env sh
set -eu
case "$*" in
  'kanban boards create keryx --name Keryx')
    printf '%s\n' '{"ok":true,"board":"keryx"}'
    ;;
  'plugins enable keryx')
    printf '%s\n' 'Enabled plugin keryx'
    ;;
  'keryx doctor')
    printf '%s\n' 'OK plugin: installed under fake home'
    ;;
  *)
    printf '%s\n' '{"ok":true}'
    ;;
esac
`,
    'utf8',
  );
  chmodSync(path, 0o755);
}

describe('Hermes plugin adapter', () => {
  it('resolves the collector creator bundle to the plugin-qualified creator skill when Hermes internals are available', async () => {
    const root = mkdtempSync(join(tmpdir(), 'keryx-hermes-test-'));
    const hermesHome = join(root, 'hermes-home');
    try {
      await installWithSetup(hermesHome, root);
      writeFileSync(
        join(hermesHome, 'config.yaml'),
        `plugins:\n  enabled:\n    - keryx\n`,
        'utf8',
      );
      const generatedBundle = readFileSync(join(hermesHome, 'skill-bundles', 'keryx-collector-creator.yaml'), 'utf8');
      expect(generatedBundle).toBe(expectedCollectorCreatorBundle);

      const hermesPython = await resolveHermesPython();
      if (!hermesPython) {
        const pluginSource = readFileSync(resolve('hermes-plugin/__init__.py'), 'utf8');
        expect(generatedBundle).toContain('name: keryx-collector-creator');
        expect(generatedBundle).toContain('  - keryx:keryx-collector-creator');
        expect(pluginSource).toContain('"keryx-collector-creator"');
        return;
      }

      const { stdout, stderr } = await execFileAsync(hermesPython, ['-c', `
import json
from hermes_cli.plugins import discover_plugins, get_plugin_manager
from agent.skill_bundles import build_bundle_invocation_message, resolve_bundle_command_key

discover_plugins(force=True)
manager = get_plugin_manager()
result = build_bundle_invocation_message('/keryx-collector-creator')
print(json.dumps({
    'bundle_key': resolve_bundle_command_key('keryx-collector-creator'),
    'plugin_skills': sorted(manager.list_plugin_skills('keryx')),
    'result_exists': result is not None,
    'loaded': result[1] if result else None,
    'missing': result[2] if result else None,
}, sort_keys=True))
`], {
        cwd: repoRoot,
        env: { ...process.env, HERMES_HOME: hermesHome, PYTHONDONTWRITEBYTECODE: '1' },
      });

      expect(stderr).toBe('');
      const result = JSON.parse(stdout) as {
        bundle_key: string | null;
        plugin_skills: string[];
        result_exists: boolean;
        loaded: string[] | null;
        missing: string[] | null;
      };

      expect(result.bundle_key).toBe('/keryx-collector-creator');
      expect(result.plugin_skills).toContain('keryx-collector-creator');
      expect(result.result_exists).toBe(true);
      expect(result.loaded).toEqual(['keryx:keryx-collector-creator']);
      expect(result.missing).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('registers the keryx CLI command and bundled repository skills without side effects', async () => {
    const { stdout, stderr } = await runPython(`
import importlib.util, json, pathlib
plugin_path = pathlib.Path('hermes-plugin/__init__.py').resolve()
spec = importlib.util.spec_from_file_location('keryx_plugin_under_test', plugin_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
def unexpected_run(*args, **kwargs):
    raise AssertionError(f'register() unexpectedly called subprocess.run with {args!r} {kwargs!r}')
mod.subprocess.run = unexpected_run
class Ctx:
    def __init__(self):
        self.cli = []
        self.skills = []
    def register_cli_command(self, **kwargs):
        self.cli.append({
            key: (value.__name__ if callable(value) else value)
            for key, value in kwargs.items()
        })
    def register_skill(self, name, path, description=''):
        self.skills.append({'name': name, 'path': str(path), 'description': description})
ctx = Ctx()
mod.register(ctx)
print(json.dumps({'cli': ctx.cli, 'skills': ctx.skills}, sort_keys=True))
`);

    expect(stderr).toBe('');
    const result = JSON.parse(stdout) as {
      cli: Array<Record<string, unknown>>;
      skills: Array<{ name: string; path: string; description: string }>;
    };

    expect(result.cli).toHaveLength(1);
    expect(result.cli[0]).toMatchObject({
      name: 'keryx',
      help: expect.stringContaining('Keryx'),
      setup_fn: '_setup_argparse',
      handler_fn: '_handle_cli',
      description: expect.stringContaining('Keryx'),
    });

    expect(result.skills.map((skill) => skill.name).sort()).toEqual([
      'keryx-collector',
      'keryx-collector-creator',
      'keryx-worker',
    ]);

    for (const skill of result.skills) {
      expect(skill.path).toBe(resolve(repoRoot, 'skills/keryx', skill.name, 'SKILL.md'));
      expect(existsSync(skill.path)).toBe(true);
      expect(skill.description).toContain('Keryx');
    }
  });

  it('delegates CLI handling to bin/opsctl with repo-local defaults', async () => {
    const { stdout, stderr } = await runPython(`
import argparse, importlib.util, json, os, pathlib
plugin_path = pathlib.Path('hermes-plugin/__init__.py').resolve()
spec = importlib.util.spec_from_file_location('keryx_plugin_under_test', plugin_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

calls = []
class Completed:
    def __init__(self, returncode):
        self.returncode = returncode

def fake_run(argv, *, env, check):
    calls.append({'argv': [str(item) for item in argv], 'keryx_config': env.get('KERYX_CONFIG'), 'check': check})
    return Completed(23)

mod.subprocess.run = fake_run
try:
    mod._handle_cli(argparse.Namespace(opsctl_args=['doctor', '--json']))
except SystemExit as exc:
    first_exit_code = exc.code
else:
    raise AssertionError('_handle_cli did not exit after first call')

os.environ['KERYX_CONFIG'] = '/tmp/explicit-keryx.json'
def fake_run_with_explicit_config(argv, *, env, check):
    calls.append({'argv': [str(item) for item in argv], 'keryx_config': env.get('KERYX_CONFIG'), 'check': check})
    return Completed(7)

mod.subprocess.run = fake_run_with_explicit_config
try:
    mod._handle_cli(argparse.Namespace(opsctl_args=['--', 'list', '--status', 'blocked']))
except SystemExit as exc:
    second_exit_code = exc.code
else:
    raise AssertionError('_handle_cli did not exit after second call')

print(json.dumps({'calls': calls, 'first_exit_code': first_exit_code, 'second_exit_code': second_exit_code}, sort_keys=True))
`);

    expect(stderr).toBe('');
    const result = JSON.parse(stdout) as {
      calls: Array<{ argv: string[]; keryx_config: string; check: boolean }>;
      first_exit_code: number;
      second_exit_code: number;
    };

    expect(result.first_exit_code).toBe(23);
    expect(result.second_exit_code).toBe(7);
    expect(result.calls).toHaveLength(2);
    expect(result.calls[0]).toEqual({
      argv: [resolve(repoRoot, 'bin/opsctl'), 'doctor', '--json'],
      keryx_config: resolve(repoRoot, 'keryx.config.json'),
      check: false,
    });
    expect(result.calls[1]).toEqual({
      argv: [resolve(repoRoot, 'bin/opsctl'), 'list', '--status', 'blocked'],
      keryx_config: '/tmp/explicit-keryx.json',
      check: false,
    });
  });

  it('passes --help through to opsctl instead of argparse wrapper help', async () => {
    const { stdout, stderr } = await runPython(`
import argparse, importlib.util, json, pathlib
plugin_path = pathlib.Path('hermes-plugin/__init__.py').resolve()
spec = importlib.util.spec_from_file_location('keryx_plugin_under_test', plugin_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

calls = []
class Completed:
    returncode = 0

def fake_run(argv, *, env, check):
    calls.append({'argv': [str(item) for item in argv], 'check': check})
    return Completed()

parser = argparse.ArgumentParser(prog='hermes keryx')
mod._setup_argparse(parser)
args = parser.parse_args(['--help'])
mod.subprocess.run = fake_run
try:
    args.func(args)
except SystemExit as exc:
    exit_code = exc.code
else:
    raise AssertionError('handler did not exit')
print(json.dumps({'calls': calls, 'exit_code': exit_code}, sort_keys=True))
`);

    expect(stderr).toBe('');
    const result = JSON.parse(stdout) as { calls: Array<{ argv: string[]; check: boolean }>; exit_code: number };

    expect(result.exit_code).toBe(0);
    expect(result.calls).toEqual([{ argv: [resolve(repoRoot, 'bin/opsctl'), '--help'], check: false }]);
  });
});
