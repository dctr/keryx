import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config';
import { createServer } from '../../src/server/app';

describe('server static web UI', () => {
  it('serves the built Svelte index and assets from the configured web root', async () => {
    const webRoot = mkdtempSync(join(tmpdir(), 'keryx-web-root-'));
    mkdirSync(join(webRoot, 'assets'));
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><main>Keryx shell</main><script src="/assets/app.js"></script>');
    writeFileSync(join(webRoot, 'assets', 'app.js'), 'window.__KERYX_TEST_ASSET__ = true;');
    const server = createServer({ config: loadConfig({ env: {}, configPath: null }), webRoot });

    try {
      const index = await server.inject({ method: 'GET', url: '/' });
      expect(index.statusCode).toBe(200);
      expect(index.headers['content-type']).toContain('text/html');
      expect(index.body).toContain('<main>Keryx shell</main>');

      const asset = await server.inject({ method: 'GET', url: '/assets/app.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['content-type']).toContain('javascript');
      expect(asset.body).toContain('window.__KERYX_TEST_ASSET__ = true;');
    } finally {
      await server.close();
      rmSync(webRoot, { recursive: true, force: true });
    }
  });

  it('does not allow asset path traversal outside the web root', async () => {
    const webRoot = mkdtempSync(join(tmpdir(), 'keryx-web-root-'));
    mkdirSync(join(webRoot, 'assets'));
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><main>Keryx shell</main>');
    writeFileSync(join(tmpdir(), 'keryx-secret.txt'), 'secret');
    const server = createServer({ config: loadConfig({ env: {}, configPath: null }), webRoot });

    try {
      const response = await server.inject({ method: 'GET', url: '/assets/..%2Fkeryx-secret.txt' });
      expect(response.statusCode).toBe(404);
    } finally {
      await server.close();
      rmSync(webRoot, { recursive: true, force: true });
      rmSync(join(tmpdir(), 'keryx-secret.txt'), { force: true });
    }
  });
});
