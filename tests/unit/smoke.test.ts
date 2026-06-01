import { describe, expect, it } from 'vitest';
import { createAppName } from '../../src/server/app';

describe('project smoke test', () => {
  it('exposes the Keryx app name', () => {
    expect(createAppName()).toBe('Keryx');
  });
});
