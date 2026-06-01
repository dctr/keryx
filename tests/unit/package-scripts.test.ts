import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('package scripts', () => {
  it('builds the web bundle before npm start launches the production server', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.start).toContain('npm run build');
    expect(packageJson.scripts?.start).toContain('node dist/server/index.js');
  });
});
