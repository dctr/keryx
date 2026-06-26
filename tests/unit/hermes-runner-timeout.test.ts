import { describe, it, expect } from 'vitest';
import { defaultHermesRunner } from '../../src/hermes/adapter.js';

describe('defaultHermesRunner timeout', () => {
  it('rejects with a timeout message when the process takes too long', async () => {
    const request = {
      bin: 'sleep',
      args: ['10'],
      env: {},
      timeoutMs: 200,
    };

    await expect(defaultHermesRunner(request)).rejects.toThrow(/timed out/i);
  });

  it('resolves normally when the process completes before the timeout', async () => {
    const request = {
      bin: 'echo',
      args: ['hello'],
      env: {},
      timeoutMs: 5000,
    };

    const result = await defaultHermesRunner(request);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('resolves normally with no timeout set (default 30s is not hit in fast commands)', async () => {
    const request = {
      bin: 'echo',
      args: ['world'],
      env: {},
    };

    const result = await defaultHermesRunner(request);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('world');
  });
});
