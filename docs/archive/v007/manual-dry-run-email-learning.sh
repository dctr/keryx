#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMP_DIR="$(mktemp -d -t keryx-v007-dryrun-XXXXXX)"
FAKE_BIN="$TMP_DIR/fake-bin"
FAKE_HERMES="$FAKE_BIN/hermes"
FAKE_HOME="$TMP_DIR/hermes-home"
POLICY_DIR="$FAKE_HOME/skills/keryx-collector-email/references"
COMMAND_LOG="$TMP_DIR/hermes-commands.log"
PHASE1_TASKS="$TMP_DIR/tasks-phase1.json"
PHASE2_TASKS="$TMP_DIR/tasks-phase2.json"
SHOW1_JSON="$TMP_DIR/show-phase1.json"
SCAN1_JSON="$TMP_DIR/scan-phase1.json"
SHOW2_JSON="$TMP_DIR/show-phase2.json"
SCAN2_JSON="$TMP_DIR/scan-phase2.json"

cleanup() {
  if [[ "${KEEP_TMP:-0}" == "1" ]]; then
    echo "KEEP_TMP=1 set; preserving $TMP_DIR" >&2
    return
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$FAKE_BIN" "$POLICY_DIR"

cat >"$POLICY_DIR/policy.json" <<'JSON'
{
  "schema": "keryx.policy.v1",
  "collector": "keryx-email",
  "version": 1,
  "updated_at": "2026-07-05T00:00:00.000Z",
  "rules": [
    {
      "id": "r-newsletter",
      "class": "email:newsletter-unsubscribe",
      "gate": {
        "max_blast_radius": "self",
        "min_reversibility": "reversible",
        "min_confidence": "trusted"
      },
      "disposition": "silent",
      "result_delivery": "digest",
      "state": "shadow",
      "approved_by": "User",
      "approved_at": "2026-07-05T00:00:00.000Z",
      "source_card_id": null,
      "scope_note": null
    },
    {
      "id": "r-auto-archive",
      "class": "email:auto-archive",
      "gate": {
        "max_blast_radius": "self",
        "min_reversibility": "reversible",
        "min_confidence": "trusted"
      },
      "disposition": "silent",
      "result_delivery": "digest",
      "state": "active",
      "approved_by": "User",
      "approved_at": "2026-07-05T00:00:00.000Z",
      "source_card_id": null,
      "scope_note": null
    }
  ],
  "thresholds": { "spend_requires_approval_always": true },
  "track_record": {}
}
JSON

PHASE1_TASKS="$PHASE1_TASKS" PHASE2_TASKS="$PHASE2_TASKS" node - <<'NODE'
const fs = require('node:fs');

const phase1Path = process.env.PHASE1_TASKS;
const phase2Path = process.env.PHASE2_TASKS;

const collector = 'keryx-email';
const newsletterClass = 'email:newsletter-unsubscribe';
const archiveClass = 'email:auto-archive';

function actionItem({ cls, externalId, idempotencyKey, optionId, label, undoPrompt, executionPrompt, createdAt }) {
  return {
    schema: 'keryx.action_item.v2',
    source: 'email',
    collector,
    class: cls,
    external_id: externalId,
    idempotency_key: idempotencyKey,
    origin_descriptor: 'Manual dry-run fixture',
    title: `Fixture action ${externalId}`,
    summary: 'Fixture only',
    urgency: 'normal',
    proposed_disposition: 'review',
    deadline: null,
    risk: 'Fixture only',
    source_refs: [{ type: 'message', id: externalId }],
    options: [
      {
        id: optionId,
        label,
        requires_input: false,
        input_hint: null,
        delivery: null,
        reversibility: 'reversible',
        blast_radius: 'self',
        undo_prompt: undoPrompt,
        execution_prompt: executionPrompt,
      },
    ],
    ui: { primary_option_id: optionId, display_group: 'Monitored' },
    created_at: createdAt,
  };
}

function approvalTask(index, cls) {
  const newsletter = cls === newsletterClass;
  const externalId = newsletter ? `imap:INBOX:${100 + index}` : `imap:INBOX:${200 + index}`;
  const minute = newsletter ? '00' : '10';
  const approvedMinute = newsletter ? '01' : '11';
  const createdAt = `2026-07-05T01:${minute}:${String(index).padStart(2, '0')}.000Z`;
  const approvedAt = `2026-07-05T01:${approvedMinute}:${String(index).padStart(2, '0')}.000Z`;
  const optionId = newsletter ? 'unsubscribe_newsletter' : 'auto_archive';
  const label = newsletter ? 'Unsubscribe newsletter' : 'Auto archive message';
  const undoPrompt = newsletter ? 'Resubscribe to newsletter.' : 'Restore from archive.';
  const executionPrompt = newsletter ? 'Unsubscribe now.' : 'Archive now.';
  return {
    id: `${newsletter ? 't_newsletter' : 't_archive'}_approval_${String(index).padStart(2, '0')}`,
    status: 'done',
    created_at: createdAt,
    body: JSON.stringify(
      actionItem({
        cls,
        externalId,
        idempotencyKey: `keryx:email:${externalId}`,
        optionId,
        label,
        undoPrompt,
        executionPrompt,
        createdAt,
      }),
    ),
    comments: [
      {
        created_at: approvedAt,
        body: JSON.stringify({
          schema: 'keryx.execution_decision.v1',
          selected_option_id: optionId,
          user_feedback: null,
          approved_by: 'User',
          approved_via: 'keryx-web',
          approved_at: approvedAt,
        }),
      },
    ],
  };
}

const newsletterApprovals = Array.from({ length: 10 }, (_, i) => approvalTask(i + 1, newsletterClass));
const archiveApprovals = Array.from({ length: 10 }, (_, i) => approvalTask(i + 1, archiveClass));

const dismissal = {
  id: 't_dismissal_reset',
  status: 'done',
  created_at: '2026-07-05T02:00:00.000Z',
  body: JSON.stringify(
    actionItem({
      cls: newsletterClass,
      externalId: 'imap:INBOX:111',
      idempotencyKey: 'keryx:email:imap:INBOX:111',
      optionId: 'unsubscribe_newsletter',
      label: 'Unsubscribe newsletter',
      undoPrompt: 'Resubscribe to newsletter.',
      executionPrompt: 'Unsubscribe now.',
      createdAt: '2026-07-05T02:00:00.000Z',
    }),
  ),
  comments: [
    {
      created_at: '2026-07-05T02:01:00.000Z',
      body: JSON.stringify({
        schema: 'keryx.dismissal_decision.v1',
        dismissal_scope: 'exact_item',
        reason: 'wrong target',
        dismissed_external_id: 'imap:INBOX:111',
        dismissed_idempotency_key: 'keryx:email:imap:INBOX:111',
        dismissed_by: 'User',
        dismissed_via: 'keryx-web',
        dismissed_at: '2026-07-05T02:01:00.000Z',
      }),
    },
  ],
};

const regret = {
  id: 't_silent_regret',
  status: 'done',
  created_at: '2026-07-05T02:30:00.000Z',
  body: JSON.stringify(
    actionItem({
      cls: archiveClass,
      externalId: 'imap:INBOX:200',
      idempotencyKey: 'keryx:email:imap:INBOX:200',
      optionId: 'auto_archive',
      label: 'Auto archive message',
      undoPrompt: 'Restore from archive.',
      executionPrompt: 'Archive now.',
      createdAt: '2026-07-05T02:30:00.000Z',
    }),
  ),
  comments: [
    {
      created_at: '2026-07-05T02:31:00.000Z',
      body: JSON.stringify({
        schema: 'keryx.regret.v1',
        kind: 'should_have_asked',
        note: 'Silent archive should have asked.',
        recorded_by: 'User',
        recorded_at: '2026-07-05T02:31:00.000Z',
      }),
    },
  ],
};

fs.writeFileSync(phase1Path, JSON.stringify([...newsletterApprovals, ...archiveApprovals]), 'utf8');
fs.writeFileSync(phase2Path, JSON.stringify([...newsletterApprovals, ...archiveApprovals, dismissal, regret]), 'utf8');
NODE

cat >"$FAKE_HERMES" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "${FAKE_HERMES_LOG:?}"

if [[ "${1:-}" != "kanban" || "${2:-}" != "--board" || "${3:-}" != "keryx" ]]; then
  echo "fake hermes only supports: kanban --board keryx ..." >&2
  exit 1
fi

command="${4:-}"
shift 4

case "$command" in
  list)
    node - <<'NODE'
