import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = resolve('.');

async function runPython(source: string) {
  return execFileAsync('python3', ['-c', source], {
    cwd: repoRoot,
    env: { ...process.env, PYTHONPATH: repoRoot, PYTHONDONTWRITEBYTECODE: '1' },
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
