import { describe, expect, it } from 'vitest';

import {
  buildNotification,
  composeInterruptMessage,
  countInterruptsSentToday,
  decideInterruptDelivery,
  hasInterruptNotification,
  interruptDedupeKey,
  interruptTier,
  isWithinQuietHours,
} from '../../src/opsctl/interrupt';
import { validateNotification } from '../../src/schemas/notification';
import { sampleActionItem } from '../helpers/sampleActionItem';
import type { ActionItem } from '../../src/schemas/actionItem';
import type { KanbanTask } from '../../src/hermes/types';

function interruptCard(overrides: Partial<ActionItem> = {}): ActionItem {
  return sampleActionItem({
    title: 'Wire transfer authorisation needs review',
    urgency: 'urgent',
    proposed_disposition: 'interrupt',
    risk: 'Funds leave the account irreversibly if approved in error.',
    default_on_timeout: { action: 'dismiss', after: '15:00' },
    ...overrides,
  });
}

describe('composeInterruptMessage', () => {
  it('renders the PRD §9.2 layout with a hash-router deep link', () => {
    const message = composeInterruptMessage({
      taskId: 't_pay',
      card: interruptCard(),
      reason: 'absolute_floor=money -> never silent\ntime-pressured floor -> interrupt',
    });

    expect(message).toBe(
      [
        'Urgent: Wire transfer authorisation needs review',
        'Why: absolute_floor=money -> never silent time-pressured floor -> interrupt',
        'Risk if wrong: Funds leave the account irreversibly if approved in error.',
        'Default if no reply by 15:00: dismiss this card.',
        'Open in Keryx: /#/card/t_pay',
        'Reply: approve / change / hold',
      ].join('\n'),
    );
  });

  it('summarises an execute_option default using the referenced option label', () => {
    const card = interruptCard({
      default_on_timeout: { action: 'execute_option', option_id: 'translate_forward_contact_archive', after: '18:30' },
    });

    const message = composeInterruptMessage({ taskId: 't_fwd', card, reason: 'urgent+external -> interrupt' });

    expect(message).toContain('Default if no reply by 18:30: Translate + forward to support contact + archive email.');
  });

  it('falls back gracefully when risk and default_on_timeout are absent', () => {
    const card = interruptCard({ risk: null, default_on_timeout: null });

    const message = composeInterruptMessage({ taskId: 't_x', card, reason: '   ' });

    expect(message).toContain('Why: No reason recorded.');
    expect(message).toContain('Risk if wrong: Not specified.');
    expect(message).toContain('Default if no reply: none set.');
  });
});

describe('interruptTier + interruptDedupeKey', () => {
  it('maps urgency to a tier and a stable dedupe key', () => {
    expect(interruptTier('urgent')).toBe('urgent');
    expect(interruptTier('soon')).toBe('soon');
    expect(interruptTier('normal')).toBe('soon');
    expect(interruptDedupeKey('t_1', 'urgent')).toBe('keryx:interrupt:urgent:t_1');
  });
});

describe('isWithinQuietHours', () => {
  it('treats a wrap-around window as active across midnight', () => {
    const quiet = { start: '22:00', end: '07:00' };
    expect(isWithinQuietHours(new Date('2026-06-26T23:30:00'), quiet)).toBe(true);
    expect(isWithinQuietHours(new Date('2026-06-26T06:59:00'), quiet)).toBe(true);
    expect(isWithinQuietHours(new Date('2026-06-26T07:00:00'), quiet)).toBe(false);
    expect(isWithinQuietHours(new Date('2026-06-26T12:00:00'), quiet)).toBe(false);
  });

  it('handles a same-day window with inclusive start and exclusive end', () => {
    const quiet = { start: '09:00', end: '17:00' };
    expect(isWithinQuietHours(new Date('2026-06-26T09:00:00'), quiet)).toBe(true);
    expect(isWithinQuietHours(new Date('2026-06-26T16:59:00'), quiet)).toBe(true);
    expect(isWithinQuietHours(new Date('2026-06-26T17:00:00'), quiet)).toBe(false);
  });
});

