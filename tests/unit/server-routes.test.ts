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

  it('rejects execute requests for ids beginning with a dash before opsctl is called', async () => {
    const runOpsctl = vi.fn(async (): Promise<CommandResult> => ({ exitCode: 0, stdout: '{}', stderr: '' }));
    const server = createServer({ config: loadConfig({ env: {}, configPath: null }), runOpsctl });

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/api/tasks/-rf/execute',
        payload: { option_id: 'approve' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'task id must not begin with "-"' },
      });
      expect(runOpsctl).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('rejects dismiss requests for ids beginning with a dash before opsctl is called', async () => {
    const runOpsctl = vi.fn(async (): Promise<CommandResult> => ({ exitCode: 0, stdout: '{}', stderr: '' }));
    const server = createServer({ config: loadConfig({ env: {}, configPath: null }), runOpsctl });

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/api/tasks/%20-rf/dismiss',
        payload: { reason: 'spoofed option-lookalike id' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'task id must not begin with "-"' },
      });
      expect(runOpsctl).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('serves collector policy via opsctl policy show --json', async () => {
    const runOpsctl = vi.fn(async (): Promise<CommandResult> => ({
      exitCode: 0,
      stdout: JSON.stringify({ collector: 'keryx-email', exists: true, rules: [], track_record: {} }),
      stderr: '',
    }));
    const server = createServer({ config: loadConfig({ env: {}, configPath: null }), runOpsctl });

    try {
      const response = await server.inject({ method: 'GET', url: '/api/policy/keryx-email' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toMatchObject({ collector: 'keryx-email', exists: true });
      expect(runOpsctl).toHaveBeenCalledWith(
        ['policy', 'show', 'keryx-email', '--json'],
        expect.objectContaining({ config: expect.objectContaining({ board: 'keryx' }) }),
      );
    } finally {
      await server.close();
    }
  });

  it('rejects a policy collector with an unsafe name before opsctl is called', async () => {
    const runOpsctl = vi.fn(async (): Promise<CommandResult> => ({ exitCode: 0, stdout: '{}', stderr: '' }));
    const server = createServer({ config: loadConfig({ env: {}, configPath: null }), runOpsctl });

    try {
      const response = await server.inject({ method: 'GET', url: '/api/policy/-rf' });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
      expect(runOpsctl).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('serves metrics via opsctl metrics --json with an optional window', async () => {
    const runOpsctl = vi.fn(async (): Promise<CommandResult> => ({
      exitCode: 0,
      stdout: JSON.stringify({ counts: { tasks: 3, silentExecutions: 1 } }),
      stderr: '',
    }));
    const server = createServer({ config: loadConfig({ env: {}, configPath: null }), runOpsctl });

    try {
      const response = await server.inject({ method: 'GET', url: '/api/metrics?window=7d' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toMatchObject({ counts: { tasks: 3 } });
      expect(runOpsctl).toHaveBeenCalledWith(
        ['metrics', '--window', '7d', '--json'],
        expect.objectContaining({ config: expect.objectContaining({ board: 'keryx' }) }),
      );
    } finally {
      await server.close();
    }
  });

  it('serves metrics without a window when none is supplied', async () => {
    const runOpsctl = vi.fn(async (): Promise<CommandResult> => ({ exitCode: 0, stdout: '{"counts":{}}', stderr: '' }));
    const server = createServer({ config: loadConfig({ env: {}, configPath: null }), runOpsctl });

    try {
      const response = await server.inject({ method: 'GET', url: '/api/metrics' });
      expect(response.statusCode).toBe(200);
      expect(runOpsctl).toHaveBeenCalledWith(['metrics', '--json'], expect.anything());
    } finally {
      await server.close();
    }
  });

  it('delegates policy revoke to opsctl', async () => {
    const runOpsctl = vi.fn(async (): Promise<CommandResult> => ({
      exitCode: 0,
      stdout: JSON.stringify({ id: 't_revoke' }),
      stderr: '',
    }));
    const server = createServer({ config: loadConfig({ env: {}, configPath: null }), runOpsctl });

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/api/policy/keryx-email/revoke',
        payload: { rule_id: 'r-001' },
      });

      expect(response.statusCode).toBe(200);
      expect(runOpsctl).toHaveBeenCalledWith(
        ['policy', 'revoke', 'keryx-email', '--rule', 'r-001'],
        expect.objectContaining({ config: expect.objectContaining({ board: 'keryx' }) }),
      );
    } finally {
      await server.close();
    }
  });

  it('rejects policy revoke without a rule_id before opsctl is called', async () => {
    const runOpsctl = vi.fn(async (): Promise<CommandResult> => ({ exitCode: 0, stdout: '{}', stderr: '' }));
    const server = createServer({ config: loadConfig({ env: {}, configPath: null }), runOpsctl });

    try {
      const response = await server.inject({ method: 'POST', url: '/api/policy/keryx-email/revoke', payload: {} });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'rule_id must be a non-empty string' } });
      expect(runOpsctl).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('delegates an undo request to opsctl', async () => {
    const runOpsctl = vi.fn(async (): Promise<CommandResult> => ({
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, task_id: 't_silent', undo_kind: 'reverse', status: 'ready' }),
      stderr: '',
    }));
    const server = createServer({ config: loadConfig({ env: {}, configPath: null }), runOpsctl });

    try {
      const response = await server.inject({ method: 'POST', url: '/api/tasks/t_silent/undo' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toMatchObject({ ok: true, undo_kind: 'reverse', status: 'ready' });
      expect(runOpsctl).toHaveBeenCalledWith(
        ['undo', 't_silent'],
        expect.objectContaining({ config: expect.objectContaining({ board: 'keryx' }) }),
      );
    } finally {
      await server.close();
    }
  });

  it('rejects an undo request for an id beginning with a dash before opsctl is called', async () => {
    const runOpsctl = vi.fn(async (): Promise<CommandResult> => ({ exitCode: 0, stdout: '{}', stderr: '' }));
    const server = createServer({ config: loadConfig({ env: {}, configPath: null }), runOpsctl });

    try {
      const response = await server.inject({ method: 'POST', url: '/api/tasks/-rf/undo' });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'task id must not begin with "-"' },
      });
      expect(runOpsctl).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('delegates a mark-reviewed request to opsctl', async () => {
    const runOpsctl = vi.fn(async (): Promise<CommandResult> => ({
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, task_id: 't_done', status: 'archived', action: 'reviewed' }),
      stderr: '',
    }));
    const server = createServer({ config: loadConfig({ env: {}, configPath: null }), runOpsctl });

    try {
      const response = await server.inject({ method: 'POST', url: '/api/tasks/t_done/mark-reviewed' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, status: 'archived', action: 'reviewed' });
      expect(runOpsctl).toHaveBeenCalledWith(
        ['mark-reviewed', 't_done'],
        expect.objectContaining({ config: expect.objectContaining({ board: 'keryx' }) }),
      );
    } finally {
      await server.close();
    }
  });

  it('delegates a regret signal to opsctl', async () => {
    const runOpsctl = vi.fn(async (): Promise<CommandResult> => ({
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, task_id: 't_1', kind: 'should_have_asked' }),
      stderr: '',
    }));
    const server = createServer({ config: loadConfig({ env: {}, configPath: null }), runOpsctl });

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/api/tasks/t_1/regret',
        payload: { kind: 'should_have_asked', note: 'Too aggressive.' },
      });

      expect(response.statusCode).toBe(200);
      expect(runOpsctl).toHaveBeenCalledWith(
        ['regret', 't_1', '--kind', 'should_have_asked', '--note', 'Too aggressive.'],
        expect.objectContaining({ config: expect.objectContaining({ board: 'keryx' }) }),
      );
    } finally {
      await server.close();
    }
  });

  it('rejects a regret with an invalid kind before opsctl is called', async () => {
    const runOpsctl = vi.fn(async (): Promise<CommandResult> => ({ exitCode: 0, stdout: '{}', stderr: '' }));
    const server = createServer({ config: loadConfig({ env: {}, configPath: null }), runOpsctl });

    try {
      const response = await server.inject({ method: 'POST', url: '/api/tasks/t_1/regret', payload: { kind: 'nope' } });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
      expect(runOpsctl).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
