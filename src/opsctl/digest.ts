// Keryx digest composer (PRD §7.6). Pure read-side projection: turn silently-executed
// outcomes into one relevancy-grouped message. It never executes, waits, or asks for
// decisions. The job (digest command) reads outcomes from keryx.outcome.v1 comments,
// composes here, and (Phase 6) sends via `hermes send`; `--preview` renders only.
//
// Discipline borrowed from daily-brief / weekly-brief: omit empty categories; if there
// is nothing to report, the whole digest is `[SILENT]` and nothing is sent.

import type { KanbanTask } from '../hermes/types';
import { parseCommentBody } from '../hermes/commentBody';
import { validateOutcome } from '../schemas/outcome';

export type DigestCadence = 'daily' | 'weekly';

export interface DigestOutcome {
  digest_category: string | null;
  result_summary: string;
  result_delivery: 'digest' | 'push' | 'log_only';
  digest_cadence?: DigestCadence;
  changed_state: string | null;
  digested?: boolean;
}

export interface ComposeDigestOptions {
  cadence: DigestCadence;
  // Relevancy priority for category headers; categories not listed fall to the end,
  // ordered alphabetically among themselves.
  categoryOrder?: string[];
  // Used when an outcome has no digest_category.
  defaultCategory?: string;
}

export interface DigestCategory {
  category: string;
  lines: string[];
}

export interface DigestResult {
  silent: boolean;
  message: string;
  categories: DigestCategory[];
}

const DEFAULT_CATEGORY = 'Done for you';

// Reportable = digest delivery, matching cadence (missing cadence defaults to daily),
// and not already reported.
function isReportable(outcome: DigestOutcome, cadence: DigestCadence): boolean {
  if (outcome.result_delivery !== 'digest') return false;
  if (outcome.digested === true) return false;
  return (outcome.digest_cadence ?? 'daily') === cadence;
}

export function composeDigest(outcomes: DigestOutcome[], options: ComposeDigestOptions): DigestResult {
  const order = options.categoryOrder ?? [];
  const defaultCategory = options.defaultCategory ?? DEFAULT_CATEGORY;

  const byCategory = new Map<string, string[]>();
  for (const outcome of outcomes) {
    if (!isReportable(outcome, options.cadence)) continue;
    const category = outcome.digest_category ?? defaultCategory;
    const lines = byCategory.get(category) ?? [];
    lines.push(outcome.result_summary);
    byCategory.set(category, lines);
  }

  // Precompute a Map once so the comparator is O(1) per call instead of O(n).
  const orderMap = new Map(order.map((cat, i) => [cat, i]));
  const categories: DigestCategory[] = [...byCategory.entries()]
    .map(([category, lines]) => ({ category, lines }))
    .sort((left, right) => compareCategories(left.category, right.category, orderMap));

  if (categories.length === 0) {
    return { silent: true, message: '[SILENT]', categories: [] };
  }

  const message = categories
    .map((category) => [headerFor(category.category), ...category.lines.map((line) => `• ${line}`)].join('\n'))
    .join('\n\n');

  return { silent: false, message, categories };
}

// Listed categories sort by their position in the relevancy order; unlisted ones come
// after, ordered alphabetically. Emoji/labels are preserved as-is.
function compareCategories(left: string, right: string, orderMap: Map<string, number>): number {
  const leftRank = orderMap.get(left) ?? Number.POSITIVE_INFINITY;
  const rightRank = orderMap.get(right) ?? Number.POSITIVE_INFINITY;
  if (leftRank !== rightRank) return leftRank - rightRank;
  return left.localeCompare(right);
}

// A category header is the category text upper-cased, preserving any leading emoji/glyph
// prefix (which uppercases to itself). Modeled on daily-brief section headers.
function headerFor(category: string): string {
  return category.toUpperCase();
}

// Reads valid keryx.outcome.v1 comment bodies off the supplied tasks. Malformed or
// non-outcome comments are skipped (they belong to other contracts).
export function extractOutcomes(tasks: KanbanTask[]): DigestOutcome[] {
  const outcomes: DigestOutcome[] = [];
  for (const task of tasks) {
    for (const comment of task.comments ?? []) {
      const body = parseCommentBody(comment);
      if (body === null) continue;
      const validation = validateOutcome(body);
      if (!validation.ok) continue;
      const value = validation.value;
      outcomes.push({
        digest_category: value.digest_category,
        result_summary: value.result_summary,
        result_delivery: value.result_delivery,
        ...(value.digest_cadence ? { digest_cadence: value.digest_cadence } : {}),
        changed_state: value.changed_state,
        ...(value.digested === true ? { digested: true } : {}),
      });
    }
  }
  return outcomes;
}

