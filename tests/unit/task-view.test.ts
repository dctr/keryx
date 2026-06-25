import { describe, expect, it } from 'vitest';

import type { ActionItem } from '../../src/schemas/actionItem';
import type { ApiTask, MalformedTaskError } from '../../src/web/lib/api';
import { mapMalformedTaskError, mapTaskToView, sortTaskViews, statusLabelFor } from '../../src/web/lib/taskView';
import { sampleActionItem } from '../helpers/sampleActionItem';

const baseActionItem: ActionItem = sampleActionItem({
  options: [
    {
      id: 'translate_forward_contact_archive',
      label: 'Translate + forward to support contact + archive email',
      requires_input: false,
      input_hint: null,
      delivery: null,
      reversibility: 'reversible',
      blast_radius: 'external',
      undo_prompt: 'Restore the archived email and retract the forward.',
      execution_prompt:
        "Translate the support request into the target language, forward it to the configured support contact, then archive the source email.",
    },
    {
      id: 'reply_only',
      label: 'Draft a short reply only',
      requires_input: true,
      input_hint: 'Add the tone you want.',
      delivery: 'default',
      reversibility: 'reversible',
      blast_radius: 'self',
      undo_prompt: 'Delete the drafted reply before it is sent.',
      execution_prompt: 'Draft a concise reply and deliver it to the configured Keryx channel.',
    },
  ],
  ui: { primary_option_id: 'reply_only', display_group: 'Needs input' },
});

describe('task view mapping', () => {
  it('maps Kanban statuses to compact user-facing labels', () => {
    expect(statusLabelFor('blocked')).toBe('Needs User');
    expect(statusLabelFor('todo')).toBe('Needs User');
    expect(statusLabelFor('ready')).toBe('Queued');
    expect(statusLabelFor('running')).toBe('Running');
    expect(statusLabelFor('done')).toBe('Completed');
    expect(statusLabelFor('archived')).toBe('Dismissed');
  });

  it('sorts urgent cards first, then by earliest deadline', () => {
    const normal = mapTaskToView(task('t_normal', { urgency: 'normal', deadline: null, title: 'Normal task' }));
    const soonLater = mapTaskToView(task('t_soon_later', { urgency: 'soon', deadline: '2026-06-03T10:00:00+10:00', title: 'Soon later' }));
    const urgent = mapTaskToView(task('t_urgent', { urgency: 'urgent', deadline: '2026-06-04T10:00:00+10:00', title: 'Urgent task' }));
    const soonEarlier = mapTaskToView(task('t_soon_earlier', { urgency: 'soon', deadline: '2026-06-01T10:00:00+10:00', title: 'Soon earlier' }));

    expect(sortTaskViews([normal, soonLater, urgent, soonEarlier]).map((view) => view.id)).toEqual([
      't_urgent',
      't_soon_earlier',
      't_soon_later',
      't_normal',
    ]);
  });

  it('preserves malformed cards as visible warning rows', () => {
    const malformed: MalformedTaskError = {
      task_id: 't_bad',
      title: 'Bad action',
      status: 'blocked',
      error: 'task body is not valid JSON: unexpected token',
    };

    expect(mapMalformedTaskError(malformed)).toMatchObject({
      id: 't_bad',
      title: 'Bad action',
      statusLabel: 'Needs User',
      malformed: true,
      summary: 'task body is not valid JSON: unexpected token',
    });
  });

  it('selects the collector-suggested primary option and falls back to the first option', () => {
    const preferred = mapTaskToView(task('t_preferred'));
    const fallback = mapTaskToView(task('t_fallback', { ui: { primary_option_id: 'missing' } }));

    expect(preferred.primaryOption?.id).toBe('reply_only');
    expect(preferred.primaryOption?.label).toBe('Draft a short reply only');
    expect(fallback.primaryOption?.id).toBe('translate_forward_contact_archive');
  });
});

function task(id: string, overrides: Partial<ActionItem> = {}): ApiTask {
  const actionItem: ActionItem = { ...baseActionItem, ...overrides };
  return {
    id,
    title: actionItem.title,
    status: 'blocked',
    source: actionItem.source,
    tenant: actionItem.source,
    created_by: actionItem.collector,
    action_item: actionItem,
  };
}
