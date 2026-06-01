import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config';
import { createServer } from '../../src/server/app';
import type { CommandResult } from '../../src/opsctl/output';

describe('server route wiring', () => {
  it('serves health with polling-safe cache headers', async () => {
    const server = createServer({ config: loadConfig({ env: {}, configPath: null }) });

    try {
      const response = await server.inject({ method: 'GET', url: '/api/health' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({ ok: true, app: 'Keryx' });
    } finally {
      await server.close();
    }
  });

  it('delegates execute requests to shared opsctl logic', async () => {
    const runOpsctl = vi.fn(async (): Promise<CommandResult> => {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ ok: true, task_id: 't_123', status: 'ready', action: 'promoted' }),
        stderr: '',
      };
    });
    const now = new Date('2026-05-31T12:34:56.000Z');
    const server = createServer({ config: loadConfig({ env: {}, configPath: null }), runOpsctl, now: () => now });

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/api/tasks/t_123/execute',
        payload: { option_id: 'approve', feedback: 'Please be brief.' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, task_id: 't_123', status: 'ready', action: 'promoted' });
      expect(runOpsctl).toHaveBeenCalledWith(
        ['execute', 't_123', '--option', 'approve', '--feedback', 'Please be brief.'],
        expect.objectContaining({ config: expect.objectContaining({ board: 'keryx' }), now: expect.any(Function) }),
      );
    } finally {
      await server.close();
    }
  });

  it('rejects execute requests without a non-empty selected option before opsctl is called', async () => {
    const runOpsctl = vi.fn(async (): Promise<CommandResult> => ({ exitCode: 0, stdout: '{}', stderr: '' }));
    const server = createServer({ config: loadConfig({ env: {}, configPath: null }), runOpsctl });

    try {
      const response = await server.inject({ method: 'POST', url: '/api/tasks/t_123/execute', payload: { option_id: '   ' } });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'option_id must be a non-empty string' } });
      expect(runOpsctl).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('delegates dismiss requests to shared opsctl logic', async () => {
    const runOpsctl = vi.fn(async (): Promise<CommandResult> => {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ ok: true, task_id: 't_123', status: 'archived', action: 'archived' }),
        stderr: '',
      };
    });
    const server = createServer({ config: loadConfig({ env: {}, configPath: null }), runOpsctl });

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/api/tasks/t_123/dismiss',
        payload: { reason: 'No longer needed.' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, task_id: 't_123', status: 'archived', action: 'archived' });
      expect(runOpsctl).toHaveBeenCalledWith(
        ['dismiss', 't_123', '--reason', 'No longer needed.'],
        expect.objectContaining({ config: expect.objectContaining({ board: 'keryx' }) }),
      );
    } finally {
      await server.close();
    }
  });

  it('rejects dismiss requests with non-string reasons before opsctl is called', async () => {
    const runOpsctl = vi.fn(async (): Promise<CommandResult> => ({ exitCode: 0, stdout: '{}', stderr: '' }));
    const server = createServer({ config: loadConfig({ env: {}, configPath: null }), runOpsctl });

    try {
      const response = await server.inject({ method: 'POST', url: '/api/tasks/t_123/dismiss', payload: { reason: 42 } });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'reason must be a string when supplied' } });
      expect(runOpsctl).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
