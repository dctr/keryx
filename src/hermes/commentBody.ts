import type { KanbanComment } from './types';

// Parses a Kanban comment body as JSON, or null when the body is absent or not
// valid JSON. Used by the read-side aggregators (track record, digest, metrics,
// default-resolve) to scan machine-written decision/outcome comments. Returning
// null for non-matching bodies is intentional: these are best-effort scans over
// a mixed comment stream, NOT the card-body validation path (which must surface
// malformed bodies to the caller).
export function parseCommentBody(comment: KanbanComment): unknown {
  if (typeof comment.body !== 'string') return null;
  try {
    return JSON.parse(comment.body) as unknown;
  } catch {
    return null;
  }
}