describe('decideInterruptDelivery', () => {
  const now = new Date('2026-06-26T12:00:00');

  it('falls back to digest when no notify_target is configured', () => {
    const decision = decideInterruptDelivery({ urgency: 'urgent', sentTodayForTier: 0, now });
    expect(decision.deliver).toBe(false);
    expect(decision.reason).toContain('no notify_target');
  });

  it('delivers when target is set and within budget/quiet-hours', () => {
    const decision = decideInterruptDelivery({
      notifyTarget: 'telegram',
      urgency: 'soon',
      sentTodayForTier: 1,
      budget: { perTierPerDay: { soon: 4 } },
      now,
    });
    expect(decision.deliver).toBe(true);
  });

  it('suppresses a non-urgent interrupt during quiet hours but lets urgent through', () => {
    const night = new Date('2026-06-26T23:30:00');
    const quietHours = { start: '22:00', end: '07:00' };

    const soon = decideInterruptDelivery({ notifyTarget: 'telegram', urgency: 'soon', sentTodayForTier: 0, quietHours, now: night });
    expect(soon.deliver).toBe(false);
    expect(soon.reason).toContain('quiet hours');

    const urgent = decideInterruptDelivery({ notifyTarget: 'telegram', urgency: 'urgent', sentTodayForTier: 0, quietHours, now: night });
    expect(urgent.deliver).toBe(true);
  });

  it('suppresses once the per-tier daily budget is exhausted', () => {
    const decision = decideInterruptDelivery({
      notifyTarget: 'telegram',
      urgency: 'urgent',
      sentTodayForTier: 8,
      budget: { perTierPerDay: { urgent: 8 } },
      now,
    });
    expect(decision.deliver).toBe(false);
    expect(decision.reason).toContain('budget');
  });
});

describe('buildNotification', () => {
  it('builds a schema-valid interrupt notification', () => {
    const notification = buildNotification({
      channel: 'interrupt',
      target: 'telegram',
      dedupeKey: 'keryx:interrupt:urgent:t_pay',
      now: new Date('2026-06-26T12:00:00.000Z'),
    });
    expect(validateNotification(notification).ok).toBe(true);
    expect(notification.sent_at).toBe('2026-06-26T12:00:00.000Z');
  });
});

describe('dedupe + budget counting over board tasks', () => {
  // sent_at must carry a timezone (notification schema), and the local-day comparison
  // must be deterministic regardless of the host TZ — so build instants from local
  // date parts and serialise via toISOString().
  function localInstant(dayOffset: number, hour: number, minute = 0): string {
    const base = new Date('2026-06-26T12:00:00');
    return new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hour, minute).toISOString();
  }

  function notificationTask(id: string, dedupeKey: string, sentAt: string): KanbanTask {
    return {
      id,
      comments: [
        {
          body: JSON.stringify({
            schema: 'keryx.notification.v1',
            channel: 'interrupt',
            target: 'telegram',
            sent_at: sentAt,
            dedupe_key: dedupeKey,
          }),
        },
      ],
    };
  }

  it('detects an existing interrupt notification by dedupe key', () => {
    const task = notificationTask('t_pay', 'keryx:interrupt:urgent:t_pay', localInstant(0, 11));
    expect(hasInterruptNotification(task, 'keryx:interrupt:urgent:t_pay')).toBe(true);
    expect(hasInterruptNotification(task, 'keryx:interrupt:soon:t_pay')).toBe(false);
  });

  it('counts only same-day interrupts of the requested tier', () => {
    const now = new Date('2026-06-26T12:00:00');
    const tasks = [
      notificationTask('t_a', 'keryx:interrupt:urgent:t_a', localInstant(0, 8)),
      notificationTask('t_b', 'keryx:interrupt:urgent:t_b', localInstant(0, 9, 30)),
      notificationTask('t_c', 'keryx:interrupt:soon:t_c', localInstant(0, 9, 30)),
      notificationTask('t_old', 'keryx:interrupt:urgent:t_old', localInstant(-1, 9, 30)),
    ];
    expect(countInterruptsSentToday(tasks, 'urgent', now)).toBe(2);
    expect(countInterruptsSentToday(tasks, 'soon', now)).toBe(1);
  });
});
