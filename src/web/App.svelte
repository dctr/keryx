<script lang="ts">
  import { onMount } from 'svelte';

  import {
    dismissTask,
    executeTask,
    fetchMetrics,
    fetchPolicy,
    fetchSources,
    fetchTasks,
    markReviewed,
    recordRegret,
    revokePolicyRule,
    undoTask,
    type ApiTask,
    type MetricsResponse,
    type PolicyResponse,
    type RegretKind,
    type SourceStatus,
  } from './lib/api';
  import {
    applyTaskFilters,
    countTasksForView,
    type SourceFilter,
    type TaskViewKey,
    viewOptions,
  } from './lib/filters';
  import {
    mapMalformedTaskError,
    mapTaskToView,
    sourceLabel,
    type MalformedTaskView,
    type TaskCardView,
  } from './lib/taskView';
  import type { ActionOption } from '../schemas/actionItem';

  type PendingAction =
    | 'execute'
    | 'dismiss'
    | 'regret-acted'
    | 'regret-asked'
    | 'review-undo'
    | 'review-archive';

  let tasks: ApiTask[] = [];
  let malformedCards: MalformedTaskView[] = [];
  let sources: SourceStatus[] = [];
  let loading = true;
  let refreshing = false;
  let errorMessage: string | null = null;
  let lastUpdated: Date | null = null;

  let view: TaskViewKey = 'needsYou';
  let source: SourceFilter = 'all';
  let urgentOnly = false;

  let feedbackByTask: Record<string, string> = {};
  let pendingByTask: Record<string, PendingAction | undefined> = {};

  let policy: PolicyResponse | null = null;
  let policyCollector = '';
  let policyError: string | null = null;
  let policyLoading = false;
  let revokingRuleId: string | null = null;

  let metrics: MetricsResponse | null = null;
  let metricsWindow = '';
  let metricsError: string | null = null;
  let metricsLoading = false;

  $: taskViews = tasks.map(mapTaskToView);
  $: filteredTasks = applyTaskFilters(taskViews, { view, source, urgentOnly });
  $: sourceOptions = buildSourceOptions(taskViews, sources);
  $: collectorOptions = buildCollectorOptions(tasks, sources);

  onMount(() => {
    void refreshDashboard();
    const interval = window.setInterval(() => void refreshDashboard({ silent: true }), pollIntervalMs());
    return () => window.clearInterval(interval);
  });

  async function refreshDashboard(options: { silent?: boolean } = {}): Promise<void> {
    if (!options.silent) {
      refreshing = true;
    }
    loading = tasks.length === 0;
    errorMessage = null;

    try {
      const [taskResponse, sourceResponse] = await Promise.all([fetchTasks(), fetchSources()]);
      tasks = taskResponse.tasks;
      malformedCards = taskResponse.errors.map(mapMalformedTaskError);
      sources = sourceResponse.sources;
      lastUpdated = new Date();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  function setFeedback(taskId: string, event: Event): void {
    const target = event.currentTarget as HTMLTextAreaElement;
    feedbackByTask = { ...feedbackByTask, [taskId]: target.value };
  }

  function optionNeedsFeedback(option: ActionOption, feedback: string): boolean {
    return option.requires_input && feedback.trim().length === 0;
  }

  function feedbackPlaceholder(task: TaskCardView): string {
    return task.primaryOption?.input_hint ?? task.options.find((option) => option.input_hint)?.input_hint ?? 'Optional feedback, instruction, or dismissal reason';
  }

  async function handleExecute(task: TaskCardView, option: ActionOption): Promise<void> {
    if (optionNeedsFeedback(option, feedbackByTask[task.id] ?? '')) {
      errorMessage = `Feedback is required for ${option.label}.`;
      return;
    }

    pendingByTask = { ...pendingByTask, [task.id]: 'execute' };
    errorMessage = null;
    try {
      const response = await executeTask(task.id, option.id, feedbackByTask[task.id] ?? '');
      updateTaskStatus(task.id, response.status ?? 'ready');
      feedbackByTask = { ...feedbackByTask, [task.id]: '' };
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      pendingByTask = { ...pendingByTask, [task.id]: undefined };
    }
  }

  async function handleDismiss(task: TaskCardView): Promise<void> {
    pendingByTask = { ...pendingByTask, [task.id]: 'dismiss' };
    errorMessage = null;
    try {
      const response = await dismissTask(task.id, feedbackByTask[task.id] ?? '');
      updateTaskStatus(task.id, response.status ?? 'archived');
      feedbackByTask = { ...feedbackByTask, [task.id]: '' };
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      pendingByTask = { ...pendingByTask, [task.id]: undefined };
    }
  }

  function updateTaskStatus(taskId: string, status: string): void {
    tasks = tasks.map((task) => (task.id === taskId ? { ...task, status } : task));
  }

  function taskCount(viewKey: TaskViewKey): number {
    return countTasksForView(taskViews, viewKey);
  }

  function buildSourceOptions(taskCards: TaskCardView[], sourceStatuses: SourceStatus[]): Array<{ value: string; label: string }> {
    const values = new Set<string>();
    for (const task of taskCards) {
      values.add(task.source);
    }
    for (const status of sourceStatuses) {
      values.add(status.source);
    }
    return [...values].sort().map((value) => ({ value, label: sourceLabel(value) }));
  }

  function buildCollectorOptions(taskList: ApiTask[], sourceStatuses: SourceStatus[]): string[] {
    const values = new Set<string>();
    for (const task of taskList) {
      if (task.created_by) {
        values.add(task.created_by);
      }
      if (task.action_item?.collector) {
        values.add(task.action_item.collector);
      }
    }
    for (const status of sourceStatuses) {
      if (status.name) {
        values.add(status.name);
      }
    }
    return [...values].sort();
  }

  async function loadPolicy(): Promise<void> {
    const collector = policyCollector.trim();
    if (!collector) {
      policyError = 'Choose a collector to inspect its policy.';
      return;
    }
    policyLoading = true;
    policyError = null;
    try {
      policy = await fetchPolicy(collector);
    } catch (error) {
      policy = null;
      policyError = error instanceof Error ? error.message : String(error);
    } finally {
      policyLoading = false;
    }
  }

  async function handleRevokeRule(ruleId: string): Promise<void> {
    if (!policy) {
      return;
    }
    revokingRuleId = ruleId;
    policyError = null;
    try {
      await revokePolicyRule(policy.collector, ruleId);
      // Revocation is an approval-gated suggestion card, not an in-place edit; reload the
      // dashboard so the new card appears in the inbox and reflect that the rule still stands.
      await refreshDashboard({ silent: true });
    } catch (error) {
      policyError = error instanceof Error ? error.message : String(error);
    } finally {
      revokingRuleId = null;
    }
  }

  async function loadMetrics(): Promise<void> {
    metricsLoading = true;
    metricsError = null;
    try {
      metrics = await fetchMetrics(metricsWindow);
    } catch (error) {
      metrics = null;
      metricsError = error instanceof Error ? error.message : String(error);
    } finally {
      metricsLoading = false;
    }
  }

  async function handleRegret(task: TaskCardView, kind: RegretKind): Promise<void> {
    const pendingKind: PendingAction = kind === 'should_have_acted' ? 'regret-acted' : 'regret-asked';
    pendingByTask = { ...pendingByTask, [task.id]: pendingKind };
    errorMessage = null;
    try {
      await recordRegret(task.id, kind, feedbackByTask[task.id] ?? '');
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      pendingByTask = { ...pendingByTask, [task.id]: undefined };
    }
  }

  // Honest undo (PRD §7.4, D3): the server reads the executed option's reversibility and
  // creates the appropriate reversal / labeled-correction / corrective-triage card. That
  // new card lands in the inbox, so refresh rather than mutating this done card's status.
  async function handleUndo(task: TaskCardView): Promise<void> {
    pendingByTask = { ...pendingByTask, [task.id]: 'review-undo' };
    errorMessage = null;
    try {
      await undoTask(task.id);
      await refreshDashboard({ silent: true });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      pendingByTask = { ...pendingByTask, [task.id]: undefined };
    }
  }

  // Archive (mark-reviewed) a done review-log card so it leaves the review log.
  async function handleArchive(task: TaskCardView): Promise<void> {
    pendingByTask = { ...pendingByTask, [task.id]: 'review-archive' };
    errorMessage = null;
    try {
      const response = await markReviewed(task.id);
      updateTaskStatus(task.id, response.status ?? 'archived');
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      pendingByTask = { ...pendingByTask, [task.id]: undefined };
    }
  }

  // The review log offers honest undo only when the executed option's reversibility admits
  // one (reversible -> Undo; compensable -> Correct). read_only/irreversible options show no
  // undo affordance — there is nothing to reverse, or no honest reversal exists.
  function undoLabelFor(task: TaskCardView): string | null {
    if (task.reversibility === 'reversible') {
      return 'Undo';
    }
    if (task.reversibility === 'compensable') {
      return 'Correct';
    }
    return null;
  }

  function formatPercent(value: number | null): string {
    return value === null ? '—' : `${Math.round(value * 100)}%`;
  }

  function sourceStatusDetail(status: SourceStatus): string {
    if (status.last_error) {
      return status.last_error;
    }
    if (status.last_delivery_error) {
      return status.last_delivery_error;
    }
    if (status.last_run_at) {
      return `last run ${formatDateTime(status.last_run_at)}`;
    }
    if (status.next_run_at) {
      return `next run ${formatDateTime(status.next_run_at)}`;
    }
    return status.enabled ? 'waiting for first run' : 'paused';
  }

  function formatDateTime(value: string): string {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) {
      return value;
    }
    return new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
  }

  function pollIntervalMs(): number {
    const override = (window as Window & { __KERYX_POLL_INTERVAL_MS?: number }).__KERYX_POLL_INTERVAL_MS;
    return typeof override === 'number' && Number.isFinite(override) && override > 0 ? override : 30_000;
  }
</script>

<main class="app-shell" aria-labelledby="page-title">
  <header class="topbar">
    <div>
      <p class="eyebrow">Hermes Kanban action inbox</p>
      <h1 id="page-title">Keryx</h1>
      <p class="lede">Review, approve, and track structured personal operations actions without leaving the Kanban audit trail.</p>
    </div>
    <div class="refresh-panel">
      <button class="secondary" type="button" onclick={() => refreshDashboard()} disabled={refreshing}>
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
      {#if lastUpdated}
        <small>Updated {formatDateTime(lastUpdated.toISOString())}</small>
      {:else}
        <small>Polling every 30s</small>
      {/if}
    </div>
  </header>

  {#if errorMessage}
    <section class="error-banner" role="status">{errorMessage}</section>
  {/if}

  <section class="source-strip" aria-label="Source status" data-testid="source-status-strip">
    {#if sources.length === 0}
      <article class="source-pill muted">
        <strong>No collectors</strong>
        <span>no keryx-* cron jobs reported</span>
      </article>
    {:else}
      {#each sources as status (status.name)}
        <article class={`source-pill source-${status.status.toLowerCase()}`}>
          <span>{sourceLabel(status.source)}</span>
          <strong>{status.status}</strong>
          <small>{sourceStatusDetail(status)}</small>
        </article>
      {/each}
    {/if}
  </section>

  <section class="controls" aria-label="Inbox controls">
    <nav class="views" aria-label="Task views">
      {#each viewOptions as option (option.key)}
        <button class:active={view === option.key} type="button" aria-pressed={view === option.key} onclick={() => (view = option.key)}>
          <span>{option.label}</span>
          <strong>{taskCount(option.key)}</strong>
        </button>
      {/each}
    </nav>

    <div class="filters">
      <label>
        Source
        <select aria-label="Source" bind:value={source}>
          <option value="all">All sources</option>
          {#each sourceOptions as option (option.value)}
            <option value={option.value}>{option.label}</option>
          {/each}
        </select>
      </label>

      <label class="inline-check">
        <input type="checkbox" bind:checked={urgentOnly} />
        Urgent / deadline soon
      </label>
    </div>
  </section>

  {#if malformedCards.length > 0}
    <section class="malformed" role="alert" aria-live="polite">
      <h2>Malformed cards</h2>
      <p>These Keryx cards could not be parsed and should be fixed at the collector/source.</p>
      <div class="malformed-list">
        {#each malformedCards as card (card.id)}
          <article>
            <strong>{card.title}</strong>
            <span>{card.statusLabel}</span>
            <p>{card.summary}</p>
          </article>
        {/each}
      </div>
    </section>
  {/if}

  <section class="task-list" aria-label={`${view} tasks`}>
    {#if loading}
      <p class="empty-state">Loading Keryx cards…</p>
    {:else if filteredTasks.length === 0}
      <p class="empty-state">No tasks in this view.</p>
    {:else}
      {#each filteredTasks as task (task.id)}
        <article class="task-card" data-testid={`task-card-${task.id}`}>
          <header class="task-header">
            <div>
              <p class="origin">{task.origin}</p>
              <h2>{task.title}</h2>
            </div>
            <span class={`status-badge tone-${task.statusTone}`}>{task.statusLabel}</span>
          </header>

          <div class="badge-row">
            <span>{task.sourceLabel}</span>
            {#if task.reversibility}
              <span>{task.reversibility}</span>
            {/if}
            {#if task.blastRadius}
              <span>{task.blastRadius}</span>
            {/if}
            {#if task.dispositionLabel}
              <span class="badge-disposition">{task.dispositionLabel}</span>
            {/if}
            {#if task.confidenceLabel}
              <span class="badge-confidence">{task.confidenceLabel}</span>
            {/if}
            <span>{task.urgencyLabel}</span>
            <span>{task.deadlineLabel}</span>
            {#if task.displayGroup}
              <span>{task.displayGroup}</span>
            {/if}
          </div>

          <p class="summary">{task.summary}</p>
          {#if task.risk}
            <p class="risk"><strong>Risk:</strong> {task.risk}</p>
          {/if}

          {#if task.outcomeSummary}
            <p class="outcome"><strong>Outcome:</strong> {task.outcomeSummary}</p>
          {/if}

          {#if task.status === 'done'}
            {@const undoLabel = undoLabelFor(task)}
            <div class="task-actions review-log-actions">
              {#if undoLabel}
                <button
                  class="secondary undo"
                  type="button"
                  data-testid={`undo-${task.id}`}
                  disabled={pendingByTask[task.id] !== undefined}
                  title={task.reversibility === 'compensable'
                    ? 'Send a labeled correction; a compensable action cannot be unsent.'
                    : 'Reverse this reversible action and restore the prior state.'}
                  onclick={() => handleUndo(task)}
                >
                  {pendingByTask[task.id] === 'review-undo' ? 'Working…' : undoLabel}
                </button>
              {/if}
              <button
                class="secondary archive"
                type="button"
                data-testid={`archive-${task.id}`}
                disabled={pendingByTask[task.id] !== undefined}
                title="Mark this reviewed and archive it out of the review log."
                onclick={() => handleArchive(task)}
              >
                {pendingByTask[task.id] === 'review-archive' ? 'Archiving…' : 'Archive'}
              </button>
              <button
                class="secondary regret"
                type="button"
                data-testid={`regret-acted-${task.id}`}
                disabled={pendingByTask[task.id] !== undefined}
                title="Flag that Keryx should have acted (or acted sooner) on this."
                onclick={() => handleRegret(task, 'should_have_acted')}
              >
                {pendingByTask[task.id] === 'regret-acted' ? 'Recording…' : 'Should have acted'}
              </button>
              <button
                class="secondary regret"
                type="button"
                data-testid={`regret-asked-${task.id}`}
                disabled={pendingByTask[task.id] !== undefined}
                title="Flag that Keryx should have asked first instead of acting silently."
                onclick={() => handleRegret(task, 'should_have_asked')}
              >
                {pendingByTask[task.id] === 'regret-asked' ? 'Recording…' : 'Should have asked'}
              </button>
            </div>
          {:else if task.options.length > 0}
            <div class="feedback">
              <textarea
                aria-label={`Feedback for ${task.title}`}
                placeholder={feedbackPlaceholder(task)}
                value={feedbackByTask[task.id] ?? ''}
                oninput={(event) => setFeedback(task.id, event)}
              ></textarea>
            </div>

            <div class="task-actions">
              {#each task.options as option (option.id)}
                <button
                  class="primary"
                  type="button"
                  disabled={pendingByTask[task.id] !== undefined || optionNeedsFeedback(option, feedbackByTask[task.id] ?? '')}
                  onclick={() => handleExecute(task, option)}
                >
                  {pendingByTask[task.id] === 'execute' ? 'Executing…' : option.label}
                </button>
              {/each}
              <button class="danger" type="button" disabled={pendingByTask[task.id] !== undefined} onclick={() => handleDismiss(task)}>
                {pendingByTask[task.id] === 'dismiss' ? 'Dismissing…' : 'Dismiss'}
              </button>
            </div>
          {:else}
            <p class="empty-options">No executable options on this card.</p>
          {/if}
        </article>
      {/each}
    {/if}
  </section>

  <section class="insight-panels" aria-label="Policy and metrics">
    <article class="insight-panel" data-testid="policy-panel" aria-label="Policy">
      <header class="insight-header">
        <h2>Policy</h2>
        <div class="insight-controls">
          <label>
            Collector
            <select aria-label="Policy collector" bind:value={policyCollector}>
              <option value="">Choose a collector…</option>
              {#each collectorOptions as option (option)}
                <option value={option}>{option}</option>
              {/each}
            </select>
          </label>
          <button class="secondary" type="button" onclick={() => loadPolicy()} disabled={policyLoading || policyCollector.trim().length === 0}>
            {policyLoading ? 'Loading…' : 'Load policy'}
          </button>
        </div>
      </header>

      {#if policyError}
        <p class="insight-error" role="status">{policyError}</p>
      {:else if !policy}
        <p class="empty-state">Pick a collector to inspect its active and shadow rules.</p>
      {:else if policy.rules.length === 0}
        <p class="empty-state">{policy.exists ? `${policy.collector} has no rules yet.` : `${policy.collector} has no policy file yet.`}</p>
      {:else}
        <ul class="rule-list">
          {#each policy.rules as rule (rule.id)}
            <li class="rule" data-testid={`policy-rule-${rule.id}`}>
              <div class="rule-head">
                <span class={`rule-state rule-state-${rule.state}`}>{rule.state === 'active' ? 'Active' : 'Shadow'}</span>
                <strong>{rule.class}</strong>
                <span class="rule-disposition">{rule.disposition}</span>
                {#if policy.track_record[rule.class]}
                  <span class={`badge-confidence band-${policy.track_record[rule.class].band}`}>{policy.track_record[rule.class].band}</span>
                {/if}
              </div>
              {#if rule.scope_note}
                <p class="rule-note">{rule.scope_note}</p>
              {/if}
              <div class="rule-foot">
                <small>{rule.id} · ≤{rule.gate.max_blast_radius} · ≥{rule.gate.min_reversibility} · ≥{rule.gate.min_confidence}</small>
                <button
                  class="danger"
                  type="button"
                  data-testid={`revoke-rule-${rule.id}`}
                  disabled={revokingRuleId !== null}
                  onclick={() => handleRevokeRule(rule.id)}
                >
                  {revokingRuleId === rule.id ? 'Proposing…' : 'Revoke'}
                </button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </article>

    <article class="insight-panel" data-testid="metrics-panel" aria-label="Metrics">
      <header class="insight-header">
        <h2>Metrics</h2>
        <div class="insight-controls">
          <label>
            Window
            <input aria-label="Metrics window" placeholder="e.g. 7d" bind:value={metricsWindow} />
          </label>
          <button class="secondary" type="button" onclick={() => loadMetrics()} disabled={metricsLoading}>
            {metricsLoading ? 'Loading…' : 'Load metrics'}
          </button>
        </div>
      </header>

      {#if metricsError}
        <p class="insight-error" role="status">{metricsError}</p>
      {:else if !metrics}
        <p class="empty-state">Load attention-economics metrics derived from the Kanban audit trail.</p>
      {:else}
        <dl class="metric-grid">
          <div class="metric"><dt>Cards</dt><dd data-testid="metric-tasks">{metrics.counts.tasks}</dd></div>
          <div class="metric"><dt>Silent executions</dt><dd data-testid="metric-silent">{metrics.counts.silentExecutions}</dd></div>
          <div class="metric"><dt>Shadow would-have</dt><dd>{metrics.counts.shadowWouldHave}</dd></div>
          <div class="metric"><dt>Human approvals</dt><dd>{metrics.counts.humanApprovals}</dd></div>
          <div class="metric"><dt>Override rate</dt><dd data-testid="metric-override-rate">{formatPercent(metrics.overrideRate)}</dd></div>
          <div class="metric"><dt>Shadow agreement</dt><dd data-testid="metric-shadow-agreement">{formatPercent(metrics.shadowAgreementRate)}</dd></div>
          <div class="metric"><dt>Autonomous safe</dt><dd>{formatPercent(metrics.autonomousSafeCompletionRate)}</dd></div>
          <div class="metric"><dt>Silent failures</dt><dd data-testid="metric-silent-failures">{metrics.silentFailureCount}</dd></div>
          <div class="metric"><dt>Regrets</dt><dd>{metrics.counts.regrets}</dd></div>
          <div class="metric"><dt>Interrupts</dt><dd>{metrics.counts.interrupts}</dd></div>
        </dl>
      {/if}
    </article>
  </section>
</main>
