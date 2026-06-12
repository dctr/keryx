import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateActionItem } from '../../src/schemas/actionItem';

const repoRoot = process.cwd();

const requiredFiles = [
  'AGENTS.md',
  'collectors/README.md',
  'collectors/bash-first-template/keryx-example-scan.sh',
  'collectors/bash-first-template/cron-prompt.md',
  'collectors/bash-first-template/state.example.json',
  'collectors/direct-agent-template/cron-prompt.md',
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
  'collectors/README.md',
  'collectors/bash-first-template/cron-prompt.md',
  'collectors/direct-agent-template/cron-prompt.md',
  'docs/architecture.md',
  'docs/collector-authoring.md',
  'docs/security.md',
  'docs/operations.md',
] as const;

const collectorWorkflowDocs = [
  'collectors/README.md',
  'collectors/bash-first-template/cron-prompt.md',
  'collectors/direct-agent-template/cron-prompt.md',
  'docs/collector-authoring.md',
] as const;

const collectorSkillLoadDocs = [
  ...collectorWorkflowDocs,
  'collectors/bash-first-template/keryx-example-scan.sh',
] as const;

// Docs that walk an author through wiring the bash-first scanner into a Hermes
// cron job. Hermes only runs cron scripts that live directly under
// $HERMES_HOME/scripts/ (absolute paths and ../ traversal are rejected at both
// creation and run time), so these must document copying the adapted scanner
// there and referencing it by bare filename.
const cronScriptPlacementDocs = [
  'collectors/bash-first-template/cron-prompt.md',
  'docs/collector-authoring.md',
] as const;

// Live docs/templates where a cron `Script:` example may legitimately appear.
// docs/archive/** is historical and intentionally excluded.
const cronScriptExampleDocs = activeDocsAndTemplates;

// Files that must warn the operator the bash-first scanner shells out to node.
const nodeOnPathDocs = [
  'collectors/bash-first-template/keryx-example-scan.sh',
  'collectors/README.md',
] as const;

const sourceSpecificSkillDocs = [
  'collectors/README.md',
  'collectors/bash-first-template/cron-prompt.md',
  'collectors/direct-agent-template/cron-prompt.md',
  'docs/collector-authoring.md',
  'docs/operations.md',
] as const;

const workerAttachmentDocs = [
  'README.md',
  'AGENTS.md',
  'collectors/README.md',
  'collectors/bash-first-template/cron-prompt.md',
  'collectors/direct-agent-template/cron-prompt.md',
  'docs/architecture.md',
  'docs/collector-authoring.md',
  'docs/operations.md',
] as const;

