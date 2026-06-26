import { describe, expect, it } from 'vitest';
import { parseCommentBody } from '../../src/hermes/commentBody';

describe('parseCommentBody', () => {
  it('parses JSON string bodies', () => {
    expect(parseCommentBody({ body: '{"a":1}' } as never)).toEqual({ a: 1 });
  });
  it('returns null for non-string body', () => {
    expect(parseCommentBody({ body: 42 } as never)).toBeNull();
  });
  it('returns null for invalid JSON (does not throw)', () => {
    expect(parseCommentBody({ body: 'not json' } as never)).toBeNull();
  });
});
