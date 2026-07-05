import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateActionItem } from '../../src/schemas/actionItem';

const repoRoot = process.cwd();

// v005 deleted the committed collectors/ folder: source-specific collectors are now
// authored into Hermes' own space via /keryx-collector-creator, never committed here.
// The required files are therefore only the support docs and deployment examples.
const requiredFiles = [
  'AGENTS.md',
  'docs/architecture.md',
  'docs/collector-authoring.md',
  'docs/security.md',
  'docs/operations.md',
  'deploy/systemd/keryx.service.example',
  'deploy/caddy/Caddyfile.example',
] as const;

const privatePatternExamples = [
  '/home/example-user',
  '/mnt/private-storage',
  'private.example',
  'telegram:',
  'discord:',
] as const;

const activeDocsAndTemplates = [
  'README.md',
  'AGENTS.md',
  'docs/architecture.md',
  'docs/collector-authoring.md',
  'docs/security.md',
  'docs/operations.md',
] as const;

// Live docs that walk an author through the canonical card-creation loop.
const collectorWorkflowDocs = [
  'README.md',
  'docs/collector-authoring.md',
  'docs/operations.md',
] as const;

const sourceSpecificSkillDocs = [
  'README.md',
  'docs/collector-authoring.md',
  'docs/operations.md',
] as const;

const collectorCreatorCommandDocs = [
  'README.md',
  'docs/collector-authoring.md',
  'docs/operations.md',
] as const;

const slashCommandDocs = [
  ...activeDocsAndTemplates,
  'skills/keryx/DESCRIPTION.md',
  'skills/keryx/keryx-collector-creator/SKILL.md',
  'skills/keryx/keryx-worker/SKILL.md',
  'skills/keryx/keryx-collector/SKILL.md',
] as const;

// Live docs that document attaching the plugin-qualified worker skill to cards.
const workerAttachmentDocs = [
  'README.md',
  'AGENTS.md',
  'docs/architecture.md',
  'docs/collector-authoring.md',
  'docs/operations.md',
] as const;

// Live docs that document loading the generic plugin-qualified collector skill.
const collectorSkillLoadDocs = [
  'README.md',
  'docs/architecture.md',
  'docs/collector-authoring.md',
  'docs/operations.md',
] as const;

// Live docs/templates where a cron `Script:` example may legitimately appear.
// docs/archive/** is historical and intentionally excluded.
const cronScriptExampleDocs = activeDocsAndTemplates;

