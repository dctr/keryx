import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  collectorSkillDir,
  emptyPolicy,
  loadPolicy,
  resolvePolicyPath,
  writePolicy,
} from '../../src/policy/policyStore';
import type { Policy } from '../../src/schemas/policy';

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'keryx-policy-home-'));
}

function seedPolicy(hermesHome: string, collector: string, policy: unknown): string {
  const source = collector.startsWith('keryx-') ? collector.slice('keryx-'.length) : collector;
  const dir = join(hermesHome, 'skills', `keryx-collector-${source}`, 'references');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'policy.json');
  writeFileSync(path, JSON.stringify(policy), 'utf8');
  return path;
}

const samplePolicy: Policy = {
  schema: 'keryx.policy.v1',
  collector: 'keryx-email',
  version: 3,
  updated_at: '2026-06-25T09:00:00Z',
  rules: [
    {
      id: 'r-001',
      class: 'email:newsletter-unsubscribe',
      gate: { max_blast_radius: 'self', min_reversibility: 'reversible', min_confidence: 'trusted' },
      disposition: 'silent',
      result_delivery: 'digest',
      state: 'active',
      approved_by: 'User',
      approved_at: '2026-06-25T09:00:00Z',
      source_card_id: 'keryx-123',
      scope_note: 'auto-handle one-click unsubscribes from known senders',
    },
  ],
  thresholds: { spend_requires_approval_always: true },
  track_record: {
    'email:newsletter-unsubscribe': {
      approved: 14,
      overridden: 1,
      dismissed: 2,
      regret: 0,
      band: 'trusted',
      updated_at: '2026-06-25T09:00:00Z',
    },
  },
};

describe('policy store', () => {
  it('maps a collector id to its Hermes-space skill directory', () => {
    expect(collectorSkillDir('keryx-email')).toBe('keryx-collector-email');
    // tolerates a bare source name without the keryx- prefix
    expect(collectorSkillDir('email')).toBe('keryx-collector-email');
  });

  it('resolves the references/policy.json path under the collector skill dir', () => {
    const path = resolvePolicyPath('keryx-email', { hermesHome: '/tmp/home' });
    expect(path).toBe('/tmp/home/skills/keryx-collector-email/references/policy.json');
  });

  it('returns a schema-valid empty default policy', () => {
    const policy = emptyPolicy('keryx-email', () => new Date('2026-06-26T00:00:00Z'));
    expect(policy.schema).toBe('keryx.policy.v1');
    expect(policy.collector).toBe('keryx-email');
    expect(policy.rules).toEqual([]);
    expect(policy.thresholds.spend_requires_approval_always).toBe(true);
    expect(policy.track_record).toEqual({});
  });

  it('normalises a bare source name into a keryx- prefixed collector in the empty default', () => {
    expect(emptyPolicy('email').collector).toBe('keryx-email');
  });

  it('writes a schema-valid policy atomically and can load it back', () => {
    const home = tempHome();
    const result = writePolicy(samplePolicy, { hermesHome: home });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(resolvePolicyPath('keryx-email', { hermesHome: home }));
      const loaded = loadPolicy('keryx-email', { hermesHome: home });
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.policy.version).toBe(samplePolicy.version);
        expect(loaded.policy.rules[0].id).toBe('r-001');
      }
    }
  });

  it('loads and validates an existing policy file', () => {
    const home = tempHome();
    seedPolicy(home, 'keryx-email', samplePolicy);

    const result = loadPolicy('keryx-email', { hermesHome: home });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.exists).toBe(true);
      expect(result.policy.version).toBe(3);
      expect(result.policy.rules).toHaveLength(1);
    }
  });

  it('returns an empty default when the policy file is absent', () => {
    const home = tempHome();
    const result = loadPolicy('keryx-email', { hermesHome: home, now: () => new Date('2026-06-26T00:00:00Z') });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.exists).toBe(false);
      expect(result.policy.rules).toEqual([]);
      expect(result.policy.collector).toBe('keryx-email');
    }
  });

  it('surfaces a validation error rather than silently dropping a malformed policy file', () => {
    const home = tempHome();
    seedPolicy(home, 'keryx-email', { schema: 'keryx.policy.v1', collector: 'keryx-email' });

    const result = loadPolicy('keryx-email', { hermesHome: home });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exists).toBe(true);
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('surfaces a parse error for non-JSON policy content', () => {
    const home = tempHome();
    const source = 'email';
    const dir = join(home, 'skills', `keryx-collector-${source}`, 'references');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'policy.json'), '{not json', 'utf8');

    const result = loadPolicy('keryx-email', { hermesHome: home });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].message).toContain('JSON');
    }
  });

  it('distinguishes a read error from a JSON parse error', () => {
    const home = tempHome();
    const source = 'email';
    const dir = join(home, 'skills', `keryx-collector-${source}`, 'references');
    mkdirSync(dir, { recursive: true });
    const policyPath = join(dir, 'policy.json');
    writeFileSync(policyPath, JSON.stringify(samplePolicy), 'utf8');
    chmodSync(policyPath, 0o000);

    try {
      const result = loadPolicy('keryx-email', { hermesHome: home });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0].keyword).toBe('read');
        expect(result.errors[0].message).toMatch(/could not read policy file/);
        expect(result.errors[0].message).not.toContain('JSON');
      }
    } finally {
      // restore so tmpdir cleanup can delete
      chmodSync(policyPath, 0o644);
    }
  });
});
