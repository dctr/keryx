import { expect, test, type Page } from '@playwright/test';

interface ApiTask {
  id: string;
  title: string;
  status: string;
  source: string;
  tenant: string;
  created_by: string;
  action_item: ActionItem;
}

interface ActionItem {
  schema: 'keryx.action_item.v2';
  source: string;
  collector: string;
  class: string;
  external_id: string;
  idempotency_key: string;
  origin_descriptor: string;
  title: string;
  summary: string;
  urgency: 'low' | 'normal' | 'soon' | 'urgent';
  deadline: string | null;
  risk: string | null;
  source_refs: Array<Record<string, string>>;
  options: Array<{
    id: string;
    label: string;
    requires_input: boolean;
    input_hint: string | null;
    delivery: string | null;
    reversibility: 'read_only' | 'reversible' | 'compensable' | 'irreversible';
    blast_radius: 'self' | 'external';
    undo_prompt?: string | null;
    execution_prompt: string;
  }>;
  ui?: { primary_option_id?: string; display_group?: string };
  created_at: string;
}

test('renders the action inbox and sends execute/dismiss requests to the API', async ({ page }) => {
  const api = await mockKeryxApi(page);
  await page.addInitScript(() => {
    (window as Window & { __KERYX_POLL_INTERVAL_MS?: number }).__KERYX_POLL_INTERVAL_MS = 80;
  });

  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Keryx' })).toBeVisible();
  await expect(page.getByTestId('source-status-strip')).toContainText('Email');
  await expect(page.getByTestId('source-status-strip')).toContainText('OK');
  await expect(page.getByTestId('source-status-strip')).toContainText('Events');
  await expect(page.getByTestId('source-status-strip')).toContainText('FAILED');

  for (const viewName of ['Inbox', 'Running', 'Completed', 'Dismissed']) {
    await expect(page.getByRole('button', { name: new RegExp(viewName) })).toBeVisible();
  }

  await page.getByRole('button', { name: /Running/ }).click();
  await expect(page.getByRole('heading', { name: 'Plan venue options for team planning session' })).toBeVisible();

  await page.getByRole('button', { name: /Completed/ }).click();
  await expect(page.getByRole('heading', { name: 'Renew passport reminder' })).toBeVisible();

  await page.getByRole('button', { name: /Dismissed/ }).click();
  await expect(page.getByRole('heading', { name: 'Old workshop listing' })).toBeVisible();

  await page.getByRole('button', { name: /Inbox/ }).click();
  const emailCard = page.getByTestId('task-card-t_email');
  await expect(emailCard.getByRole('heading', { name: 'Support request: account access needs review' })).toBeVisible();
  await expect(emailCard.getByText('Support Desk — Account access request')).toBeVisible();
  await expect(emailCard.getByText('Customer reports that account access is failing after a recent change.')).toBeVisible();
  await expect(emailCard.getByText('Support request may stall if ignored.')).toBeVisible();
  await expect(emailCard.getByText('Needs User')).toBeVisible();
  await expect(emailCard.getByText(/^Feedback for/)).toHaveCount(0);
  await expect(emailCard.getByLabel('Feedback for Support request: account access needs review')).toBeVisible();
  await expect(emailCard.getByRole('button', { name: 'Translate + forward to support contact + archive email' })).toBeEnabled();
  await expect(emailCard.getByRole('button', { name: 'Dismiss', exact: true })).toBeVisible();

  await expect(page.getByRole('alert')).toContainText('Malformed cards');
  await expect(page.getByRole('alert')).toContainText('Bad action');
  await expect(page.getByRole('alert')).toContainText('task body is not valid JSON');

  await page.getByLabel('Source', { exact: true }).selectOption('email');
  await expect(page.getByRole('heading', { name: 'Support request: account access needs review' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Workshop booking opportunity' })).toBeHidden();

  await page.getByLabel('Source', { exact: true }).selectOption('all');
  await page.getByLabel('Autonomy', { exact: true }).selectOption('minimal');
  await expect(page.getByRole('heading', { name: 'Workshop booking opportunity' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Support request: account access needs review' })).toBeHidden();

  await page.getByLabel('Autonomy', { exact: true }).selectOption('all');
  await page.getByLabel('Feedback for Support request: account access needs review').fill('Please be brief.');
  await page.getByRole('button', { name: 'Translate + forward to support contact + archive email' }).click();

  expect(api.executeRequests).toEqual([
    { taskId: 't_email', body: { option_id: 'translate_forward_contact_archive', feedback: 'Please be brief.' } },
  ]);
  await expect(page.getByRole('heading', { name: 'Support request: account access needs review' })).toBeHidden();

  await page.getByRole('button', { name: /Running/ }).click();
  await expect(page.getByRole('heading', { name: 'Support request: account access needs review' })).toBeVisible();
  await expect(page.getByTestId('task-card-t_email').getByText('Queued')).toBeVisible();

  await page.getByRole('button', { name: /Inbox/ }).click();
  const workshopCard = page.getByTestId('task-card-t_workshop');
  const workshopAction = workshopCard.getByRole('button', { name: 'Start booking in GUI browser' });
  const workshopFeedback = page.getByLabel('Feedback for Workshop booking opportunity');
  await expect(workshopAction).toBeDisabled();
  await workshopFeedback.click();
  await workshopFeedback.press('N');
  expect(await workshopAction.isEnabled()).toBe(true);
  await workshopFeedback.press('Control+A');
  await workshopFeedback.press('Backspace');
  expect(await workshopAction.isDisabled()).toBe(true);
  await workshopFeedback.fill('Not worth pursuing.');
  expect(await workshopAction.isEnabled()).toBe(true);
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();

  expect(api.dismissRequests).toEqual([{ taskId: 't_workshop', body: { reason: 'Not worth pursuing.' } }]);
  await page.getByRole('button', { name: /Dismissed/ }).click();
  await expect(page.getByRole('heading', { name: 'Workshop booking opportunity' })).toBeVisible();
  await expect(page.getByTestId('task-card-t_workshop').getByText('Dismissed')).toBeVisible();

  await expect.poll(() => api.taskFetches, { timeout: 2_000 }).toBeGreaterThan(1);
});

async function mockKeryxApi(page: Page) {
  let tasks = fixtureTasks();
  const executeRequests: Array<{ taskId: string; body: unknown }> = [];
  const dismissRequests: Array<{ taskId: string; body: unknown }> = [];
  let taskFetches = 0;

  await page.route('**/api/tasks', async (route) => {
    taskFetches += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        tasks,
        errors: [
          {
            task_id: 't_bad',
            title: 'Bad action',
            status: 'blocked',
            error: 'task body is not valid JSON: Unexpected token n',
          },
        ],
      }),
    });
  });

  await page.route('**/api/sources', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        sources: [
          {
            id: 'job_email',
            name: 'keryx-email',
            source: 'email',
            status: 'OK',
            enabled: true,
            schedule: 'every 10m',
            last_status: 'success',
            last_run_at: '2026-05-31T12:00:00.000Z',
          },
          {
            id: 'job_events',
            name: 'keryx-events',
            source: 'events',
            status: 'FAILED',
            enabled: true,
            schedule: 'every 2h',
            last_status: 'error',
            last_error: 'login required',
          },
        ],
      }),
    });
  });

  await page.route('**/api/tasks/*/execute', async (route) => {
    const taskId = route.request().url().match(/\/api\/tasks\/([^/]+)\/execute$/)?.[1] ?? 'unknown';
    const body = route.request().postDataJSON() as unknown;
    executeRequests.push({ taskId, body });
    tasks = tasks.map((task) => (task.id === taskId ? { ...task, status: 'ready' } : task));
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, task_id: taskId, status: 'ready', action: 'promoted' }),
    });
  });

  await page.route('**/api/tasks/*/dismiss', async (route) => {
    const taskId = route.request().url().match(/\/api\/tasks\/([^/]+)\/dismiss$/)?.[1] ?? 'unknown';
    const body = route.request().postDataJSON() as unknown;
    dismissRequests.push({ taskId, body });
    tasks = tasks.map((task) => (task.id === taskId ? { ...task, status: 'archived' } : task));
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, task_id: taskId, status: 'archived', action: 'archived' }),
    });
  });

  return {
    executeRequests,
    dismissRequests,
    get taskFetches() {
      return taskFetches;
    },
  };
}

