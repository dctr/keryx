#!/usr/bin/env bash
set -euo pipefail

# Bash-first Keryx collector scanner template.
#
# Inputs:
#   KERYX_STATE_FILE  JSON collector state file. Defaults to ./state.example.json.
#   KERYX_SOURCE_FILE JSONL fixture/source file for this template. Each line should be
#                     a compact object with cursor, external_id, title, summary, and url.
#
# Output:
#   {"wakeAgent": false, ...} when no agent pass is required.
#   {"wakeAgent": true, "candidates": [...]} when candidates need classification.
#
# The script intentionally does not call Hermes. A cron job can use this as a
# pre-run script and pass its compact stdout to an agent using the keryx-collector skill.

json_quote() {
  node --input-type=module - "$1" <<'NODE'
console.log(JSON.stringify(process.argv[2] ?? ''));
NODE
}

state_file="${KERYX_STATE_FILE:-${1:-./state.example.json}}"
source_file="${KERYX_SOURCE_FILE:-${2:-}}"

if [[ ! -f "$state_file" ]]; then
  printf '{"wakeAgent": false, "reason": "state file not found", "stateFile": %s}\n' "$(json_quote "$state_file")"
  exit 0
fi

if [[ -z "$source_file" || ! -f "$source_file" ]]; then
  printf '{"wakeAgent": false, "reason": "no source file configured"}\n'
  exit 0
fi

node --input-type=module - "$state_file" "$source_file" <<'NODE'
import { readFileSync } from 'node:fs';

const [, , statePath, sourcePath] = process.argv;
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const committedCursor = String(state.committed_cursor ?? '');
const dismissed = new Set(state.exact_dismissed_external_ids ?? []);

const candidates = readFileSync(sourcePath, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      return {
        cursor: `malformed-${index + 1}`,
        external_id: `malformed-${index + 1}`,
        title: 'Malformed source event',
        summary: 'The source line was not valid JSON and needs source-specific handling.',
        parse_error: error instanceof Error ? error.message : String(error),
      };
    }
  })
  .filter((event) => String(event.cursor ?? '') > committedCursor)
  .filter((event) => !dismissed.has(String(event.external_id ?? event.cursor ?? '')))
  .slice(0, 20)
  .map((event) => ({
    cursor: String(event.cursor ?? ''),
    external_id: String(event.external_id ?? event.cursor ?? ''),
    title: String(event.title ?? 'Untitled source event'),
    summary: String(event.summary ?? 'No summary supplied.'),
    url: event.url ? String(event.url) : null,
    observed_at: event.observed_at ? String(event.observed_at) : null,
  }));

if (candidates.length === 0) {
  console.log(JSON.stringify({ wakeAgent: false, committedCursor }));
} else {
  console.log(JSON.stringify({
    wakeAgent: true,
    collector: 'example-bash-first',
    committedCursor,
    candidates,
  }));
}
NODE