const fs = require('node:fs');
const tasks = JSON.parse(fs.readFileSync(process.env.FAKE_TASKS_JSON, 'utf8'));
const stripped = tasks.map(({ comments, ...rest }) => rest);
process.stdout.write(JSON.stringify(stripped));
NODE
    ;;
  show)
    task_id="${1:-}"
    node - <<'NODE' "$task_id"
const fs = require('node:fs');
const taskId = process.argv[2];
const tasks = JSON.parse(fs.readFileSync(process.env.FAKE_TASKS_JSON, 'utf8'));
const task = tasks.find((candidate) => candidate.id === taskId);
if (!task) {
  process.stderr.write(`No fake task ${taskId}\n`);
  process.exit(1);
}
const { comments = [], ...taskOnly } = task;
process.stdout.write(JSON.stringify({ task: taskOnly, comments }));
NODE
    ;;
  create)
    echo '{"id":"t_fake_created","status":"blocked"}'
    ;;
  block|assign|comment|promote|archive|complete)
    echo '{}'
    ;;
  *)
    echo "unsupported fake command: $command" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$FAKE_HERMES"

run_phase() {
  local tasks_file="$1"
  local show_out="$2"
  local scan_out="$3"

  PATH="$FAKE_BIN:$PATH" \
  HERMES_HOME="$FAKE_HOME" \
  FAKE_TASKS_JSON="$tasks_file" \
  FAKE_HERMES_LOG="$COMMAND_LOG" \
  "$REPO_ROOT/bin/opsctl" policy show keryx-email --json > "$show_out"

  PATH="$FAKE_BIN:$PATH" \
  HERMES_HOME="$FAKE_HOME" \
  FAKE_TASKS_JSON="$tasks_file" \
  FAKE_HERMES_LOG="$COMMAND_LOG" \
  "$REPO_ROOT/bin/opsctl" policy scan keryx-email --preview --json > "$scan_out"
}

