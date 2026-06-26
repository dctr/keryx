import { describe, expect, it } from 'vitest';

import {
  extractStringList,
  extractStringScalar,
  extractTopLevelBlock,
  leadingSpaces,
  parseFlowList,
  stripInlineComment,
  unquote,
} from '../../src/opsctl/yamlConfig';

describe('extractTopLevelBlock', () => {
  it('returns indented lines under the key', () => {
    const text = `plugins:\n  enabled:\n  - keryx\n  disabled: []\n`;
    const block = extractTopLevelBlock(text, 'plugins');
    expect(block).toEqual(['  enabled:', '  - keryx', '  disabled: []']);
  });

  it('returns empty array when key not found', () => {
    expect(extractTopLevelBlock('foo: bar\n', 'plugins')).toEqual([]);
  });

  it('stops at the next top-level key', () => {
    const text = `plugins:\n  enabled:\n  - keryx\nkanban:\n  default_assignee: default\n`;
    const block = extractTopLevelBlock(text, 'plugins');
    expect(block).not.toContain('kanban:');
    expect(block).toContain('  enabled:');
  });

  it('handles CRLF line endings', () => {
    const text = 'plugins:\r\n  enabled:\r\n  - keryx\r\n';
    const block = extractTopLevelBlock(text, 'plugins');
    expect(block).toContain('  enabled:');
    expect(block).toContain('  - keryx');
  });
});

describe('extractStringList', () => {
  it('parses block sequence style', () => {
    const block = ['  enabled:', '  - keryx', '  - other'];
    expect(extractStringList(block, 'enabled')).toEqual(['keryx', 'other']);
  });

  it('parses flow list style', () => {
    const block = ['  enabled: [keryx, other]'];
    expect(extractStringList(block, 'enabled')).toEqual(['keryx', 'other']);
  });

  it('returns empty when key not found', () => {
    expect(extractStringList(['  foo: bar'], 'enabled')).toEqual([]);
  });

  it('strips inline comments from block items', () => {
    const block = ['  enabled:', '  - keryx # main plugin', '  - other'];
    expect(extractStringList(block, 'enabled')).toEqual(['keryx', 'other']);
  });

  it('handles quoted values', () => {
    const block = ['  enabled: ["keryx"]'];
    expect(extractStringList(block, 'enabled')).toEqual(['keryx']);
  });
});

describe('extractStringScalar', () => {
  it('extracts a plain string value', () => {
    const block = ['  default_assignee: default'];
    expect(extractStringScalar(block, 'default_assignee')).toBe('default');
  });

  it('returns null for missing key', () => {
    expect(extractStringScalar(['  foo: bar'], 'missing')).toBeNull();
  });

  it('returns null for null literal', () => {
    const block = ['  default_assignee: null'];
    expect(extractStringScalar(block, 'default_assignee')).toBeNull();
  });

  it('returns null for ~ literal', () => {
    const block = ['  default_assignee: ~'];
    expect(extractStringScalar(block, 'default_assignee')).toBeNull();
  });
});

describe('parseFlowList', () => {
  it('splits a flow list', () => {
    expect(parseFlowList('[a, b, c]')).toEqual(['a', 'b', 'c']);
  });

  it('handles an empty flow list', () => {
    expect(parseFlowList('[]')).toEqual([]);
  });
});

describe('stripInlineComment', () => {
  it('strips a trailing comment', () => {
    expect(stripInlineComment('keryx # comment')).toBe('keryx');
  });

  it('returns value unchanged when no comment', () => {
    expect(stripInlineComment('keryx')).toBe('keryx');
  });
});

describe('unquote', () => {
  it('removes double quotes', () => {
    expect(unquote('"keryx"')).toBe('keryx');
  });

  it('removes single quotes', () => {
    expect(unquote("'keryx'")).toBe('keryx');
  });

  it('returns unquoted value unchanged', () => {
    expect(unquote('keryx')).toBe('keryx');
  });
});

describe('leadingSpaces', () => {
  it('counts leading spaces', () => {
    expect(leadingSpaces('  foo')).toBe(2);
    expect(leadingSpaces('foo')).toBe(0);
  });
});