describe('collector templates and support docs', () => {
  it('ships every collector template, support document, and deployment example', () => {
    for (const relativePath of requiredFiles) {
      expect(existsSync(join(repoRoot, relativePath)), `${relativePath} should exist`).toBe(true);
    }
  });

  it('marks only the bash scanner template as executable', () => {
    expect(isExecutable('collectors/bash-first-template/keryx-example-scan.sh')).toBe(true);

    for (const relativePath of requiredFiles.filter((path) => path !== 'collectors/bash-first-template/keryx-example-scan.sh')) {
      expect(isExecutable(relativePath), `${relativePath} should not be executable`).toBe(false);
    }
  });

  it('keeps cloneable files free of user-specific IDs and private paths', () => {
    const combinedText = requiredFiles.map(readRequiredFile).join('\n');

    for (const pattern of privatePatternExamples) {
      expect(combinedText, `should not contain private pattern ${pattern}`).not.toContain(pattern);
    }
  });

  it('documents both collector patterns and the required safety contract', () => {
    const bashPrompt = readRequiredFile('collectors/bash-first-template/cron-prompt.md');
    const directPrompt = readRequiredFile('collectors/direct-agent-template/cron-prompt.md');
    const collectorDocs = readRequiredFile('docs/collector-authoring.md');

    for (const text of [bashPrompt, directPrompt, collectorDocs]) {
      expect(text).toContain('keryx.action_item.v1');
      expect(text).toContain('untrusted source content');
      expect(text).toContain('idempotency key');
      expect(text).toContain('cursor safety');
      expect(text).toContain('initial-status blocked');
      expect(text).toContain('keryx-worker');
    }
  });

  it('uses plugin-qualified Keryx skill names wherever collector docs attach skills', () => {
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

  it('uses only schema-valid autonomy values in collector examples', () => {
    const allowed = new Set(['auto', 'minimal', 'research', 'complex']);

    for (const relativePath of collectorWorkflowDocs) {
      const text = readRequiredFile(relativePath);
      const autonomyValues = [...text.matchAll(/"autonomy"\s*:\s*"([^"]+)"/g)].map((match) => match[1]);

      for (const autonomy of autonomyValues) {
        expect(allowed.has(autonomy), `${relativePath} uses invalid autonomy value ${autonomy}`).toBe(true);
      }
    }
  });

  it('keeps documented collector-authoring action-card JSON examples valid against the repository schema', () => {
    const relativePath = 'docs/collector-authoring.md';
    const actionItemExamples = extractJsonCodeBlocks(readRequiredFile(relativePath))
      .map((block) => JSON.parse(block) as unknown)
      .filter((value) => typeof value === 'object' && value !== null && (value as { schema?: unknown }).schema === 'keryx.action_item.v1');

    expect(actionItemExamples, `${relativePath} should include an action-item example`).not.toHaveLength(0);

    for (const example of actionItemExamples) {
      const result = validateActionItem(example);
      const errors = result.ok ? '' : JSON.stringify(result.errors);

      expect(result.ok, `${relativePath} action-item example should validate: ${errors}`).toBe(true);
    }
  });

  it('documents AGENTS.md guidance for the plugin-era workflow', () => {
    const agents = readRequiredFile('AGENTS.md');

    for (const phrase of [
      'hermes-plugin/',
      'hermes keryx doctor',
      './bin/opsctl doctor',
      'plugin is the Hermes-facing adapter',
      'Keryx remains a thin control surface over Hermes Kanban',
      'keryx:keryx-worker',
      'plugin-qualified Keryx skill names',
    ]) {
      expect(agents, `AGENTS.md should mention ${phrase}`).toContain(phrase);
    }
  });

  it('provides a bash-first scanner that reads state and stays quiet when no agent wake is needed', () => {
    const scanner = readRequiredFile('collectors/bash-first-template/keryx-example-scan.sh');
    const state = readRequiredFile('collectors/bash-first-template/state.example.json');

    expect(scanner).toContain('set -euo pipefail');
    expect(scanner).toContain('KERYX_STATE_FILE');
    expect(scanner).toContain('"wakeAgent": false');
    expect(scanner).toContain('"wakeAgent": true');
    expect(scanner).not.toContain('hermes kanban');
    expect(JSON.parse(state)).toMatchObject({ schema: 'keryx.collector_state.v1' });
  });

  it('documents copying the adapted collector script into $HERMES_HOME/scripts and referencing it by bare filename', () => {
    for (const relativePath of cronScriptPlacementDocs) {
      const text = readRequiredFile(relativePath);

      expect(
        text,
        `${relativePath} should document copying the adapted scanner to $HERMES_HOME/scripts/keryx-collector-<source>.sh`,
      ).toContain('$HERMES_HOME/scripts/keryx-collector-<source>.sh');
      expect(
        text,
        `${relativePath} should explain Hermes only runs cron scripts under $HERMES_HOME/scripts`,
      ).toMatch(/\$HERMES_HOME\/scripts/);
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

  it('warns that the bash-first scanner requires node on the cron scheduler PATH', () => {
    for (const relativePath of nodeOnPathDocs) {
      const text = readRequiredFile(relativePath);

      expect(text, `${relativePath} should note node must be on the cron scheduler PATH`).toMatch(
        /node[^\n]*on[^\n]*PATH/i,
      );
    }
  });

  it('covers architecture, security, operations, and deployment boundaries', () => {
    const architecture = readRequiredFile('docs/architecture.md');
    const security = readRequiredFile('docs/security.md');
    const operations = readRequiredFile('docs/operations.md');
    const systemd = readRequiredFile('deploy/systemd/keryx.service.example');
    const caddy = readRequiredFile('deploy/caddy/Caddyfile.example');

    for (const phrase of ['Kanban is the central register', 'blocked', 'ready', 'running', 'done', 'opsctl execute']) {
      expect(architecture).toContain(phrase);
    }

    for (const phrase of ['source content is untrusted', 'no raw event persistence', 'trusted execution decision', 'visible browser']) {
      expect(security).toContain(phrase);
    }

    for (const phrase of ['source status', 'cron jobs', 'Kanban dispatch', 'logs', 'stuck cards']) {
      expect(operations).toContain(phrase);
    }

    for (const phrase of ['$HERMES_HOME/plugins/keryx', 'hermes plugins enable keryx', './keryx-setup.sh']) {
      expect(operations, `operations guide should document ${phrase}`).toContain(phrase);
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
  // Files in scope for the grep-style convention checks: the live skill, collector, and
  // docs trees, plus README.md. docs/archive/** is historical PRD/PLAN written before this
  // convention existed and is intentionally excluded (see parent task t_7269c104 caveats).
  const conventionScanDirs = ['skills', 'collectors', 'docs'] as const;
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

function isExecutable(relativePath: string): boolean {
  return Boolean(statSync(join(repoRoot, relativePath)).mode & 0o111);
}

function extractJsonCodeBlocks(text: string): string[] {
  return [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1]);
}