describe('support docs and deployment examples', () => {
  it('ships every support document and deployment example', () => {
    for (const relativePath of requiredFiles) {
      expect(existsSync(join(repoRoot, relativePath)), `${relativePath} should exist`).toBe(true);
    }
  });

  it('no longer ships a committed collectors/ folder', () => {
    expect(
      existsSync(join(repoRoot, 'collectors')),
      'collectors/ must not be committed; collectors are authored into Hermes space via /keryx-collector-creator',
    ).toBe(false);
  });

  it('keeps cloneable files free of user-specific IDs and private paths', () => {
    const combinedText = requiredFiles.map(readRequiredFile).join('\n');

    for (const pattern of privatePatternExamples) {
      expect(combinedText, `should not contain private pattern ${pattern}`).not.toContain(pattern);
    }
  });

  it('uses plugin-qualified Keryx skill names wherever docs attach skills', () => {
    for (const relativePath of workerAttachmentDocs) {
      const text = readRequiredFile(relativePath);

      expect(text, `${relativePath} should mention the plugin-qualified worker skill`).toContain('keryx:keryx-worker');
      expect(text, `${relativePath} should not document bare worker skill attachment`).not.toMatch(/attach(?:es|ing)? (?:the )?`keryx-worker` skill/i);
    }

    for (const relativePath of collectorSkillLoadDocs) {
      const text = readRequiredFile(relativePath);

      expect(text, `${relativePath} should mention the plugin-qualified collector skill`).toContain('keryx:keryx-collector');
      // The generic collector skill must stay plugin-qualified. Created/source-specific
      // skills are intentionally UNQUALIFIED (keryx-collector-<source>), so forbid only a
      // bare *generic* reference: keryx-collector not prefixed by `keryx:` and not part of
      // a longer keryx-collector-<...> name.
      expect(text, `${relativePath} should not document a bare generic collector skill load`).not.toMatch(
        /(?<![:\w-])keryx-collector(?![\w-])/,
      );
    }
  });

  it('references created source-specific collector skills by unqualified name', () => {
    for (const relativePath of sourceSpecificSkillDocs) {
      const text = readRequiredFile(relativePath);

      expect(text, `${relativePath} should reference the created collector skill unqualified`).toContain(
        'keryx-collector-<source>',
      );
      expect(text, `${relativePath} should not qualify a created collector skill with keryx:`).not.toContain(
        'keryx:keryx-collector-<source>',
      );
    }
  });

  it('documents the user-facing collector creator slash command without plugin-qualified slash-command forms', () => {
    for (const relativePath of collectorCreatorCommandDocs) {
      const text = readRequiredFile(relativePath);

      expect(text, `${relativePath} should document the collector creator slash command`).toContain(
        '/keryx-collector-creator',
      );
    }

    const offenders: string[] = [];

    for (const relativePath of slashCommandDocs) {
      const text = readRequiredFile(relativePath);
      text.split('\n').forEach((line, index) => {
        if (/\/keryx(?::|\*)/.test(line)) {
          offenders.push(`${relativePath}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(
      offenders,
      `Keryx plugin skills are not slash commands; document /keryx-collector-creator instead:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('never instructs attaching unqualified generic Keryx runtime skills to cards or cron jobs', () => {
    const offenders: string[] = [];

    for (const relativePath of slashCommandDocs) {
      const text = readRequiredFile(relativePath);
      text.split('\n').forEach((line, index) => {
        const talksAboutAttachment = /\b(attach|attached|attaches|attaching|load|loaded|loads|loading|skill|skills)\b/i.test(line);
        if (!talksAboutAttachment) {
          return;
        }
        if (hasBareGenericRuntimeSkill(line)) {
          offenders.push(`${relativePath}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(
      offenders,
      `Generic runtime skills must be attached plugin-qualified; created keryx-collector-<source> skills remain unqualified:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('documents the canonical template, schema, validate, and create-card collector workflow', () => {
    for (const relativePath of collectorWorkflowDocs) {
      const text = readRequiredFile(relativePath);

      for (const command of [
        'hermes keryx template-card --source <source> --collector <collector>',
        'hermes keryx schema action-item',
        'hermes keryx validate-card',
        'hermes keryx create-card',
      ]) {
        expect(text, `${relativePath} should document ${command}`).toContain(command);
      }
    }
  });

  it('does not document raw Kanban create as a collector default path', () => {
    for (const relativePath of activeDocsAndTemplates) {
      const text = readRequiredFile(relativePath);

      expect(text, `${relativePath} should route card creation through hermes keryx create-card`).not.toMatch(/hermes\s+kanban(?:\s+--board\s+\S+)?\s+create/);
    }
  });

  it('uses only schema-valid risk-axis enums in collector-authoring option examples', () => {
    const allowedReversibility = new Set(['read_only', 'reversible', 'compensable', 'irreversible']);
    const allowedBlastRadius = new Set(['self', 'external']);

    for (const relativePath of collectorWorkflowDocs) {
      const text = readRequiredFile(relativePath);

      const reversibilityValues = [...text.matchAll(/"reversibility"\s*:\s*"([^"]+)"/g)].map((match) => match[1]);
      for (const value of reversibilityValues) {
        expect(allowedReversibility.has(value), `${relativePath} uses invalid reversibility value ${value}`).toBe(true);
      }

      const blastRadiusValues = [...text.matchAll(/"blast_radius"\s*:\s*"([^"]+)"/g)].map((match) => match[1]);
      for (const value of blastRadiusValues) {
        expect(allowedBlastRadius.has(value), `${relativePath} uses invalid blast_radius value ${value}`).toBe(true);
      }
    }
  });

  it('keeps documented collector-authoring action-card JSON examples valid against the v2 repository schema', () => {
    const relativePath = 'docs/collector-authoring.md';
    const actionItemExamples = extractJsonCodeBlocks(readRequiredFile(relativePath))
      .map((block) => JSON.parse(block) as unknown)
      .filter((value) => typeof value === 'object' && value !== null && (value as { schema?: unknown }).schema === 'keryx.action_item.v2');

    expect(actionItemExamples, `${relativePath} should include a v2 action-item example`).not.toHaveLength(0);

    for (const example of actionItemExamples) {
      const result = validateActionItem(example);
      const errors = result.ok ? '' : JSON.stringify(result.errors);

      expect(result.ok, `${relativePath} action-item example should validate: ${errors}`).toBe(true);
    }
  });

  it('documents the v005 collector-authoring safety contract', () => {
    const collectorDocs = readRequiredFile('docs/collector-authoring.md');

    for (const phrase of [
      'keryx.action_item.v2',
      'untrusted source content',
      'idempotency key',
      'cursor safety',
      'read_only',
      'blast_radius',
      'keryx:keryx-worker',
      'keryx-collector-<source>',
    ]) {
      expect(collectorDocs, `collector-authoring should mention ${phrase}`).toContain(phrase);
    }
  });

  it('documents the email collector generated artifact contract in collector authoring docs', () => {
    const collectorDocs = readRequiredFile('docs/collector-authoring.md');

    for (const phrase of [
      'keryx-collector-email',
      '$HERMES_HOME/skills/keryx-collector-email/SKILL.md',
      'fixture harness',
      'fake email facts only',
      'source cursor state',
      'exact-dismiss state',
      'keryx:email:<immutable-message-id>',
      'references/policy.json',
      'state-changing rules in `state: shadow`',
      'correction comments inform future classification but are never direct execution authority',
      'rejected, dismissed, or regretted classes restart confidence at `cold`',
      'Persist no raw email content',
    ]) {
      expect(collectorDocs, `collector-authoring should mention ${phrase}`).toContain(phrase);
    }
  });

  it('documents AGENTS.md guidance for the plugin-era workflow', () => {
    const agents = readRequiredFile('AGENTS.md');

    for (const phrase of [
      'hermes-plugin/',
      'hermes keryx doctor',
      './bin/opsctl doctor',
      'hermes keryx policy scan <collector> --preview',
      'hermes keryx policy apply <task_id>',
      'hermes keryx schema correction',
      'hermes keryx validate-correction <file>',
      'do not hand-edit `references/policy.json`',
      'cold-reset invariant',
      'plugin is the Hermes-facing adapter',
      'Keryx remains a thin control surface over Hermes Kanban',
      'keryx:keryx-worker',
      'plugin-qualified Keryx skill names',
    ]) {
      expect(agents, `AGENTS.md should mention ${phrase}`).toContain(phrase);
    }
  });

  it('only uses bare-filename cron Script: examples in live docs (repo-relative paths are rejected by Hermes)', () => {
    const offenders: string[] = [];

    for (const relativePath of cronScriptExampleDocs) {
      const text = readRequiredFile(relativePath);
      text.split('\n').forEach((line, index) => {
        const match = line.match(/^\s*Script:\s*(\S+)/);
        if (!match) {
          return;
        }
        const value = match[1];
        // A valid cron Script: value is a bare filename resolved under
        // $HERMES_HOME/scripts/. Slashes (repo-relative or absolute paths) and
        // ../ traversal are refused by Hermes at cron creation and run time.
        if (value.includes('/') || value.startsWith('..')) {
          offenders.push(`${relativePath}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(
      offenders,
      `cron Script: examples must be bare filenames under $HERMES_HOME/scripts, not repo-relative paths:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('documents deterministic policy commands for worker/collector skills instead of manual policy edits', () => {
    const workerSkill = readRequiredFile('skills/keryx/keryx-worker/SKILL.md');
    const collectorCreatorSkill = readRequiredFile('skills/keryx/keryx-collector-creator/SKILL.md');
    const collectorAuthoring = readRequiredFile('docs/collector-authoring.md');
    const operations = readRequiredFile('docs/operations.md');

    expect(workerSkill).toContain('hermes keryx policy apply <task_id>');
    expect(workerSkill).toContain('hermes keryx policy scan <collector> --preview');
    expect(workerSkill).toContain('hermes keryx policy scan <collector>');
    expect(workerSkill).toContain('do not hand-edit `references/policy.json`');

    expect(collectorCreatorSkill).toContain('hermes keryx policy apply <task_id>');
    expect(collectorCreatorSkill).toContain('hermes keryx policy scan <collector> --preview');
    expect(collectorCreatorSkill).toContain('hermes keryx policy scan <collector>');
    expect(collectorCreatorSkill).toContain('do not rely on manual policy-file edits');

    // Optional scheduled scan guidance keeps policy proposal generation running
    // even when workers are short-lived, and should explicitly mention cold resets.
    expect(operations).toContain('keryx-policy-scan-<source>');
    expect(operations).toContain('Run `hermes keryx policy scan keryx-<source>`; report only errors.');
    expect(operations).toContain('cold-reset');

    expect(collectorAuthoring).toContain('keryx-policy-scan-<source>');
    expect(collectorAuthoring).toContain('Run `hermes keryx policy scan keryx-<source>`; report only errors.');
    expect(collectorAuthoring).toContain('cold-reset');

    expect(collectorCreatorSkill).toContain('keryx-policy-scan-$NAME');
    expect(collectorCreatorSkill).toContain('Run `hermes keryx policy scan keryx-$NAME`; report only errors.');
    expect(collectorCreatorSkill).toContain('cold-reset');
  });

  it('documents the v007 policy learning workflow across architecture/security/operations/collector docs', () => {
    const architecture = readRequiredFile('docs/architecture.md');
    const security = readRequiredFile('docs/security.md');
    const operations = readRequiredFile('docs/operations.md');
    const collectorAuthoring = readRequiredFile('docs/collector-authoring.md');

    expect(architecture).toContain('hermes keryx policy scan <collector> [--preview]');
    expect(architecture).toContain('hermes keryx policy apply <task_id>');
    expect(architecture).toContain('no manual policy-file edits');
    expect(operations).toContain('hermes keryx policy apply <task_id>');
    expect(operations).toContain('do not hand-edit `references/policy.json`');
    expect(collectorAuthoring).toContain('hermes keryx policy apply <task_id>');

    for (const text of [architecture, security, operations, collectorAuthoring]) {
      expect(text).toContain('hermes keryx schema correction');
      expect(text).toContain('hermes keryx validate-correction <file>');
    }

    expect(architecture).toContain('exact `(collector, class)` scope');
    expect(architecture).toContain('resets confidence to `cold`');
    expect(security).toContain('exact `(collector, class)` scope');
    expect(security).toContain('cold-reset epochs');

    expect(architecture).toContain('review log');
    expect(architecture).toContain('digest');
    expect(operations).toContain('mark-reviewed <task_id>');
    expect(operations).toContain('digest --preview');

    expect(collectorAuthoring).toContain('generated artifacts should satisfy this contract in Hermes space');
    expect(collectorAuthoring).toContain('$HERMES_HOME/skills/keryx-collector-email/SKILL.md');
  });

  it('covers architecture, security, operations, and deployment boundaries', () => {
    const architecture = readRequiredFile('docs/architecture.md');
    const security = readRequiredFile('docs/security.md');
    const operations = readRequiredFile('docs/operations.md');
    const systemd = readRequiredFile('deploy/systemd/keryx.service.example');
    const caddy = readRequiredFile('deploy/caddy/Caddyfile.example');

    for (const phrase of ['Kanban is the central register', 'blocked', 'ready', 'running', 'done', 'review log', 'silent', 'interrupt', 'disposition']) {
      expect(architecture, `architecture guide should mention ${phrase}`).toContain(phrase);
    }

    for (const phrase of ['source content is untrusted', 'no raw event persistence', 'trusted execution decision', 'visible browser', 'absolute floor', 'read_only', 'policy is the trust gate']) {
      expect(security, `security guide should mention ${phrase}`).toContain(phrase);
    }

    for (const phrase of ['source status', 'cron jobs', 'Kanban dispatch', 'logs', 'stuck cards', '$HERMES_HOME/plugins/keryx', 'hermes plugins enable keryx', './keryx-setup.sh', 'keryx-digest']) {
      expect(operations, `operations guide should mention ${phrase}`).toContain(phrase);
    }

    expect(systemd).toContain('npm start');
    expect(systemd).toContain('127.0.0.1');
    expect(systemd).toContain('/opt/keryx');
    expect(caddy).toContain('reverse_proxy 127.0.0.1:4173');
    expect(caddy).toContain('basicauth');
    expect(caddy).toContain('Do not expose Keryx without external authentication');
  });
});

describe('created collector skills target Hermes space, not the repo', () => {
  // Files in scope for the grep-style convention checks: the live skill and docs trees,
  // plus README.md. The committed collectors/ folder no longer exists. docs/archive/** is
  // historical PRD/PLAN written before this convention existed and is intentionally excluded.
  const conventionScanDirs = ['skills', 'docs'] as const;
  const conventionScanFiles = ['README.md'] as const;
  const excludedDir = join(repoRoot, 'docs', 'archive');

  // A created, source-specific collector skill lives in Hermes' own skill index and is
  // therefore referenced UNQUALIFIED (keryx-collector-<source>). Only the three repo-shipped
  // plugin skills carry the `keryx:` prefix: keryx:keryx-worker, keryx:keryx-collector, and
  // keryx:keryx-collector-creator. So any `keryx:keryx-collector-<suffix>` other than the
  // shipped `-creator` is a convention violation that would regress section 2.1.
  const forbiddenQualifiedCreatedSkill = /keryx:keryx-collector-(?!creator\b)/;
  const shippedQualifiedSkills = ['keryx:keryx-worker', 'keryx:keryx-collector', 'keryx:keryx-collector-creator'] as const;

  it('directs the collector-creator to write created skills into $HERMES_HOME/skills, not the repo tree', () => {
    const creator = readFileSync(join(repoRoot, 'skills', 'keryx', 'keryx-collector-creator', 'SKILL.md'), 'utf8');

    // Positive: created skills live in Hermes' space.
    expect(creator).toContain('$HERMES_HOME/skills/keryx-collector-$NAME/SKILL.md');
    expect(creator).toContain('Never generate this skill into the Keryx repository');

    // Negative: the creator must never tell the author to drop a created skill into the
    // repository's static skills/keryx/ plugin tree, where it could never resolve.
    expect(creator).not.toMatch(/skills\/keryx\/keryx-collector/);
  });

  it('never instructs creating keryx:-qualified references for non-shipped collector skills', () => {
    const offenders: string[] = [];

    for (const absolutePath of collectConventionScanFiles()) {
      const text = readFileSync(absolutePath, 'utf8');
      text.split('\n').forEach((line, index) => {
        if (forbiddenQualifiedCreatedSkill.test(line)) {
          offenders.push(`${relative(repoRoot, absolutePath)}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(
      offenders,
      `created collector skills must be referenced unqualified (keryx-collector-<source>), not keryx:-prefixed:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('keeps the three shipped plugin skills referenced with the keryx: prefix in the live tree', () => {
    const corpus = collectConventionScanFiles()
      .map((absolutePath) => readFileSync(absolutePath, 'utf8'))
      .join('\n');

    for (const shippedSkill of shippedQualifiedSkills) {
      expect(corpus, `shipped skill ${shippedSkill} should remain plugin-qualified in the live tree`).toContain(shippedSkill);
    }
  });

  function collectConventionScanFiles(): string[] {
    const files: string[] = [];

    const walk = (absoluteDir: string): void => {
      if (resolve(absoluteDir) === resolve(excludedDir)) {
        return;
      }

      for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
        const childPath = join(absoluteDir, entry.name);
        if (entry.isDirectory()) {
          walk(childPath);
        } else if (entry.isFile()) {
          files.push(childPath);
        }
      }
    };

    for (const dir of conventionScanDirs) {
      walk(join(repoRoot, dir));
    }
    for (const file of conventionScanFiles) {
      files.push(join(repoRoot, file));
    }

    return files;
  }
});

function readRequiredFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

function extractJsonCodeBlocks(text: string): string[] {
  return [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1]);
}

function hasBareGenericRuntimeSkill(line: string): boolean {
  const withoutQualifiedNames = line.replaceAll('keryx:keryx-worker', '').replaceAll('keryx:keryx-collector', '');

  return /(?<![:\w-])keryx-worker(?![\w-])/.test(withoutQualifiedNames)
    || /(?<![:\w-])keryx-collector(?![\w-])/.test(withoutQualifiedNames);
}