function fixtureTasks(): ApiTask[] {
  return [
    task('t_email', 'blocked', {
      source: 'email',
      collector: 'keryx-email',
      class: 'email:support-request',
      title: 'Support request: account access needs review',
      summary: 'Customer reports that account access is failing after a recent change.',
      origin_descriptor: 'Support Desk — Account access request',
      urgency: 'normal',
      risk: 'Support request may stall if ignored.',
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
          execution_prompt: "Translate the support request into the target language, forward it to the configured support contact, then archive the source email.",
        },
      ],
      ui: { primary_option_id: 'translate_forward_contact_archive', display_group: 'Needs approval' },
    }),
    task('t_workshop', 'blocked', {
      source: 'events',
      collector: 'keryx-events',
      class: 'events:workshop-booking',
      title: 'Workshop booking opportunity',
      summary: 'A community workshop appears to have dates available.',
      origin_descriptor: 'Events feed — Workshop schedule announcement',
      urgency: 'soon',
      risk: 'Tickets may sell out.',
      options: [
        {
          id: 'start_booking_gui',
          label: 'Start booking in GUI browser',
          requires_input: true,
          input_hint: 'Type the date you want to book for.',
          delivery: null,
          reversibility: 'irreversible',
          blast_radius: 'external',
          undo_prompt: null,
          execution_prompt: 'Open the booking flow in the visible GUI browser and stop at payment/private input.',
        },
      ],
      ui: { primary_option_id: 'start_booking_gui', display_group: 'Needs input' },
    }),
    task('t_calendar', 'ready', {
      source: 'calendar',
      collector: 'keryx-calendar',
      class: 'calendar:venue-planning',
      title: 'Plan venue options for team planning session',
      summary: 'Calendar event has time but no venue logistics.',
      origin_descriptor: 'Mon 1 Jun, 6:30 pm — Team planning session',
      urgency: 'soon',
      deadline: '2026-06-01T18:30:00+10:00',
      risk: 'Leaving it unplanned creates avoidable friction.',
    }),
    task('t_done', 'done', {
      source: 'notion',
      collector: 'keryx-notion',
      class: 'notion:reminder',
      title: 'Renew passport reminder',
      summary: 'Passport renewal reminder has been handled.',
      origin_descriptor: 'Notion — admin list',
      urgency: 'low',
      risk: null,
    }),
    task('t_archived', 'archived', {
      source: 'events',
      collector: 'keryx-events',
      class: 'events:listing',
      title: 'Old workshop listing',
      summary: 'Archived old event listing.',
      origin_descriptor: 'Events feed — old listing',
      urgency: 'low',
      risk: null,
    }),
  ];
}