run_phase "$PHASE1_TASKS" "$SHOW1_JSON" "$SCAN1_JSON"
run_phase "$PHASE2_TASKS" "$SHOW2_JSON" "$SCAN2_JSON"

SHOW1_JSON="$SHOW1_JSON" \
SCAN1_JSON="$SCAN1_JSON" \
SHOW2_JSON="$SHOW2_JSON" \
SCAN2_JSON="$SCAN2_JSON" \
COMMAND_LOG="$COMMAND_LOG" \
node - <<'NODE'
const fs = require('node:fs');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const show1 = JSON.parse(fs.readFileSync(process.env.SHOW1_JSON, 'utf8'));
const scan1 = JSON.parse(fs.readFileSync(process.env.SCAN1_JSON, 'utf8'));
const show2 = JSON.parse(fs.readFileSync(process.env.SHOW2_JSON, 'utf8'));
const scan2 = JSON.parse(fs.readFileSync(process.env.SCAN2_JSON, 'utf8'));

const classNewsletter = 'email:newsletter-unsubscribe';
const classArchive = 'email:auto-archive';

assert(show1.track_record[classNewsletter].band === 'trusted', 'phase 1: newsletter band should be trusted');
assert(show1.track_record[classNewsletter].approved_since_reset === 10, 'phase 1: newsletter approvals should be 10');
assert(show1.track_record[classArchive].band === 'trusted', 'phase 1: auto-archive band should be trusted');
assert(
  scan1.proposals.some((proposal) => proposal.kind === 'promote' && proposal.class === classNewsletter && proposal.targetState === 'active'),
  'phase 1: expected promotion proposal for newsletter class',
);
assert(
  !scan1.proposals.some((proposal) => proposal.kind === 'demote' && proposal.class === classArchive),
  'phase 1: did not expect auto-archive demotion before regret reset',
);

assert(show2.track_record[classNewsletter].band === 'cold', 'phase 2: newsletter should reset to cold after dismissal');
assert(show2.track_record[classNewsletter].latest_reset?.kind === 'dismissal', 'phase 2: latest newsletter reset should be dismissal');
assert(show2.track_record[classArchive].band === 'cold', 'phase 2: auto-archive should reset to cold after regret');
assert(show2.track_record[classArchive].latest_reset?.kind === 'regret', 'phase 2: latest auto-archive reset should be regret');

assert(
  scan2.proposals.some((proposal) => proposal.kind === 'demote' && proposal.class === classArchive && proposal.targetState === 'revoked'),
  'phase 2: expected demotion/revocation proposal for active auto-archive rule',
);
assert(
  !scan2.proposals.some((proposal) => proposal.kind === 'promote' && proposal.class === classNewsletter),
  'phase 2: newsletter should not have promote proposal after reset',
);

const commandLog = fs.readFileSync(process.env.COMMAND_LOG, 'utf8').trim().split(/\n+/).filter(Boolean);
assert(commandLog.length > 0, 'expected fake hermes commands to be logged');
assert(commandLog.every((entry) => entry.startsWith('kanban ')), 'expected only kanban commands in dry-run');

console.log('Manual dry-run checks passed.');
console.log(
  `phase1 newsletter band=${show1.track_record[classNewsletter].band}; auto-archive band=${show1.track_record[classArchive].band}; proposals=${scan1.proposals.length}`,
);
console.log(`phase2 newsletter band=${show2.track_record[classNewsletter].band}; auto-archive band=${show2.track_record[classArchive].band}; proposals=${scan2.proposals.length}`);
NODE

echo "Dry-run complete. Temporary HERMES_HOME: $FAKE_HOME"
echo "No real Hermes board, cron, send, or email endpoints were touched."
