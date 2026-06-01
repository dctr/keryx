<script lang="ts">
  import { onMount } from 'svelte';

  import { dismissTask, executeTask, fetchSources, fetchTasks, type ApiTask, type SourceStatus } from './lib/api';
  import {
    applyTaskFilters,
    autonomyOptions,
    countTasksForView,
    type AutonomyFilter,
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

  type PendingAction = 'execute' | 'dismiss';

  let tasks: ApiTask[] = [];
  let malformedCards: MalformedTaskView[] = [];
  let sources: SourceStatus[] = [];
  let loading = true;
  let refreshing = false;
  let errorMessage: string | null = null;
  let lastUpdated: Date | null = null;

  let view: TaskViewKey = 'inbox';
  let source: SourceFilter = 'all';
  let autonomy: AutonomyFilter = 'all';
  let urgentOnly = false;

  let feedbackByTask: Record<string, string> = {};
  let selectedOptionByTask: Record<string, string> = {};
  let pendingByTask: Record<string, PendingAction | undefined> = {};

  $: taskViews = tasks.map(mapTaskToView);
  $: filteredTasks = applyTaskFilters(taskViews, { view, source, autonomy, urgentOnly });
  $: sourceOptions = buildSourceOptions(taskViews, sources);

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
      syncSelectedOptions(tasks.map(mapTaskToView));
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  function syncSelectedOptions(views: TaskCardView[]): void {
    const nextSelections = { ...selectedOptionByTask };
    for (const task of views) {
      const selected = nextSelections[task.id];
      if (!selected || !task.options.some((option) => option.id === selected)) {
        const primary = task.primaryOption ?? task.options[0];
        if (primary) {
          nextSelections[task.id] = primary.id;
        }
      }
    }
    selectedOptionByTask = nextSelections;
  }

  function selectedOptionId(task: TaskCardView): string | null {
    return selectedOptionByTask[task.id] ?? task.primaryOption?.id ?? task.options[0]?.id ?? null;
  }

  function selectedOption(task: TaskCardView): ActionOption | null {
    const optionId = selectedOptionId(task);
    return task.options.find((option) => option.id === optionId) ?? task.primaryOption ?? task.options[0] ?? null;
  }

  function selectOption(taskId: string, optionId: string): void {
    selectedOptionByTask = { ...selectedOptionByTask, [taskId]: optionId };
  }

  function setFeedback(taskId: string, event: Event): void {
    const target = event.currentTarget as HTMLTextAreaElement;
    feedbackByTask = { ...feedbackByTask, [taskId]: target.value };
  }

  async function handleExecute(task: TaskCardView): Promise<void> {
    const optionId = selectedOptionId(task);
    if (!optionId) {
      errorMessage = `No option selected for ${task.title}.`;
      return;
    }

    pendingByTask = { ...pendingByTask, [task.id]: 'execute' };
    errorMessage = null;
    try {
      const response = await executeTask(task.id, optionId, feedbackByTask[task.id] ?? '');
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

      <label>
        Autonomy
        <select aria-label="Autonomy" bind:value={autonomy}>
          {#each autonomyOptions as option (option.value)}
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
            <span>{task.autonomyLabel}</span>
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

          {#if task.options.length > 0}
            <section class="options" aria-label={`Options for ${task.title}`}>
              <p>Options</p>
              <div class="option-buttons">
                {#each task.options as option (option.id)}
                  <button
                    class:selected={selectedOptionId(task) === option.id}
                    type="button"
                    aria-pressed={selectedOptionId(task) === option.id}
                    onclick={() => selectOption(task.id, option.id)}
                  >
                    {option.label}
                  </button>
                {/each}
              </div>
            </section>

            <label class="feedback">
              Feedback for {task.title}
              <textarea
                aria-label={`Feedback for ${task.title}`}
                placeholder={selectedOption(task)?.input_hint ?? 'Optional feedback, instruction, or dismissal reason'}
                value={feedbackByTask[task.id] ?? ''}
                oninput={(event) => setFeedback(task.id, event)}
              ></textarea>
            </label>

            <div class="task-actions">
              <button
                class="primary"
                type="button"
                disabled={pendingByTask[task.id] !== undefined || selectedOptionId(task) === null}
                onclick={() => handleExecute(task)}
              >
                {pendingByTask[task.id] === 'execute' ? 'Executing…' : `Execute ${task.title}`}
              </button>
              <button class="danger" type="button" disabled={pendingByTask[task.id] !== undefined} onclick={() => handleDismiss(task)}>
                {pendingByTask[task.id] === 'dismiss' ? 'Dismissing…' : `Dismiss ${task.title}`}
              </button>
            </div>
          {:else}
            <p class="empty-options">No executable options on this card.</p>
          {/if}
        </article>
      {/each}
    {/if}
  </section>
</main>
