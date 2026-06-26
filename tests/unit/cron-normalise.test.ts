import { describe, expect, it } from 'vitest';
import { cronJobCandidates, inferCronEnabled, sourceFromJobName } from '../../src/hermes/cronNormalise';

describe('cronJobCandidates', () => {
  it('returns array input as-is', () => {
    const arr = [{ name: 'job-a' }, { name: 'job-b' }];
    expect(cronJobCandidates(arr)).toBe(arr);
  });

  it('extracts jobs from {jobs:[...]} envelope', () => {
    const jobs = [{ name: 'j1' }];
    expect(cronJobCandidates({ jobs })).toBe(jobs);
  });

  it('extracts cron_jobs from {cron_jobs:[...]} envelope', () => {
    const jobs = [{ name: 'j2' }];
    expect(cronJobCandidates({ cron_jobs: jobs })).toBe(jobs);
  });

  it('extracts nested arrays from arbitrary object values', () => {
    const inner = ['keryx-a'];
    const result = cronJobCandidates({ other: inner });
    expect(result).toEqual(['keryx-a']);
  });

  it('returns [] for non-object, non-array input', () => {
    expect(cronJobCandidates('string')).toEqual([]);
    expect(cronJobCandidates(null)).toEqual([]);
    expect(cronJobCandidates(42)).toEqual([]);
  });
});

describe('inferCronEnabled', () => {
  it('trusts boolean enabled field', () => {
    expect(inferCronEnabled({ enabled: true })).toBe(true);
    expect(inferCronEnabled({ enabled: false })).toBe(false);
  });

  it('paused:true -> disabled', () => {
    expect(inferCronEnabled({ paused: true })).toBe(false);
    expect(inferCronEnabled({ paused: false })).toBe(true);
  });

  it('status:disabled -> disabled', () => {
    expect(inferCronEnabled({ status: 'disabled' })).toBe(false);
    expect(inferCronEnabled({ status: 'paused' })).toBe(false);
    expect(inferCronEnabled({ status: 'stopped' })).toBe(false);
    expect(inferCronEnabled({ status: 'active' })).toBe(true);
  });

  it('state:paused -> disabled', () => {
    expect(inferCronEnabled({ state: 'paused' })).toBe(false);
  });

  it('returns true when no signal present', () => {
    expect(inferCronEnabled({})).toBe(true);
  });
});

describe('sourceFromJobName', () => {
  it('strips keryx- prefix', () => {
    expect(sourceFromJobName('keryx-email')).toBe('email');
    expect(sourceFromJobName('keryx-my-collector')).toBe('my-collector');
  });

  it('returns name unchanged when no prefix', () => {
    expect(sourceFromJobName('other-job')).toBe('other-job');
    expect(sourceFromJobName('keryx')).toBe('keryx');
  });
});
