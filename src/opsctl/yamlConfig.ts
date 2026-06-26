// Hand-rolled YAML-subset reader for Hermes config.yaml files.
// These parsers handle the specific subset of YAML that Hermes emits:
// top-level block mappings, string scalars, block sequences, and flow lists.
// They are intentionally simple and not a general-purpose YAML parser.

// Returns the indented lines belonging to a top-level (column-0) mapping key.
export function extractTopLevelBlock(text: string, key: string): string[] {
  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => new RegExp(`^${key}:\\s*(#.*)?$`).test(line));
  if (headerIndex === -1) {
    return [];
  }

  const block: string[] = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) {
      continue;
    }
    if (leadingSpaces(line) === 0) {
      break;
    }
    block.push(line);
  }
  return block;
}

// Extracts a string list for a key within an already-scoped block, handling both
// flow style (`enabled: [keryx, other]`) and block style (`enabled:` then `- keryx`).
export function extractStringList(block: string[], key: string): string[] {
  const keyIndex = block.findIndex((line) => new RegExp(`^\\s*${key}:\\s*`).test(line));
  if (keyIndex === -1) {
    return [];
  }

  const keyLine = block[keyIndex];
  const keyIndent = leadingSpaces(keyLine);
  const inlineValue = keyLine.replace(new RegExp(`^\\s*${key}:\\s*`), '').trim();

  if (inlineValue.startsWith('[')) {
    return parseFlowList(inlineValue);
  }
  if (inlineValue.length > 0 && !inlineValue.startsWith('#')) {
    return [unquote(inlineValue)].filter((entry) => entry.length > 0);
  }

  const items: string[] = [];
  for (let index = keyIndex + 1; index < block.length; index += 1) {
    const line = block[index];
    if (line.trim().length === 0) {
      continue;
    }
    const match = line.match(/^\s*-\s*(.*)$/);
    if (!match) {
      // A non-list line that is indented deeper than the key cannot belong to a
      // YAML block sequence; anything at or below the key's indent is a sibling.
      break;
    }
    // Block sequence items may sit at the same indentation as their parent key
    // (Hermes' own serialiser does this) or be indented further. Only a dash
    // line shallower than the key escapes the current mapping.
    if (leadingSpaces(line) < keyIndent) {
      break;
    }
    const entry = unquote(stripInlineComment(match[1]).trim());
    if (entry.length > 0) {
      items.push(entry);
    }
  }
  return items;
}

export function extractStringScalar(block: string[], key: string): string | null {
  const keyLine = block.find((line) => new RegExp(`^\\s*${key}:\\s*`).test(line));
  if (!keyLine) {
    return null;
  }
  const value = stripInlineComment(keyLine.replace(new RegExp(`^\\s*${key}:\\s*`), '')).trim();
  if (!value || value === 'null' || value === '~') {
    return null;
  }
  return unquote(value);
}

export function parseFlowList(value: string): string[] {
  const inner = value.slice(value.indexOf('[') + 1, value.lastIndexOf(']'));
  return inner
    .split(',')
    .map((entry) => unquote(entry.trim()))
    .filter((entry) => entry.length > 0);
}

export function stripInlineComment(value: string): string {
  const hashIndex = value.indexOf(' #');
  return hashIndex === -1 ? value : value.slice(0, hashIndex);
}

export function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

export function leadingSpaces(line: string): number {
  return line.length - line.trimStart().length;
}
