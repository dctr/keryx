import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config';
import { createServer } from '../../src/server/app';

function makeWebRoot(): string {
  const webRoot = mkdtempSync(join(tmpdir(), 'keryx-host-web-'));
  mkdirSync(join(webRoot, 'assets'));
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><main>Keryx shell</main>');
  return webRoot;
}

describe('host-header allowlist (DNS-rebinding defence)', () => {
  let webRoot: string;

  beforeEach(() => {
    webRoot = makeWebRoot();
  });

  afterEach(() => {
    rmSync(webRoot, { recursive: true, force: true });
  });

  function server(env: Record<string, string | undefined> = {}) {
    return createServer({ config: loadConfig({ env: {}, configPath: null }), env, webRoot });
  }

  it.each([['localhost'], ['localhost:4173'], ['127.0.0.1'], ['127.0.0.1:4173'], ['[::1]'], ['[::1]:4173']])(
    'allows local Host %s on the API route',
    async (host) => {
      const s = server();
      try {
        const response = await s.inject({ method: 'GET', url: '/api/health', headers: { host } });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true, app: 'Keryx' });
      } finally {
        await s.close();
      }
    },
  );

  it.each([['localhost'], ['127.0.0.1:4173'], ['[::1]:4173']])('allows local Host %s on the static route', async (host) => {
    const s = server();
    try {
      const response = await s.inject({ method: 'GET', url: '/', headers: { host } });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<main>Keryx shell</main>');
    } finally {
      await s.close();
    }
  });

  it('rejects a non-local Host on the API route with 403 FORBIDDEN_HOST', async () => {
    const s = server();
    try {
      const response = await s.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example.com' } });
      expect(response.statusCode).toBe(403);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({
        ok: false,
        error: { code: 'FORBIDDEN_HOST', message: expect.stringContaining('Host') },
      });
    } finally {
      await s.close();
    }
  });

  it('rejects a non-local Host on the static route with 403 FORBIDDEN_HOST', async () => {
    const s = server();
    try {
      const response = await s.inject({ method: 'GET', url: '/', headers: { host: 'attacker.test:4173' } });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        ok: false,
        error: { code: 'FORBIDDEN_HOST', message: expect.stringContaining('Host') },
      });
    } finally {
      await s.close();
    }
  });

  it('rejects a non-local Host before reaching opsctl on a mutation route', async () => {
    const s = server();
    try {
      const response = await s.inject({
        method: 'POST',
        url: '/api/tasks/t_x/execute',
        headers: { host: 'evil.example.com' },
        payload: { option_id: 'whatever' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ ok: false, error: { code: 'FORBIDDEN_HOST' } });
    } finally {
      await s.close();
    }
  });

  it('allows an extra host supplied via KERYX_ALLOWED_HOSTS', async () => {
    const s = server({ KERYX_ALLOWED_HOSTS: 'keryx.example.com' });
    try {
      const allowed = await s.inject({ method: 'GET', url: '/api/health', headers: { host: 'keryx.example.com:4173' } });
      expect(allowed.statusCode).toBe(200);

      const denied = await s.inject({ method: 'GET', url: '/api/health', headers: { host: 'other.example.com' } });
      expect(denied.statusCode).toBe(403);
    } finally {
      await s.close();
    }
  });
});