function task(id: string, status: string, overrides: Partial<ActionItem>): ApiTask {
  const source = overrides.source ?? 'email';
  const item: ActionItem = {
    schema: 'keryx.action_item.v2',
    source,
    collector: overrides.collector ?? `keryx-${source}`,
    class: overrides.class ?? `${source}:example`,
    external_id: `${source}:${id}`,
    idempotency_key: `keryx:${source}:${id}`,
    origin_descriptor: overrides.origin_descriptor ?? `${source} origin`,
    title: overrides.title ?? `${source} task`,
    summary: overrides.summary ?? `${source} summary`,
    urgency: overrides.urgency ?? 'normal',
    deadline: overrides.deadline ?? null,
    risk: overrides.risk ?? null,
    source_refs: overrides.source_refs ?? [{ type: source, id }],
    options:
      overrides.options ??
      [
        {
          id: 'approve',
          label: 'Approve action',
          requires_input: false,
          input_hint: null,
          delivery: null,
          reversibility: 'reversible',
          blast_radius: 'self',
          undo_prompt: 'Reverse the approved action.',
          execution_prompt: 'Execute the approved action.',
        },
      ],
    ui: overrides.ui ?? { primary_option_id: 'approve' },
    created_at: overrides.created_at ?? '2026-05-31T00:00:00+10:00',
  };

  return {
    id,
    title: item.title,
    status,
    source,
    tenant: source,
    created_by: item.collector,
    action_item: item,
  };
}
