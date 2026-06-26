import { describe, expect, it } from 'vitest';
import { firstString, isNonEmptyString, isPlainObject } from '../../src/util/object';

describe('object util', () => {
  it('isPlainObject rejects arrays and null', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
  });

  it('firstString returns the first trimmed non-empty string', () => {
    expect(firstString(undefined, '  ', ' hello ', 'x')).toBe('hello');
    expect(firstString(1, null)).toBeUndefined();
  });

  it('isNonEmptyString checks trimmed length', () => {
    expect(isNonEmptyString(' a ')).toBe(true);
    expect(isNonEmptyString('   ')).toBe(false);
  });
});
