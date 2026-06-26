import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('package scripts', () => {
  it('builds the web bundle before npm start launches the production server', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.start).toContain('npm run build');
    expect(packageJson.scripts?.start).toContain('node dist/server/index.js');
  });

  it('keeps lint as a composed quality gate starting with TypeScript checks', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.['lint:ts']).toBe('tsc --noEmit --project tsconfig.json');
    expect(packageJson.scripts?.lint).toContain('lint:ts');
  });

  it('includes ESLint gate in lint script', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.['lint:eslint']).toBe('eslint . --max-warnings=0');
    expect(packageJson.scripts?.lint).toContain('lint:eslint');
  });

  it('includes ShellCheck gate in lint script', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.['lint:sh']).toBe('shellcheck keryx-setup.sh');
    expect(packageJson.scripts?.lint).toContain('lint:sh');
  });

  it('provides a stable local pre-commit check command', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.check).toBe('npm run lint && npm test');
  });

  it('runs tests once instead of entering vitest watch mode so agents do not hang', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.test).toBe('vitest run');
    expect(packageJson.scripts?.['test:watch']).toBe('vitest');
  });
});
