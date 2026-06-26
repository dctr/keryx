import { firstString, isPlainObject } from '../util/object';

export function cronJobCandidates(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isPlainObject(value)) return [];
  for (const key of ['jobs', 'cron_jobs', 'items', 'results']) {
    if (Array.isArray(value[key])) return value[key] as unknown[];
  }
  return Object.values(value).flatMap((entry) => (Array.isArray(entry) ? entry : []));
}

export function inferCronEnabled(value: Record<string, unknown>): boolean {
  if (typeof value.enabled === 'boolean') return value.enabled;
  if (typeof value.paused === 'boolean') return !value.paused;
  const status = firstString(value.status, value.state);
  if (status) return !['paused', 'disabled', 'stopped'].includes(status.toLowerCase());
  return true;
}

export function sourceFromJobName(name: string): string {
  return name.startsWith('keryx-') ? name.slice('keryx-'.length) : name;
}
